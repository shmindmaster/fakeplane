import type { ScopeState, Store, TransactResult } from '../types.js';

/**
 * The one Redis command replyonce uses, in ioredis' signature. For node-redis, pass
 * `{ eval: (script, n, ...args) => client.eval(script, { keys: args.slice(0, n), arguments: args.slice(n) }) }`.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisLike;
  /** Key prefix. Default `replyonce`. */
  prefix?: string;
  /** Expire idle scopes after this long. 0 disables expiry. Default 30 days. */
  keyTtlMs?: number;
  /** Optimistic retries under contention before giving up. Default 200. */
  maxRetries?: number;
}

const READ = `return redis.call('HMGET', KEYS[1], 's', 'v')`;

const CAS = `
local v = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 's', ARGV[2], 'v', v + 1)
local ttl = tonumber(ARGV[3])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

export class StoreContentionError extends Error {
  constructor(scope: string, attempts: number) {
    super(`replyonce: gave up on scope ${JSON.stringify(scope)} after ${attempts} contended attempts`);
    this.name = 'StoreContentionError';
  }
}

/**
 * Redis store. Each scope is one hash holding the state and a version. `transact` reads
 * both, decides locally, then writes with a compare-and-set Lua script, retrying on a lost
 * race. Works on a shared connection (no WATCH) and with Redis Cluster (one key per op).
 */
export class RedisStore implements Store {
  private readonly client: RedisLike;
  private readonly prefix: string;
  private readonly keyTtlMs: number;
  private readonly maxRetries: number;

  constructor(options: RedisStoreOptions) {
    if (!options?.client) throw new TypeError('replyonce: RedisStore needs a client');
    this.client = options.client;
    this.prefix = options.prefix ?? 'replyonce';
    this.keyTtlMs = options.keyTtlMs ?? 30 * 24 * 3_600_000;
    this.maxRetries = options.maxRetries ?? 200;
  }

  private redisKey(scope: string): string {
    return `${this.prefix}:{${scope}}`;
  }

  private async load(scope: string): Promise<{ state: ScopeState | null; version: number }> {
    const reply = (await this.client.eval(READ, 1, this.redisKey(scope))) as Array<string | null>;
    const raw = reply?.[0] ?? null;
    const version = reply?.[1] ? Number(reply[1]) : 0;
    return { state: raw ? (JSON.parse(raw) as ScopeState) : null, version };
  }

  async read(scope: string): Promise<ScopeState | null> {
    return (await this.load(scope)).state;
  }

  async transact<T>(scope: string, fn: (state: ScopeState | null) => TransactResult<T>): Promise<T> {
    const key = this.redisKey(scope);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const { state, version } = await this.load(scope);
      const { next, result } = fn(state);
      // A read-only decision was taken against one consistent snapshot, so it stands.
      if (!next) return result;
      const ok = await this.client.eval(CAS, 1, key, version, JSON.stringify(next), this.keyTtlMs);
      if (Number(ok) === 1) return result;
      const cap = Math.min(50, 2 ** Math.min(attempt, 6));
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
    throw new StoreContentionError(scope, this.maxRetries + 1);
  }
}
