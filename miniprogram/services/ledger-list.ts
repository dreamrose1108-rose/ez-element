export interface LedgerRow { id: string; memberId: string; type: string; at: number; unit?: string; delta: { available: number; frozen: number; consumed: number } }
export const ledgerTypes = [{ id: '', name: '全部类型' }, { id: 'purchase', name: '充值 / 购课' }, { id: 'freeze', name: '预约冻结' }, { id: 'release', name: '取消解冻' }, { id: 'consume', name: '消课扣款' }, { id: 'migration', name: '旧课包转入' }];
export function ledgerList(rows: LedgerRow[], users: { id: string; name: string }[], memberId: string, month: string, type: string) {
  const names = new Map(users.map(u => [u.id, u.name]));
  const name = (id: string) => names.get(id) || `未加载姓名 · ${id.slice(-6)}`;
  const date = (at: number) => new Date(at + 8 * 3600000).toISOString();
  const members = [{ id: '', name: '全部学员' }, ...[...new Set([...users.map(u => u.id), ...rows.map(r => r.memberId)])].map(id => ({ id, name: `${name(id)} · ${id.slice(-6)}` })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))];
  const months = [{ id: '', name: '全部月份' }, ...[...new Set(rows.map(r => date(r.at).slice(0, 7)))].sort().reverse().map(id => ({ id, name: id }))];
  const amount = (n: number, unit?: string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${unit === 'fen' ? `¥${(Math.abs(n) / 100).toFixed(2)}` : `${Math.abs(n)} 节`}`;
  const filtered = rows.filter(r => (!memberId || r.memberId === memberId) && (!month || date(r.at).slice(0, 7) === month) && (!type || r.type === type)).sort((a, b) => b.at - a.at).map(r => ({
    id: r.id, memberName: name(r.memberId), shortId: r.memberId.slice(-6), title: ledgerTypes.find(t => t.id === r.type)?.name || r.type,
    date: `${date(r.at).slice(0, 10)} ${date(r.at).slice(11, 16)}`, available: amount(r.delta.available, r.unit), frozen: amount(r.delta.frozen, r.unit), consumed: amount(r.delta.consumed, r.unit),
  }));
  return { members, months, rows: filtered };
}
