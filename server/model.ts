import { z } from 'zod';

export const roleSchema = z.enum(['student', 'coach', 'admin']);
export const kindSchema = z.enum(['private', 'group']);
export type Role = z.infer<typeof roleSchema>;
export type Kind = z.infer<typeof kindSchema>;
export interface User { id: string; name: string; phone: string; birthday?: string; employmentType?: 'fullTime' | 'partTime'; roles: Role[]; status: 'pending' | 'active' | 'disabled' }
export interface Session { id: string; kind: Kind; title: string; coachId: string; roomId: string; exclusive: boolean; start: number; end: number; capacity: number; reserved: number; cost: number; status: 'open' | 'closed' | 'rest'; cancelHours: number; cutoffMinutes: number; cancelReason?: string; cancelledAt?: number; cancelledBy?: string }
export interface Package { id: string; memberId: string; kind: Kind; coachIds: string[]; available: number; frozen: number; consumed: number; total: number; expiresAt: number }
export interface Booking { id: string; sessionId: string; memberId: string; packageId: string; cost: number; cancelHours: number; status: 'confirmed' | 'cancelled' | 'attended' | 'absent'; createdAt: number; cancelReason?: string }
export interface Schedule { id: string; entries: { ref: string; start: number; end: number }[] }
export interface Ledger { id: string; packageId: string; memberId: string; actorId: string; type: 'purchase' | 'freeze' | 'release' | 'consume'; reference: string; delta: { available: number; frozen: number; consumed: number }; at: number }
export interface Purchase { id: string; memberId: string; packageId: string; amountFen: number; method: 'cash' | 'transfer'; note: string; actorId: string; at: number }
export interface Inbox { id: string; userId: string; title: string; bookingId: string; at: number; detail?: string; receipt?: { packageId: string; deductedFen: number; remainingFen: number; consumedCredits: number; remainingCredits: number; frozenCredits: number } }
export interface RequestRecord { id: string; fingerprint: string; result: { id: string } }
export interface Audit { id: string; actorId: string; action: string; targetId: string; at: number }
export interface Rules { id: string; bookingDays: number; privateCancelHours: number; groupCancelHours: number; cutoffMinutes: number }
export interface Tables { users: User; sessions: Session; memberPackages: Package; bookings: Booking; scheduleLocks: Schedule; creditLedger: Ledger; purchaseRecords: Purchase; inbox: Inbox; requestKeys: RequestRecord; auditLogs: Audit; settings: Rules }
export type Table = keyof Tables;
const id = z.string().min(1).max(128).regex(/^[\w-]+$/);
const requestId = z.string().min(8).max(100).regex(/^[\w-]+$/);
const count = z.number().int().positive().max(10000);
const time = z.number().int().positive().max(4102444800000);
const birthday = z.string().regex(/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}, '生日日期无效');
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), name: z.string().trim().min(1).max(40), phone: z.string().regex(/^1\d{10}$/), birthday }).strict(),
  z.object({ action: z.literal('approve'), requestId, userId: id }).strict(),
  z.object({ action: z.literal('updateMember'), requestId, userId: id, name: z.string().trim().min(1).max(40), phone: z.string().regex(/^1\d{10}$/), birthday }).strict(),
  z.object({ action: z.literal('updateCoachPay'), requestId, userId: id, employmentType: z.enum(['fullTime', 'partTime']) }).strict(),
  z.object({ action: z.literal('setCoach'), requestId, userId: id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('purchase'), requestId, memberId: id, kind: kindSchema, coachIds: z.array(id).max(20), credits: count, expiresAt: time, amountFen: z.number().int().min(0).max(100000000), method: z.enum(['cash', 'transfer']), note: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('publish'), requestId, kind: kindSchema, title: z.string().trim().min(1).max(60), coachId: id, roomId: z.string().trim().min(1).max(40), exclusive: z.boolean(), start: time, end: time, capacity: z.number().int().min(1).max(100), cost: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal('setSlotState'), requestId, coachId: id, sessionId: id.optional(), start: time, end: time, state: z.enum(['open', 'rest', 'clear']) }).strict(),
  z.object({ action: z.literal('editSlot'), requestId, sessionId: id, title: z.string().trim().min(1).max(60), roomId: z.string().trim().min(1).max(40), start: time, end: time, capacity: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal('copyWeek'), requestId, sessionIds: z.array(id).min(1).max(35), sourceStart: time }).strict(),
  z.object({ action: z.literal('cancelSession'), requestId, sessionId: id, reason: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('closeSlot'), requestId, sessionId: id }).strict(),
  z.object({ action: z.literal('book'), requestId, sessionId: id, packageId: id }).strict(),
  z.object({ action: z.literal('cancel'), requestId, bookingId: id }).strict(),
  z.object({ action: z.literal('settle'), requestId, bookingId: id, outcome: z.enum(['attended', 'absent']) }).strict(),
  z.object({ action: z.literal('dashboard') }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export interface Tx {
  hasCoachWork(coachId: string, now: number): Promise<boolean>;
  get<K extends Table>(table: K, id: string): Promise<Tables[K] | undefined>;
  put<K extends Table>(table: K, value: Tables[K]): Promise<void>;
}
export interface Store {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  list<K extends Table>(table: K, filter: Partial<Tables[K]>, limit: number): Promise<Tables[K][]>;
}
export class BusinessError extends Error { constructor(public code: string, message: string) { super(message); } }
export function requireThat(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new BusinessError(code, message); }
export const dayKey = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
export const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
