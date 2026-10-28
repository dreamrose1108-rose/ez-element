import { BusinessError, Store, Table, Tables, Tx } from './model';

// The SDK exposes loose types. Keep that uncertainty at this boundary rather
// than propagating it into domain code. Shapes checked against installed SDK.
interface DocumentRef { get(): Promise<{ data: unknown; code?: string }>; set(data: object): Promise<unknown> }
interface Collection { doc(id: string): DocumentRef; where(filter: object): { limit(n: number): { get(): Promise<{ data: unknown }> } } }
export interface CloudDatabase {
  collection(name: string): Collection;
  runTransaction<T>(fn: (transaction: { collection(name: string): Collection }) => Promise<T>, retries: number): Promise<T>;
}
function checked<T>(result: T): T {
  if (result && typeof result === 'object' && 'code' in result && result.code) throw Object.assign(new Error('Cloud database operation failed'), { code: String(result.code) });
  return result;
}
function document<K extends Table>(raw: unknown): Tables[K] | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Invalid stored document');
  // Private collections are written only by the typed service; legacy imports
  // must pass a separate migration validation before entering these collections.
  const { _id, ...rest } = value as Record<string, unknown>;
  return rest as unknown as Tables[K];
}
export class CloudStore implements Store {
  constructor(private db: CloudDatabase) {}
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async transaction => work({
      // Legacy NoSQL adapter cannot provide a serializable cross-collection check.
      hasCoachWork: async () => { throw new BusinessError('UNSUPPORTED', '当前存储不支持安全取消教练身份，请使用 PostgreSQL 环境'); },
      get: async <K extends Table>(table: K, id: string) => document<K>(checked(await transaction.collection(table).doc(id).get()).data),
      put: async <K extends Table>(table: K, value: Tables[K]) => { checked(await transaction.collection(table).doc(value.id).set(value)); },
    }), 3);
  }
  async list<K extends Table>(table: K, filter: Partial<Tables[K]>, limit: number): Promise<Tables[K][]> {
    const result = checked(await this.db.collection(table).where(filter).limit(limit).get());
    if (!Array.isArray(result.data)) throw new Error('Invalid query result');
    return result.data.map(row => document<K>(row)).filter((row): row is Tables[K] => row !== undefined);
  }
}
