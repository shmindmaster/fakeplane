import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs the built CLI (`npm run build` first; CI builds before testing).
const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
const run = (args: string[], extra: Record<string, string | undefined>) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
};

describe.skipIf(!existsSync(cli))('replyonce demo CLI', () => {
  it('prints the same report for the same seed in separate processes', () => {
    const args = ['demo', '--conversations', '80', '--seed', '11'];
    const first = run(args, { FORCE_COLOR: undefined, NO_COLOR: '1' });
    const second = run(args, { FORCE_COLOR: undefined, NO_COLOR: '1' });
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it('honours FORCE_COLOR when output is piped', () => {
    const ansi = /\x1b\[\d+m/;
    expect(run(['demo', '--conversations', '20'], { FORCE_COLOR: '1' }).stdout).toMatch(ansi);
    expect(run(['demo', '--conversations', '20'], { FORCE_COLOR: '0', NO_COLOR: undefined }).stdout).not.toMatch(ansi);
    expect(run(['demo', '--conversations', '20'], { FORCE_COLOR: undefined, NO_COLOR: undefined }).stdout).not.toMatch(ansi);
  });
});
