import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { postgresConfig, PostgresStore } from '../server/postgres-store';

test('PostgreSQL connection config fails closed and verifies TLS by default', () => {
  const env = { PGHOST: 'db.example', PGDATABASE: 'gym', PGUSER: 'ez_api', PGPASSWORD: 'test-only' };
  assert.throws(() => postgresConfig({}), /Missing PGHOST/);
  assert.deepEqual(postgresConfig(env).ssl, { rejectUnauthorized: true });
  assert.equal(postgresConfig({ ...env, EZ_PG_SSL: 'disable' }).ssl, false);
  assert.throws(() => postgresConfig({ ...env, EZ_PG_SSL: 'invalid' }), /Invalid/);
  assert.throws(() => postgresConfig({ ...env, PGPORT: 'NaN' }), /Invalid/);
});

test('PostgreSQL retries rolled-back serialization failures but not an unknown COMMIT outcome', async () => {
  for (const code of ['40001', '08006']) {
    let attempts = 0; let releases = 0; let rollbacks = 0;
    const pool = { connect: async () => {
      const attempt = ++attempts;
      return { query: async (sql: string) => {
        if (sql === 'COMMIT' && attempt === 1) throw Object.assign(new Error('failure'), { code });
        if (sql === 'ROLLBACK') rollbacks++;
        return { rows: [] };
      }, release: () => { releases++; } };
    } } as unknown as Pool;
    const result = new PostgresStore(pool).transaction(async () => 'ok');
    if (code === '40001') { assert.equal(await result, 'ok'); assert.equal(attempts, 2); }
    else { await assert.rejects(result, { code }); assert.equal(attempts, 1); }
    assert.equal(releases, attempts); assert.equal(rollbacks, 1);
  }
});

test('PostgreSQL discards connections whose rollback fails, without replaying the work', async () => {
  let attempts = 0; let discarded = false;
  const pool = { connect: async () => {
    attempts++;
    return { query: async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('disconnected');
      return { rows: [] };
    }, release: (discard: boolean) => { discarded = discard; } };
  } } as unknown as Pool;
  const error = Object.assign(new Error('serialization'), { code: '40001' });
  await assert.rejects(new PostgresStore(pool).transaction(async () => { throw error; }), { code: '40001' });
  assert.equal(attempts, 1); assert.equal(discarded, true);
});
