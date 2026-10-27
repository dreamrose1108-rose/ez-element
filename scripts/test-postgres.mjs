import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

// Always create a fresh, local cluster. Never consume the user's PG* variables
// or run TRUNCATE against an existing cloud environment.
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const root = await mkdtemp(join(tmpdir(), 'form-flow-pg-'));
const password = randomBytes(24).toString('hex');
const database = 'ez_test_business';
const logs = [];
const instance = new EmbeddedPostgres({ databaseDir: join(root, 'db'), port, user: 'postgres', password,
  persistent: false, authMethod: 'scram-sha-256',
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${root}`],
  onLog: message => logs.push(String(message)), onError: message => logs.push(String(message)),
});
let admin;
try {
  await instance.initialise();
  await instance.start();
  await instance.createDatabase(database);
  admin = instance.getPgClient(database, '127.0.0.1');
  await admin.connect();
  await admin.query("CREATE ROLE ez_api LOGIN PASSWORD '" + password + "'");
  await admin.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN');
  for (const file of ['001_schema.sql', '002_runtime_permissions.sql']) {
    await admin.query(await readFile(`database/postgres/${file}`, 'utf8'));
  }
  // Verify rerunning the setup is safe too.
  for (const file of ['001_schema.sql', '002_runtime_permissions.sql']) {
    await admin.query(await readFile(`database/postgres/${file}`, 'utf8'));
  }
  console.log('Isolated PostgreSQL ready; running business + SQL permission/concurrency tests.');
  const base = `127.0.0.1:${port}/${database}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/business.test.ts', 'tests/postgres.integration.ts'], {
    stdio: 'inherit', env: { ...process.env, EZ_PG_TEST_RUN: '1',
      EZ_TEST_PG_URL: `postgresql://ez_api:${password}@${base}`,
      EZ_TEST_PG_ADMIN_URL: `postgresql://postgres:${password}@${base}`,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} catch (error) {
  // The log ring only contains this disposable local database, never cloud secrets.
  console.error(logs.slice(-12).join('\n'));
  throw error;
} finally {
  await admin?.end();
  await instance.stop();
  await rm(root, { recursive: true, force: true });
}
