import { setTimeout as delay } from 'node:timers/promises';
import { Pool, PoolConfig } from 'pg';
import { Store, Table, Tables, Tx } from './model';

// Keep the existing domain records in JSONB; PostgreSQL owns transactions,
// primary keys, indexes and RLS. No SQL identifiers come from request payloads.
export const pgTables = ['users', 'sessions', 'memberPackages', 'bookings', 'scheduleLocks', 'creditLedger', 'purchaseRecords', 'inbox', 'requestKeys', 'auditLogs', 'settings'] as const satisfies readonly Table[];
export function sqlTable(table: Table): string {
  if (!(pgTables as readonly string[]).includes(table)) throw new Error('Unknown table');
  return `public."ez_${table}"`;
}
function record<K extends Table>(raw: unknown): Tables[K] {
  if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') throw new Error('Invalid stored record');
  return raw as Tables[K];
}

export class PostgresStore implements Store {
  constructor(private pool: Pool) {}
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    // SERIALIZABLE covers reads of missing rows too (new schedule locks and
    // request keys). READ COMMITTED + UPSERT would allow lost updates here.
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let discard = false;
      let retry = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
        const tx: Tx = {
          hasCoachWork: async (coachId, now) => {
            const result = await client.query(`SELECT EXISTS (
              SELECT 1 FROM public.ez_sessions s WHERE s.data->>'coachId' = $1 AND
                ((s.data->>'status' IN ('open', 'rest') AND (s.data->>'end')::bigint > $2) OR EXISTS (
                  SELECT 1 FROM public.ez_bookings b WHERE b.data->>'sessionId' = s.id AND b.data->>'status' = 'confirmed'
                ))) AS pending`, [coachId, now]);
            return result.rows[0].pending === true;
          },
          get: async <K extends Table>(table: K, id: string) => {
            const result = await client.query(`SELECT data FROM ${sqlTable(table)} WHERE id = $1`, [id]);
            return result.rows.length ? record<K>(result.rows[0].data) : undefined;
          },
          put: async <K extends Table>(table: K, value: Tables[K]) => {
            await client.query(`INSERT INTO ${sqlTable(table)} (id, data) VALUES ($1, $2::jsonb)
              ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [value.id, JSON.stringify(value)]);
          },
        };
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // Only retry errors which PostgreSQL guarantees aborted the transaction.
        // A lost connection during COMMIT has an unknown outcome: callers reuse
        // their business request ID instead of blindly replaying it here.
        if (!discard && attempt < 11 && (code === '40001' || code === '40P01')) retry = true;
        else throw error;
      } finally {
        client.release(discard);
      }
      if (retry) await delay(Math.min(100, 5 * 2 ** attempt) + Math.floor(Math.random() * 20));
    }
  }
  async list<K extends Table>(table: K, filter: Partial<Tables[K]>, limit: number): Promise<Tables[K][]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid query limit');
    const result = await this.pool.query(`SELECT data FROM ${sqlTable(table)}
      WHERE data @> $1::jsonb ORDER BY id LIMIT $2`, [JSON.stringify(filter), limit]);
    return result.rows.map(row => record<K>(row.data));
  }
}

export function postgresConfig(env: NodeJS.ProcessEnv): PoolConfig {
  for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  const port = Number(env.PGPORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PGPORT');
  const mode = env.EZ_PG_SSL || 'verify-full';
  if (!['verify-full', 'disable'].includes(mode)) throw new Error('Invalid EZ_PG_SSL');
  // Disable is explicitly available for a console-documented private network or
  // local integration setup. Never silently turn off certificate verification.
  return { host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD,
    ssl: mode === 'disable' ? false : { rejectUnauthorized: true, ...(env.EZ_PG_CA ? { ca: env.EZ_PG_CA } : {}) },
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000,
    application_name: 'form-flow-api',
  };
}

let sharedStore: PostgresStore | undefined;
export function postgresStore(): PostgresStore {
  if (!sharedStore) {
    const pool = new Pool(postgresConfig(process.env));
    // An idle connection error must not crash a warm cloud function or expose
    // the connection details in logs. pg removes that connection from the pool.
    pool.on('error', () => console.error('EZ_PG_POOL_FAILURE'));
    sharedStore = new PostgresStore(pool);
  }
  return sharedStore;
}
