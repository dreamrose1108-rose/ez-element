import { Tx, User, Rules, requireThat } from './model';
import { key, walletKey } from './service';

// All records are read in the same serializable transaction as the writes.
export async function migrateLegacy(tx: Tx, actor: User, rules: Rules, now: number) {
  requireThat(actor.roles.includes('admin'), 'FORBIDDEN', '仅管理员可以转换旧课包');
  const { packages, bookings } = await tx.migrationRecords();
  for (const pack of packages.filter(p => p.kind !== 'wallet' && !p.migratedAt).sort((a, b) => a.id.localeCompare(b.id))) {
    if (pack.kind === 'wallet') continue;
    const purchase = await tx.get('purchaseRecords', pack.id);
    const member = await tx.get('users', pack.memberId);
    requireThat(member && purchase && purchase.packageId === pack.id && purchase.memberId === pack.memberId && Number.isSafeInteger(purchase.amountFen) && purchase.amountFen >= 0, 'MIGRATION_DATA', '旧课包缺少原始实收记录，未执行转换');
    requireThat(pack.total > 0 && [pack.total, pack.available, pack.frozen, pack.consumed].every(n => Number.isSafeInteger(n) && n >= 0) && pack.available + pack.frozen + pack.consumed === pack.total, 'MIGRATION_DATA', '旧课包余额不一致，未执行转换');
    const active = bookings.filter(b => b.packageId === pack.id && b.status === 'confirmed').sort((a, b) => a.id.localeCompare(b.id));
    requireThat(active.every(b => b.memberId === pack.memberId && Number.isSafeInteger(b.cost) && b.cost > 0) && active.reduce((sum, b) => sum + b.cost, 0) === pack.frozen, 'MIGRATION_DATA', '冻结课时与预约不一致，未执行转换');
    // Cumulative rounding preserves every cent, even when price is non-integral.
    const allocated = (credits: number) => Number((BigInt(purchase.amountFen) * BigInt(credits) * 2n + BigInt(pack.total)) / (BigInt(pack.total) * 2n));
    const remaining = purchase.amountFen - allocated(pack.consumed);
    let credits = pack.consumed; let frozen = 0;
    const id = walletKey(pack.memberId);
    for (const booking of active) {
      const amountFen = allocated(credits + booking.cost) - allocated(credits); credits += booking.cost; frozen += amountFen;
      booking.legacyPackageId = pack.id; booking.packageId = id;
      booking.amountFen = amountFen; booking.unitPriceFen = purchase.amountFen / pack.total;
      await tx.put('bookings', booking);
    }
    const wallet = await tx.get('memberPackages', id) || { id, memberId: pack.memberId, kind: 'wallet' as const, coachIds: [], available: 0, frozen: 0, consumed: 0, total: 0, expiresAt: pack.expiresAt };
    requireThat(wallet.kind === 'wallet' && wallet.memberId === pack.memberId && wallet.available + wallet.frozen + wallet.consumed === wallet.total, 'MIGRATION_DATA', '储值账户异常');
    wallet.available += remaining - frozen; wallet.frozen += frozen; wallet.total += remaining;
    wallet.expiresAt = Math.max(wallet.expiresAt, pack.expiresAt);
    requireThat([wallet.available, wallet.frozen, wallet.total].every(n => Number.isSafeInteger(n) && n >= 0), 'MIGRATION_DATA', '转换金额异常');
    await tx.put('memberPackages', wallet);
    await tx.put('creditLedger', { id: key('legacy-conversion', pack.id), packageId: id, memberId: pack.memberId, actorId: actor.id, unit: 'fen', type: 'migration', reference: pack.id, delta: { available: remaining - frozen, frozen, consumed: 0 }, at: now });
    // Archive for historical receipts/payroll; never erase financial evidence.
    pack.migratedAt = now; pack.migratedWalletId = id; await tx.put('memberPackages', pack);
    const unit = purchase.amountFen / pack.total;
    if (!member.prices?.[pack.kind] && Number.isSafeInteger(unit) && unit > 0) {
      member.prices = { ...member.prices, [pack.kind]: unit }; await tx.put('users', member);
    }
  }
  await tx.put('settings', { ...rules, walletOnly: true });
  return { id: 'store' };
}
