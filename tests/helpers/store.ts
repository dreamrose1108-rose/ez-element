import { after } from 'node:test';
import { Pool } from 'pg';
import { MemoryStore } from '../../server/memory-store';
import { pgTables, PostgresStore, sqlTable } from '../../server/postgres-store';
import { Store } from '../../server/model';

export const pgTest = process.env.EZ_PG_TEST_RUN === '1';
function localTestPool(url: string | undefined): Pool {
  if (!url) throw new Error('Missing isolated test database URL');
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/ez_test_')) throw new Error('Tests require an isolated local database');
  return new Pool({ connectionString: url, max: 12 });
}
export const runtimePool = pgTest ? localTestPool(process.env.EZ_TEST_PG_URL) : undefined;
export const adminPool = pgTest ? localTestPool(process.env.EZ_TEST_PG_ADMIN_URL) : undefined;
after(async () => { await runtimePool?.end(); await adminPool?.end(); });
export async function fixtureStore(): Promise<Store> {
  if (!pgTest) return new MemoryStore();
  await adminPool!.query(`TRUNCATE ${pgTables.map(sqlTable).join(', ')}`);
  return new PostgresStore(runtimePool!);
}
