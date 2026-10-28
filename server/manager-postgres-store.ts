import { setTimeout as delay } from 'node:timers/promises';
import CloudBase from '@cloudbase/manager-node';
import { Store, Table, Tables, Tx } from './model';
import { pgTables, sqlTable } from './postgres-store';

export interface ExecutePGSqlResult {
  AffectedRows: number;
  Columns: string[] | null;
  Rows: string[] | null;
}
export interface PGSqlExecutor {
  executePGSql(options: { EnvId?: string; Sql: string }): Promise<ExecutePGSqlResult>;
}

type Snapshot = { version: number; tables: { [K in Table]: Record<string, Tables[K]> } };
type Write = { table: Table; id: string; data: Tables[Table] };

const clone = <T>(value: T): T => structuredClone(value);
const textLiteral = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const jsonbFromBase64 = (value: unknown) =>
  `convert_from(decode('${textLiteral(value)}','base64'),'UTF8')::jsonb`;

function oneRow(result: ExecutePGSqlResult): unknown[] {
  if (!result.Rows || result.Rows.length !== 1) throw new Error('Unexpected PostgreSQL response');
  const row = JSON.parse(result.Rows[0]!);
  if (!Array.isArray(row)) throw new Error('Unexpected PostgreSQL row');
  return row;
}

function snapshotSql(): string {
  const fields = pgTables.map(table =>
    `'${table}', COALESCE((SELECT jsonb_object_agg(id, data) FROM ${sqlTable(table)}), '{}'::jsonb)`,
  ).join(',\n');
  return `SELECT version::text, jsonb_build_object(${fields})::text
    FROM public."ez_store_meta" WHERE id = 'store'`;
}

function emptyTables(): Snapshot['tables'] {
  return Object.fromEntries(pgTables.map(table => [table, {}])) as Snapshot['tables'];
}

export class ManagerPostgresStore implements Store {
  constructor(private executor: PGSqlExecutor, private envId?: string) {}

  private async snapshot(): Promise<Snapshot> {
    const [rawVersion, rawState] = oneRow(await this.executor.executePGSql({ EnvId: this.envId, Sql: snapshotSql() }));
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 0 || typeof rawState !== 'string') throw new Error('Invalid PostgreSQL snapshot');
    const parsed = JSON.parse(rawState) as Record<string, unknown>;
    const tables = emptyTables();
    for (const table of pgTables) {
      const rows = parsed[table];
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Invalid PostgreSQL table snapshot');
      tables[table] = rows as never;
    }
    return { version, tables };
  }

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = await this.snapshot();
      const writes = new Map<string, Write>();
      const tx: Tx = {
        hasCoachWork: async (coachId, now) => {
          const sessions = Object.values(snapshot.tables.sessions).filter(s => s.coachId === coachId);
          const ids = new Set(sessions.map(s => s.id));
          return sessions.some(s => (s.status === 'open' || s.status === 'rest') && s.end > now) || Object.values(snapshot.tables.bookings).some(b => b.status === 'confirmed' && ids.has(b.sessionId));
        },
        get: async <K extends Table>(table: K, id: string) => {
          const value = snapshot.tables[table][id];
          return value === undefined ? undefined : clone(value) as Tables[K];
        },
        put: async <K extends Table>(table: K, value: Tables[K]) => {
          const copy = clone(value);
          (snapshot.tables[table] as Record<string, Tables[K]>)[value.id] = copy;
          writes.set(`${table}/${value.id}`, { table, id: value.id, data: copy });
        },
      };
      const result = await work(tx);
      if (writes.size === 0) return result;
      const payload = [...writes.values()];
      const [rawVersion] = oneRow(await this.executor.executePGSql({
        EnvId: this.envId,
        Sql: `SELECT public."ez_apply_writes"(${snapshot.version}, ${jsonbFromBase64(payload)})::text`,
      }));
      const committedVersion = Number(rawVersion);
      if (committedVersion === snapshot.version + 1) return result;
      if (committedVersion !== -1) throw new Error('Invalid PostgreSQL commit result');
      await delay(Math.min(100, 5 * 2 ** attempt) + Math.floor(Math.random() * 20));
    }
    throw Object.assign(new Error('PostgreSQL transaction retry limit exceeded'), { code: '40001' });
  }

  async list<K extends Table>(table: K, filter: Partial<Tables[K]>, limit: number): Promise<Tables[K][]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid query limit');
    const result = await this.executor.executePGSql({
      EnvId: this.envId,
      Sql: `SELECT data::text FROM ${sqlTable(table)} WHERE data @> ${jsonbFromBase64(filter)} ORDER BY id LIMIT ${limit}`,
    });
    return (result.Rows || []).map(row => {
      const values = JSON.parse(row);
      if (!Array.isArray(values) || typeof values[0] !== 'string') throw new Error('Unexpected PostgreSQL row');
      const value = JSON.parse(values[0]);
      if (!value || typeof value !== 'object' || typeof value.id !== 'string') throw new Error('Invalid stored record');
      return value as Tables[K];
    });
  }
}

let sharedStore: ManagerPostgresStore | undefined;
export function managerPostgresStore(): ManagerPostgresStore {
  if (!sharedStore) {
    const envId = process.env.EZ_ENV_ID;
    if (!envId) throw new Error('Missing EZ_ENV_ID');
    const app = CloudBase.init({ envId });
    sharedStore = new ManagerPostgresStore(app.database, envId);
  }
  return sharedStore;
}
