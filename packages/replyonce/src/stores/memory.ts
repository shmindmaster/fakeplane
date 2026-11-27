import type { ScopeState, Store, TransactResult } from '../types.js';

/**
 * Single-process store. Atomic because `transact` reads, decides and writes in one
 * synchronous step. State is kept as JSON so it behaves like the shared stores.
 * Use it for tests, demos and single-instance deployments; it is lost on restart.
 */
export class MemoryStore implements Store {
  private readonly data = new Map<string, string>();

  async transact<T>(scope: string, fn: (state: ScopeState | null) => TransactResult<T>): Promise<T> {
    const raw = this.data.get(scope);
    const { next, result } = fn(raw === undefined ? null : (JSON.parse(raw) as ScopeState));
    if (next) this.data.set(scope, JSON.stringify(next));
    return result;
  }

  async read(scope: string): Promise<ScopeState | null> {
    const raw = this.data.get(scope);
    return raw === undefined ? null : (JSON.parse(raw) as ScopeState);
  }

  /** Number of scopes held. */
  get size(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }
}
