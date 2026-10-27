import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './memory-store';
import { GymService, userKey } from './service';
import { BusinessError, dayKey } from './model';

const store = new MemoryStore();
const service = new GymService(store);
async function seed() {
  await store.transaction(async tx => {
    for (const [openid, name, roles] of [['demo-student', '陈晓', ['student']], ['demo-coach', '林教练', ['coach']], ['demo-admin', '门店管理员', ['admin']]] as const) {
      await tx.put('users', { id: userKey(openid), name, phone: '13800000000', roles: [...roles], status: 'active' });
    }
  });
  for (const kind of ['private', 'group'] as const) await service.execute('demo-admin', { action: 'purchase', requestId: randomUUID(), memberId: userKey('demo-student'), kind, coachIds: kind === 'private' ? [userKey('demo-coach')] : [], credits: 12, expiresAt: Date.now() + 180 * 86400000, amountFen: kind === 'private' ? 240000 : 96000, method: 'transfer', note: '本地演示入账，无真实收款' });
  for (let d = 0; d < 7; d++) {
    const day = dayKey(Date.now() + d * 86400000);
    for (const hour of [9, 10, 14, 15, 17, 19]) {
      const start = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`);
      if (start <= Date.now()) continue;
      await service.execute('demo-admin', { action: 'publish', requestId: randomUUID(), kind: hour === 19 ? 'group' : 'private', title: hour === 19 ? '活力燃脂团课' : '专属力量训练', coachId: userKey('demo-coach'), roomId: hour === 19 ? '团课教室' : '私教区', exclusive: false, start, end: start + 3600000, capacity: hour === 19 ? 10 : 1, cost: 1 });
    }
  }
}
async function start() {
  await seed();
  createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST' || req.url !== '/api') { res.writeHead(404); res.end('{}'); return; }
    let body = '';
    try {
      for await (const chunk of req) { body += String(chunk); if (body.length > 16384) throw new Error('Body too large'); }
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || !('role' in parsed) || !('command' in parsed) || !['student', 'coach', 'admin'].includes(String(parsed.role))) throw new Error('Invalid demo role');
      const data = await service.execute(`demo-${String(parsed.role)}`, parsed.command);
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, code: e instanceof BusinessError ? e.code : 'INVALID_INPUT', message: e instanceof BusinessError ? e.message : '演示请求格式错误' }));
    }
  }).listen(4174, '127.0.0.1', () => console.log('LOCAL DEMO ONLY: http://127.0.0.1:4174/api · 数据仅在内存，重启重置'));
}
start().catch(() => { console.error('DEMO_START_FAILED'); process.exitCode = 1; });
