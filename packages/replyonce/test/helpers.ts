import { randomUUID } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { MemoryStore } from '../src/index.js';
import type { Store } from '../src/index.js';
import { PostgresStore } from '../src/stores/postgres.js';
import { RedisStore } from '../src/stores/redis.js';

interface StoreCase {
  name: string;
  make: () => Promise<Store>;
}

const cleanups: Array<() => Promise<void>> = [];

function cases(): StoreCase[] {
  const list: StoreCase[] = [{ name: 'memory', make: async () => new MemoryStore() }];
  const pgUrl = process.env.REPLYONCE_PG_URL;
  if (pgUrl) {
    let shared: Promise<PostgresStore> | undefined;
    list.push({
      name: 'postgres',
      make: () =>
        (shared ??= (async () => {
          const pg = await import('pg');
          const pool = new pg.default.Pool({ connectionString: pgUrl, max: 30 });
          cleanups.push(() => pool.end());
          const store = new PostgresStore({ pool, table: 'replyonce_test_scopes' });
          await store.migrate();
          return store;
        })()),
    });
  }
  const redisUrl = process.env.REPLYONCE_REDIS_URL;
  if (redisUrl) {
    let shared: Promise<RedisStore> | undefined;
    list.push({
      name: 'redis',
      make: () =>
        (shared ??= (async () => {
          const { Redis } = await import('ioredis');
          const client = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
          cleanups.push(async () => {
            client.disconnect();
          });
          return new RedisStore({ client, prefix: `replyonce-test-${randomUUID().slice(0, 8)}` });
        })()),
    });
  }
  return list;
}

/** Run a suite once per configured store. */
export function eachStore(title: string, fn: (make: () => Promise<Store>, name: string) => void): void {
  for (const c of cases()) {
    describe(`${title} [${c.name}]`, () => {
      fn(c.make, c.name);
    });
  }
}

afterAll(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Unique scope name so tests never share state, even on a shared database. */
export function uid(prefix = 'conv'): string {
  return `${prefix}-${randomUUID()}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `cond()` holds. A fixed sleep is not enough for a store round trip on a slow runner. */
export async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time');
    await sleep(2);
  }
}

/** A controllable clock. */
export function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** A fake provider that records every effect that really happened. */
export function counter() {
  const hits = new Map<string, number>();
  return {
    hit(key: string) {
      hits.set(key, (hits.get(key) ?? 0) + 1);
    },
    count(key: string) {
      return hits.get(key) ?? 0;
    },
    get total() {
      let n = 0;
      for (const v of hits.values()) n += v;
      return n;
    },
    maxPerKey() {
      return Math.max(0, ...hits.values());
    },
  };
}
