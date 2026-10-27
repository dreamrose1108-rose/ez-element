import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagerPostgresStore, PGSqlExecutor } from '../server/manager-postgres-store';
import { pgTables } from '../server/postgres-store';
import { Table } from '../server/model';

class FakeExecutor implements PGSqlExecutor {
  version = 0;
  conflictOnce = false;
  tables = Object.fromEntries(pgTables.map(table => [table, {}])) as Record<Table, Record<string, Record<string, unknown>>>;

  async executePGSql({ Sql }: { Sql: string }) {
    if (Sql.startsWith('SELECT version::text')) {
      return { AffectedRows: 0, Columns: ['version', 'state'], Rows: [JSON.stringify([
        String(this.version), JSON.stringify(this.tables),
      ])] };
    }
    if (Sql.startsWith('SELECT public."ez_apply_writes"')) {
      const match = Sql.match(/ez_apply_writes"\((\d+), convert_from\(decode\('([^']+)'/);
      assert.ok(match);
      if (this.conflictOnce) {
        this.conflictOnce = false;
        this.version++;
        return { AffectedRows: 0, Columns: ['ez_apply_writes'], Rows: [JSON.stringify(['-1'])] };
      }
      assert.equal(Number(match[1]), this.version);
      const writes = JSON.parse(Buffer.from(match[2]!, 'base64').toString('utf8')) as { table: Table; id: string; data: Record<string, unknown> }[];
      for (const write of writes) this.tables[write.table][write.id] = structuredClone(write.data);
      this.version++;
      return { AffectedRows: 0, Columns: ['ez_apply_writes'], Rows: [JSON.stringify([String(this.version)])] };
    }
    if (Sql.startsWith('SELECT data::text')) {
      const table = Sql.match(/FROM public\."ez_(\w+)"/)?.[1] as Table;
      const encoded = Sql.match(/decode\('([^']+)'/)?.[1];
      const limit = Number(Sql.match(/LIMIT (\d+)$/)?.[1]);
      assert.ok(table && encoded && Number.isInteger(limit));
      const filter = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
      const rows = Object.values(this.tables[table]).filter(value =>
        Object.entries(filter).every(([key, expected]) => value[key] === expected),
      ).slice(0, limit).map(value => JSON.stringify([JSON.stringify(value)]));
      return { AffectedRows: 0, Columns: ['data'], Rows: rows };
    }
    throw new Error(`Unexpected SQL: ${Sql}`);
  }
}

test('manager PostgreSQL store commits and lists records through ExecutePGSql', async () => {
  const executor = new FakeExecutor();
  const store = new ManagerPostgresStore(executor, 'test-env');
  await store.transaction(async tx => {
    assert.equal(await tx.get('users', 'member-1'), undefined);
    await tx.put('users', { id: 'member-1', name: 'Rose', phone: '13800000000', roles: ['student'], status: 'active' });
  });
  assert.equal(executor.version, 1);
  assert.deepEqual(await store.list('users', { status: 'active' }, 10), [
    { id: 'member-1', name: 'Rose', phone: '13800000000', roles: ['student'], status: 'active' },
  ]);
});

test('manager PostgreSQL store retries an optimistic version conflict', async () => {
  const executor = new FakeExecutor();
  executor.conflictOnce = true;
  const store = new ManagerPostgresStore(executor);
  let attempts = 0;
  await store.transaction(async tx => {
    attempts++;
    await tx.put('settings', { id: 'store', bookingDays: 14, privateCancelHours: 12, groupCancelHours: 2, cutoffMinutes: 60 });
  });
  assert.equal(attempts, 2);
  assert.equal(executor.version, 2);
  assert.equal(executor.tables.settings.store!.bookingDays, 14);
});
