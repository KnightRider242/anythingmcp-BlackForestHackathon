// SPDX-License-Identifier: AGPL-3.0-only
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const url = process.env.CODEBOUND_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
const backend = resolve(__dirname, '../../..');
const migrations = join(backend, 'prisma/migrations');
const target = '20261017140000_codebound_persistence';
const sql = readFileSync(join(migrations, target, 'migration.sql'), 'utf8');
const history = readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name < target).map(entry => entry.name).sort();

live('CODEBOUND migration review (disposable PostgreSQL schemas)', () => {
  const schemas: string[] = []; let client: Client; let upgrade: string;
  const identifier = (schema: string) => {
    if (!/^codebound_review_[a-f0-9]+$/.test(schema)) throw new Error('Invalid test schema');
    return `"${schema}"`;
  };
  async function freshSchema() {
    const schema = `codebound_review_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${identifier(schema)}`); schemas.push(schema);
    await client.query(`SET search_path TO ${identifier(schema)}`);
    return schema;
  }
  async function baseline() {
    for (const migration of history) await client.query(readFileSync(join(migrations, migration, 'migration.sql'), 'utf8'));
  }
  beforeAll(async () => {
    client = new Client({ connectionString: url }); await client.connect();
    upgrade = await freshSchema(); await baseline();
    await client.query(`INSERT INTO organizations(id,name,updated_at) VALUES ('org-a','Legacy A',now()),('org-b','Legacy B',now());
      INSERT INTO users(id,email,organization_id,updated_at) VALUES ('owner-a','a@example.invalid','org-a',now()),('owner-b','b@example.invalid','org-b',now());
      INSERT INTO connectors(id,user_id,organization_id,name,type,base_url,updated_at) VALUES
        ('connector-a','owner-a','org-a','Same name','REST','https://example.invalid',now()),
        ('connector-b','owner-b','org-b','Same name','REST','https://example.invalid',now());
      INSERT INTO mcp_tools(id,connector_id,name,description,parameters,endpoint_mapping,updated_at) VALUES
        ('tool-a','connector-a','same_read','Legacy','{}','{"method":"GET","path":"/read"}',now()),
        ('tool-b','connector-b','same_read','Legacy','{}','{"method":"GET","path":"/read"}',now());`);
  }, 30_000);
  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('ROLLBACK'); await client.query('SET search_path TO public');
      for (const schema of schemas.reverse()) await client.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
    } finally { await client.end(); }
  });

  it('can roll back the entire new migration without changing legacy data', async () => {
    await client.query('BEGIN');
    try {
      // Test the body inside an outer transaction; the production wrapper is
      // exercised separately through Prisma's actual deployment engine.
      await client.query(sql.replace(/^BEGIN;\s*/m, '').replace(/^COMMIT;\s*$/m, ''));
      expect((await client.query("SELECT to_regclass('codebound_scripts') AS name")).rows[0].name).not.toBeNull();
    } finally { await client.query('ROLLBACK'); }
    expect((await client.query("SELECT to_regclass('codebound_scripts') AS name")).rows[0].name).toBeNull();
    expect((await client.query('SELECT count(*)::int AS count FROM connectors')).rows[0].count).toBe(2);
  });

  it('upgrades populated pre-CODEBOUND tables without rewriting existing rows', async () => {
    const before = await client.query(`SELECT jsonb_build_object('connector',to_jsonb(c),'tool',to_jsonb(t)) AS row
      FROM connectors c JOIN mcp_tools t ON t.connector_id=c.id ORDER BY c.id`);
    await client.query(sql);
    const after = await client.query(`SELECT jsonb_build_object('connector',to_jsonb(c),'tool',to_jsonb(t)) AS row
      FROM connectors c JOIN mcp_tools t ON t.connector_id=c.id ORDER BY c.id`);
    expect(after.rows).toEqual(before.rows);
    const indexes = await client.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1', [upgrade]);
    expect(indexes.rows.map(row => row.indexname)).toEqual(expect.arrayContaining([
      'connectors_id_organization_id_user_id_key', 'mcp_tools_id_connector_id_key',
      'codebound_scripts_id_organization_id_owner_user_id_key',
    ]));
  });

  it('also applies complete migration history to an empty schema', async () => {
    await freshSchema(); await baseline(); await client.query(sql);
    expect((await client.query('SELECT count(*)::int AS count FROM codebound_script_runs')).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='codebound_script_runs'::regclass AND tgname='codebound_run_receipt_guard'")).rows[0].count).toBe(1);
  }, 30_000);

  it('does not leave partially applied DDL after a Prisma migration failure', async () => {
    const schema = await freshSchema();
    const directory = mkdtempSync(join(backend, '.codebound-migration-review-'));
    try {
      const migrationPath = join(directory, 'migrations'); const probe = join(migrationPath, '20261017140000_atomicity_probe');
      mkdirSync(probe, { recursive: true });
      writeFileSync(join(migrationPath, 'migration_lock.toml'), 'provider = "postgresql"\n');
      // Exercise Prisma's execution behavior with the production migration's
      // transaction policy; injected failure must not leave any created table.
      const wrapped = /^BEGIN;/m.test(sql) && /^COMMIT;/m.test(sql);
      writeFileSync(join(probe, 'migration.sql'), `${wrapped ? 'BEGIN;' : ''}\nCREATE TABLE codebound_atomicity_probe(id integer);\nSELECT 1/0;\n${wrapped ? 'COMMIT;' : ''}`);
      const config = join(directory, 'prisma.config.ts');
      writeFileSync(config, `import { defineConfig } from 'prisma/config'; export default defineConfig({schema:${JSON.stringify(join(backend, 'prisma/schema.prisma'))},datasource:{url:process.env.DATABASE_URL!},migrations:{path:${JSON.stringify(migrationPath)}}});`);
      const database = new URL(url!); database.searchParams.set('schema', schema);
      const cli = createRequire(join(backend, 'package.json')).resolve('prisma/build/index.js');
      let diagnostic = '';
      try {
        execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
          cwd: backend, env: { ...process.env, DATABASE_URL: database.href }, timeout: 30_000, windowsHide: true, stdio: 'pipe',
        });
      } catch (error) {
        const failure = error as { stdout?: Buffer; stderr?: Buffer };
        diagnostic = String(failure.stdout ?? '') + String(failure.stderr ?? '');
      }
      // A config/connection/CLI failure is not proof of migration rollback.
      expect(diagnostic).toContain('Applying migration `20261017140000_atomicity_probe`');
      // With an explicit transaction Prisma may report the aborted-transaction
      // error from its attempt to record the original SQL failure.
      expect(diagnostic).toMatch(/division by zero|current transaction is aborted/);
      const failed = await client.query("SELECT finished_at FROM _prisma_migrations WHERE migration_name='20261017140000_atomicity_probe'");
      expect(failed.rows).toEqual([{ finished_at: null }]);
      expect((await client.query("SELECT to_regclass('codebound_atomicity_probe') AS name")).rows[0].name).toBeNull();
    } finally {
      // Delete only the exact temporary directory created above in this workspace.
      if (dirname(resolve(directory)) === backend && basename(directory).startsWith('.codebound-migration-review-')) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
