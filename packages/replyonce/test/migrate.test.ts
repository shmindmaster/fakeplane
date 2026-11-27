import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/stores/postgres.js';

const pgUrl = process.env.REPLYONCE_PG_URL;

describe.skipIf(!pgUrl)('PostgresStore.migrate', () => {
  it('lets many workers migrate the same fresh table at once', async () => {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: pgUrl, max: 20 });
    const table = `replyonce_migrate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      const workers = Array.from({ length: 10 }, () => new PostgresStore({ pool, table }));
      await expect(Promise.all(workers.map((w) => w.migrate()))).resolves.toHaveLength(10);
      await workers[0]!.transact('scope', () => ({ next: { effects: {} } as never, result: undefined }));
      expect(await workers[1]!.read('scope')).not.toBeNull();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}"`);
      await pool.end();
    }
  });
});
