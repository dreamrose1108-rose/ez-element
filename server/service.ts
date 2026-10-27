import { createHash } from 'node:crypto';
import { Booking, Command, Ledger, Package, Role, Rules, Session, Store, Tx, User, commandSchema, dayKey, overlaps, requireThat } from './model';

export const key = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
export const userKey = (openid: string) => key('wechat', openid);
export const defaultRules: Rules = { id: 'store', bookingDays: 14, privateCancelHours: 12, groupCancelHours: 2, cutoffMinutes: 60 };
const hasRole = (u: User, role: Role) => u.roles.includes(role);
const role = (u: User, r: Role) => requireThat(hasRole(u, r), 'FORBIDDEN', '没有操作权限');
async function user(tx: Tx, id: string): Promise<User> {
  const u = await tx.get('users', id);
  requireThat(u && u.status === 'active', 'INACTIVE', '请先提交资料并等待门店审核');
  return u;
}
async function schedule(tx: Tx, owner: string, s: Session, ref: string, add: boolean) {
  const id = key(owner, dayKey(s.start));
  const lock = await tx.get('scheduleLocks', id) || { id, entries: [] };
  lock.entries = lock.entries.filter(e => e.ref !== ref);
  if (add) {
    requireThat(!lock.entries.some(e => overlaps(e, s)), 'CONFLICT', '该时间已有课程，请选择其他时段');
    lock.entries.push({ ref, start: s.start, end: s.end });
  }
  await tx.put('scheduleLocks', lock);
}
async function ledger(tx: Tx, p: Package, actorId: string, type: Ledger['type'], reference: string, now: number, available: number, frozen: number, consumed: number) {
  p.available += available; p.frozen += frozen; p.consumed += consumed;
  requireThat(p.available >= 0 && p.frozen >= 0 && p.consumed >= 0 && p.available + p.frozen + p.consumed === p.total, 'BALANCE', '课时余额校验失败');
  await tx.put('memberPackages', p);
  await tx.put('creditLedger', { id: key(reference, type), packageId: p.id, memberId: p.memberId, actorId, type, reference, delta: { available, frozen, consumed }, at: now });
}
async function notify(tx: Tx, booking: Booking, s: Session, title: string, now: number) {
  for (const userId of [...new Set([booking.memberId, s.coachId])]) {
    await tx.put('inbox', { id: key(booking.id, title, userId), userId, title: `${title} · ${s.title}`, bookingId: booking.id, at: now });
  }
}

