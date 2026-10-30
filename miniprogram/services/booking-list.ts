export interface BookingListItem { status: string; start: number; canSettle: boolean }
export function bookingList<T extends BookingListItem>(items: T[], role: string, filter: string, limit: number, today: string) {
  const day = (start: number) => new Date(start + 8 * 3600000).toISOString().slice(0, 10);
  const rows = items.filter(b => filter === 'completed' ? ['attended', 'absent'].includes(b.status)
    : filter === 'cancelled' ? b.status === 'cancelled'
    : filter === 'today' ? b.status === 'confirmed' && b.start > 0 && day(b.start) === today
    : filter === 'settle' ? b.canSettle : b.status === 'confirmed');
  rows.sort((a, b) => filter === 'completed' || filter === 'cancelled' ? b.start - a.start
    : filter === 'upcoming' && a.canSettle !== b.canSettle ? (role === 'coach' ? -1 : 1) * (Number(a.canSettle) - Number(b.canSettle)) : a.start - b.start);
  return { rows: rows.slice(0, limit), total: rows.length };
}
