import type { ScopeState, Store, TransactResult } from '../types.js';

/** The subset of `pg.PoolClient` replyonce uses. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error | boolean): void;
}

/** The subset of `pg.Pool` replyonce uses. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresStoreOptions {
  pool: PgPoolLike;
  /** Table name, optionally schema-qualified. Default `replyonce_scopes`. */
  table?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function quoteTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2 || !parts.every((p) => IDENT.test(p))) {
    throw new TypeError(`replyonce: invalid table name ${JSON.stringify(table)}`);
  }
  return parts.map((p) => `"${p}"`).join('.');
}

/** DDL for the store's table. Run it once (or call `migrate()`). */
export function postgresSchemaSql(table = 'replyonce_scopes'): string {
  const t = quoteTable(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (`,
    `  scope text PRIMARY KEY,`,
    `  state jsonb NOT NULL,`,
    `  version bigint NOT NULL DEFAULT 0,`,
    `  updated_at timestamptz NOT NULL DEFAULT now()`,
    `);`,
  ].join('\n');
}

/**
 * Postgres store. Each operation is one transaction holding the scope row's lock
 * (`SELECT ... FOR UPDATE`), so concurrent workers on one scope are serialized and
 * workers on different scopes do not contend.
 */
export class PostgresStore implements Store {
  private readonly pool: PgPoolLike;
  private readonly table: string;
  readonly tableName: string;

  constructor(options: PostgresStoreOptions) {
    if (!options?.pool) throw new TypeError('replyonce: PostgresStore needs a pool');
    this.pool = options.pool;
    this.tableName = options.table ?? 'replyonce_scopes';
    this.table = quoteTable(this.tableName);
  }

  /**
   * Creates the table if it does not exist. Safe to call from several workers at once:
   * `CREATE TABLE IF NOT EXISTS` alone is not, because two sessions can both pass the
   * existence check and one then fails on the catalog's unique index, so concurrent
   * migrations of the same table are serialized with a transaction-scoped advisory lock.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`replyonce:migrate:${this.tableName}`]);
      await client.query(postgresSchemaSql(this.tableName));
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr as Error;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async read(scope: string): Promise<ScopeState | null> {
    const { rows } = await this.pool.query(`SELECT state FROM ${this.table} WHERE scope = $1`, [scope]);
    return (rows[0]?.state as ScopeState | undefined) ?? null;
  }

  async transact<T>(scope: string, fn: (state: ScopeState | null) => TransactResult<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      let { rows } = await client.query(`SELECT state FROM ${this.table} WHERE scope = $1 FOR UPDATE`, [scope]);
      let exists = rows.length > 0;
      const { next, result } = fn(exists ? ((rows[0]!.state as ScopeState) ?? null) : null);
      if (next) {
        if (!exists) {
          // Another transaction may insert the same scope first; if so, re-run under its lock.
          const ins = await client.query(
            `INSERT INTO ${this.table} (scope, state) VALUES ($1, $2::jsonb) ON CONFLICT (scope) DO NOTHING RETURNING scope`,
            [scope, JSON.stringify(next)],
          );
          if (ins.rows.length === 0) {
            ({ rows } = await client.query(`SELECT state FROM ${this.table} WHERE scope = $1 FOR UPDATE`, [scope]));
            exists = true;
            const again = fn((rows[0]?.state as ScopeState | undefined) ?? null);
            if (again.next) {
              await client.query(
                `UPDATE ${this.table} SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE scope = $1`,
                [scope, JSON.stringify(again.next)],
              );
            }
            await client.query('COMMIT');
            return again.result;
          }
        } else {
          await client.query(
            `UPDATE ${this.table} SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE scope = $1`,
            [scope, JSON.stringify(next)],
          );
        }
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** Delete scopes untouched for longer than `olderThanMs`. Returns the number removed. */
  async purge(olderThanMs: number): Promise<number> {
    const { rows } = await this.pool.query(
      `WITH d AS (DELETE FROM ${this.table} WHERE updated_at < now() - ($1::double precision * interval '1 millisecond') RETURNING 1) SELECT count(*)::int AS n FROM d`,
      [olderThanMs],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