export class GymService {
  constructor(private store: Store, private clock = Date.now) {}
  async execute(openid: string, raw: unknown) {
    requireThat(openid, 'UNAUTHENTICATED', '请从微信小程序访问');
    const command = commandSchema.parse(raw);
    const actorId = userKey(openid);
    if (command.action === 'dashboard') return this.dashboard(actorId);
    // Fetch candidates outside the transaction, then revalidate the complete
    // active roster against the session counter inside it before releasing credit.
    let cancellationIds: string[] = [];
    if (command.action === 'cancelSession') {
      await this.store.transaction(async tx => role(await user(tx, actorId), 'admin'));
      cancellationIds = (await this.store.list('bookings', { sessionId: command.sessionId, status: 'confirmed' }, 100)).map(b => b.id);
    }
    return this.store.transaction(async tx => {
      const now = this.clock();
      if (command.action === 'register') {
        const existing = await tx.get('users', actorId);
        // Never overwrite roles/status through a profile payload or phone matching.
        if (existing) return { id: existing.id };
        await tx.put('users', { id: actorId, name: command.name, phone: command.phone, roles: ['student'], status: 'pending' });
        return { id: actorId };
      }
      const actor = await user(tx, actorId);
      const requestKey = key(actorId, command.requestId);
      const fingerprint = key(JSON.stringify(command));
      const prior = await tx.get('requestKeys', requestKey);
      if (prior) {
        requireThat(prior.fingerprint === fingerprint, 'REQUEST_REUSED', '请求编号已用于其他操作');
        return prior.result;
      }
      const rules = await tx.get('settings', 'store') || defaultRules;
      const result = await this.mutate(tx, actor, command, requestKey, now, rules, cancellationIds);
      await tx.put('requestKeys', { id: requestKey, fingerprint, result });
      await tx.put('auditLogs', { id: requestKey, actorId, action: command.action, targetId: result.id, at: now });
      return result;
    });
  }
  private async mutate(tx: Tx, actor: User, cmd: Exclude<Command, { action: 'register' | 'dashboard' }>, operation: string, now: number, rules: Rules, cancellationIds: string[] = []): Promise<{ id: string }> {
    if (cmd.action === 'approve') {
      role(actor, 'admin');
      const target = await tx.get('users', cmd.userId);
      requireThat(target && target.status === 'pending', 'STATE', '学员不在待审核状态');
      target.status = 'active'; await tx.put('users', target); return { id: target.id };
    }
    if (cmd.action === 'purchase') {
      role(actor, 'admin'); const member = await user(tx, cmd.memberId); role(member, 'student');
      requireThat(cmd.expiresAt > now, 'EXPIRED', '课包有效期必须在未来');
      requireThat(cmd.kind === 'group' ? cmd.coachIds.length === 0 : cmd.coachIds.length > 0, 'SCOPE', '私教课包必须指定教练，团课课包不绑定教练');
      for (const id of cmd.coachIds) role(await user(tx, id), 'coach');
      const p: Package = { id: operation, memberId: cmd.memberId, kind: cmd.kind, coachIds: [...new Set(cmd.coachIds)], available: 0, frozen: 0, consumed: 0, total: cmd.credits, expiresAt: cmd.expiresAt };
      await ledger(tx, p, actor.id, 'purchase', operation, now, cmd.credits, 0, 0);
      await tx.put('purchaseRecords', { id: operation, memberId: cmd.memberId, packageId: p.id, amountFen: cmd.amountFen, method: cmd.method, note: cmd.note, actorId: actor.id, at: now });
      return { id: p.id };
    }
    if (cmd.action === 'publish') {
      requireThat(hasRole(actor, 'admin') || (hasRole(actor, 'coach') && cmd.coachId === actor.id && cmd.kind === 'private'), 'FORBIDDEN', '仅管理员可发布团课，教练只能设置自己的私教时段');
      role(await user(tx, cmd.coachId), 'coach');
      requireThat(cmd.end > cmd.start && cmd.start > now && cmd.end - cmd.start <= 4 * 3600000 && dayKey(cmd.start) === dayKey(cmd.end - 1), 'TIME', '课程须在未来、同一天内且不超过四小时');
      requireThat(cmd.kind !== 'private' || cmd.capacity === 1, 'CAPACITY', '私教人数必须为一人');
      const s: Session = { id: operation, kind: cmd.kind, title: cmd.title, coachId: cmd.coachId, roomId: cmd.roomId, exclusive: cmd.exclusive, start: cmd.start, end: cmd.end, capacity: cmd.capacity, cost: cmd.cost, reserved: 0, status: 'open', cancelHours: cmd.kind === 'private' ? rules.privateCancelHours : rules.groupCancelHours, cutoffMinutes: rules.cutoffMinutes };
      const owners = [`coach:${s.coachId}`, ...(s.exclusive ? [`room:${s.roomId}`] : [])].sort();
      for (const owner of owners) await schedule(tx, owner, s, s.id, true);
      await tx.put('sessions', s); return { id: s.id };
    }
    if (cmd.action === 'editSlot') {
      const source = await tx.get('sessions', cmd.sessionId);
      requireThat(source, 'NOT_FOUND', '场次不存在');
      requireThat(hasRole(actor, 'admin') || (hasRole(actor, 'coach') && source.coachId === actor.id && source.kind === 'private'), 'FORBIDDEN', '无权编辑该时段');
      requireThat(source.status === 'open' && source.reserved === 0 && source.start > now, 'STATE', '仅可编辑未开始且没有预约的开放时段，请刷新后重试');
      // Keep the original session for cancelled booking history. Replacement and
      // lock movement share one transaction, so failed edits leave it untouched.
      source.status = 'closed';
      for (const owner of [`coach:${source.coachId}`, ...(source.exclusive ? [`room:${source.roomId}`] : [])].sort()) await schedule(tx, owner, source, source.id, false);
      await tx.put('sessions', source);
      return this.mutate(tx, actor, { action: 'publish', requestId: cmd.requestId,
        kind: source.kind, coachId: source.coachId, exclusive: source.exclusive, cost: source.cost,
        title: cmd.title, roomId: cmd.roomId, start: cmd.start, end: cmd.end, capacity: cmd.capacity,
      }, operation, now, rules);
    }
    if (cmd.action === 'copyWeek') {
      requireThat(hasRole(actor, 'admin') || hasRole(actor, 'coach'), 'FORBIDDEN', '仅教练或管理员可复制排班');
      requireThat(new Set(cmd.sessionIds).size === cmd.sessionIds.length, 'INPUT', '复制列表包含重复时段');
      requireThat(cmd.sourceStart === Date.parse(`${dayKey(cmd.sourceStart)}T00:00:00+08:00`), 'TIME', '请选择有效的起始日期');
      const week = 7 * 86400000;
      let coachId = '';
      for (const id of cmd.sessionIds) {
        const source = await tx.get('sessions', id);
        requireThat(source && source.status === 'open' && source.kind === 'private', 'STATE', '只能复制开放的私教时段');
        requireThat(source.start >= cmd.sourceStart && source.start < cmd.sourceStart + week, 'TIME', '来源时段必须在所选七天内');
        requireThat(!coachId || coachId === source.coachId, 'SCOPE', '每次只能复制一位教练的排班');
        coachId = source.coachId;
        // Reuse publish authorization and schedule locks inside this same transaction.
        // A conflict anywhere rolls back the entire batch; reservations are never copied.
        await this.mutate(tx, actor, { action: 'publish', requestId: cmd.requestId,
          kind: source.kind, title: source.title, coachId, roomId: source.roomId,
          exclusive: source.exclusive, start: source.start + week, end: source.end + week,
          capacity: source.capacity, cost: source.cost,
        }, key(operation, source.id), now, rules);
      }
      return { id: operation };
    }
    if (cmd.action === 'cancelSession') {
      role(actor, 'admin');
      const s = await tx.get('sessions', cmd.sessionId);
      requireThat(s, 'NOT_FOUND', '场次不存在');
      if (s.status === 'closed' && s.cancelledAt) return { id: s.id };
      requireThat(s.status === 'open' && s.start > now, 'STATE', '仅可停课尚未开始的开放场次');
      requireThat(new Set(cancellationIds).size === cancellationIds.length && s.reserved === cancellationIds.length, 'ROSTER_CHANGED', '预约名单已变化，请刷新后重新停课');
      const bookings: Booking[] = [];
      for (const id of cancellationIds) {
        const b = await tx.get('bookings', id);
        requireThat(b && b.sessionId === s.id && b.status === 'confirmed', 'ROSTER_CHANGED', '预约名单已变化，请刷新后重新停课');
        bookings.push(b);
      }
      for (const b of bookings) {
        const p = await tx.get('memberPackages', b.packageId);
        requireThat(p && p.memberId === b.memberId, 'DATA_INTEGRITY', '课包记录异常，停课未执行，请联系管理员');
        await schedule(tx, `member:${b.memberId}`, s, b.id, false);
        await ledger(tx, p, actor.id, 'release', b.id, now, b.cost, -b.cost, 0);
        b.status = 'cancelled'; b.cancelReason = cmd.reason; await tx.put('bookings', b);
        await notify(tx, b, s, `门店停课：${cmd.reason}`, now);
      }
      for (const owner of [`coach:${s.coachId}`, ...(s.exclusive ? [`room:${s.roomId}`] : [])].sort()) await schedule(tx, owner, s, s.id, false);
      s.reserved = 0; s.status = 'closed'; s.cancelReason = cmd.reason; s.cancelledAt = now; s.cancelledBy = actor.id;
      await tx.put('sessions', s);
      return { id: s.id };
    }
    if (cmd.action === 'closeSlot') {
      const s = await tx.get('sessions', cmd.sessionId);
      requireThat(s, 'NOT_FOUND', '场次不存在');
      requireThat(hasRole(actor, 'admin') || (hasRole(actor, 'coach') && s.coachId === actor.id && s.kind === 'private'), 'FORBIDDEN', '无权关闭该时段');
      requireThat(s.reserved === 0 && s.start > now, 'STATE', '已有预约或已开始，不能直接关闭');
      s.status = 'closed';
      for (const owner of [`coach:${s.coachId}`, ...(s.exclusive ? [`room:${s.roomId}`] : [])].sort()) await schedule(tx, owner, s, s.id, false);
      await tx.put('sessions', s); return { id: s.id };
    }
    if (cmd.action === 'book') {
      role(actor, 'student');
      const s = await tx.get('sessions', cmd.sessionId);
      const p = await tx.get('memberPackages', cmd.packageId);
      requireThat(s && s.status === 'open', 'NOT_FOUND', '场次不可预约');
      const coach = await user(tx, s.coachId); role(coach, 'coach');
      requireThat(s.start - now >= s.cutoffMinutes * 60000 && s.start - now <= rules.bookingDays * 86400000, 'WINDOW', '不在可预约时间范围内');
      requireThat(p && p.memberId === actor.id && p.kind === s.kind && (p.kind !== 'private' || p.coachIds.includes(s.coachId)), 'PACKAGE', '课包不适用于该课程');
      requireThat(p.expiresAt >= s.start, 'EXPIRED', '上课时间超出课包有效期');
      requireThat(p.available >= s.cost, 'BALANCE', '可用课时不足');
      requireThat(s.reserved < s.capacity, 'FULL', '该场次已约满');
      const b: Booking = { id: operation, sessionId: s.id, memberId: actor.id, packageId: p.id, cost: s.cost, cancelHours: s.cancelHours, status: 'confirmed', createdAt: now };
      await schedule(tx, `member:${actor.id}`, s, b.id, true);
      s.reserved++; await tx.put('sessions', s); await tx.put('bookings', b);
      await ledger(tx, p, actor.id, 'freeze', b.id, now, -b.cost, b.cost, 0);
      await notify(tx, b, s, '预约成功', now); return { id: b.id };
    }
    const b = await tx.get('bookings', cmd.bookingId);
    requireThat(b, 'NOT_FOUND', '预约不存在');
    const s = await tx.get('sessions', b.sessionId); const p = await tx.get('memberPackages', b.packageId);
    requireThat(s && p, 'DATA_INTEGRITY', '关联记录缺失，请联系管理员');
    if (cmd.action === 'cancel') {
      requireThat(b.memberId === actor.id, 'FORBIDDEN', '只能取消自己的预约');
      if (b.status === 'cancelled') return { id: b.id };
      requireThat(b.status === 'confirmed', 'STATE', '该预约已经结算');
      requireThat(s.start > now && s.start - now >= b.cancelHours * 3600000, 'LATE_CANCEL', '已超过取消期限，请联系门店');
      requireThat(s.reserved > 0, 'DATA_INTEGRITY', '场次名额异常');
      b.status = 'cancelled'; s.reserved--;
      await schedule(tx, `member:${b.memberId}`, s, b.id, false);
      await ledger(tx, p, actor.id, 'release', b.id, now, b.cost, -b.cost, 0);
      await tx.put('sessions', s); await tx.put('bookings', b);
      await notify(tx, b, s, '预约已取消', now); return { id: b.id };
    }
    requireThat(hasRole(actor, 'admin') || (hasRole(actor, 'coach') && s.coachId === actor.id), 'FORBIDDEN', '只能结算本人授课预约');
    if (b.status === cmd.outcome) return { id: b.id };
    requireThat(b.status === 'confirmed' && s.end <= now, 'STATE', '课程结束后才能确认出勤，已结算记录需走纠错流程');
    b.status = cmd.outcome;
    await ledger(tx, p, actor.id, 'consume', b.id, now, 0, -b.cost, b.cost);
    await tx.put('bookings', b); await notify(tx, b, s, cmd.outcome === 'attended' ? '到课已消课' : '爽约已消课', now);
    return { id: b.id };
  }
  private async dashboard(actorId: string) {
    const actor = await this.store.transaction(tx => tx.get('users', actorId));
    if (!actor) return { profile: null };
    if (actor.status !== 'active') return { profile: actor };
    const admin = hasRole(actor, 'admin'); const coach = hasRole(actor, 'coach');
    const sessions = await this.store.list('sessions', {}, 200);
    const ownSessions = sessions.filter(s => s.coachId === actor.id);
    let bookings = admin ? await this.store.list('bookings', {}, 200) : coach
      ? (await Promise.all(ownSessions.map(s => this.store.list('bookings', { sessionId: s.id }, 100)))).flat()
      : await this.store.list('bookings', { memberId: actor.id }, 200);
    if (coach && hasRole(actor, 'student')) bookings = [...new Map([...bookings, ...await this.store.list('bookings', { memberId: actor.id }, 200)].map(b => [b.id, b])).values()];
    const users = admin ? await this.store.list('users', {}, 200) : [];
    const roster = coach ? await this.store.transaction(async tx => {
      const result: { id: string; name: string }[] = [];
      for (const id of [...new Set(bookings.map(b => b.memberId))]) {
        const member = await tx.get('users', id); if (member) result.push({ id, name: member.name });
      }
      return result;
    }) : [];
    return {
      profile: actor,
      sessions: sessions.filter(s => admin || (coach && s.coachId === actor.id) || bookings.some(b => b.sessionId === s.id) || (s.status === 'open' && s.start >= this.clock())),
      packages: await this.store.list('memberPackages', admin ? {} : { memberId: actor.id }, 200),
      bookings,
      inbox: await this.store.list('inbox', { userId: actor.id }, 200),
      ledger: await this.store.list('creditLedger', admin ? {} : { memberId: actor.id }, 200),
      users,
      roster,
      coaches: (await this.store.list('users', { status: 'active' }, 200)).filter(u => hasRole(u, 'coach')).map(u => ({ id: u.id, name: u.name })),
      purchases: admin ? await this.store.list('purchaseRecords', {}, 200) : [],
    };
  }
}
