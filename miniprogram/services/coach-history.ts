export interface HistorySource {
  coaches: { id: string; name: string }[];
  teachingHistory: { id: string; coachId: string; memberId: string; memberName: string; month: string; start: number; end: number; title: string; kind: string; status: string; amountFen: number }[];
}
export function coachColor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return { color: `hsl(${hue}, 48%, 34%)`, background: `hsl(${hue}, 45%, 95%)` };
}
export function coachHistory(finance: HistorySource, id: string, month: string) {
  const coach = finance.coaches.find(c => c.id === id);
  if (!coach) return null;
  const rows = finance.teachingHistory.filter(r => r.coachId === id && r.month === month).sort((a, b) => b.start - a.start);
  const attended = rows.filter(r => r.status === 'attended');
  const date = (n: number) => new Date(n + 8 * 3600000).toISOString();
  return { ...coachColor(id), name: coach.name, month, count: attended.length,
    students: new Set(attended.map(r => r.memberId)).size,
    amount: `¥${(rows.reduce((sum, r) => sum + r.amountFen, 0) / 100).toFixed(2)}`,
    records: rows.map(r => ({ id: r.id, memberName: r.memberName, title: r.title,
      date: date(r.start).slice(0, 10), time: `${date(r.start).slice(11, 16)}–${date(r.end).slice(11, 16)}`,
      kind: r.kind === 'private' ? '私教' : '团课', status: r.status === 'attended' ? '已到课' : '爽约已结算',
      amount: `¥${(r.amountFen / 100).toFixed(2)}` })) };
}
