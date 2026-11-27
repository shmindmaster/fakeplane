/**
 * The npm package installs and runs on its own: pack it, install the tarball into an empty
 * directory, then run the CLI and import the library from there.
 */
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = (args, cwd) => execSync(`npm ${args}`, { cwd, encoding: 'utf8' });
const dir = mkdtempSync(path.join(tmpdir(), 'subtext-smoke-'));
try {
  const [{ filename, files }] = JSON.parse(npm(`pack --json --pack-destination "${dir}"`, ROOT));
  const shipped = files.map((f) => f.path);
  assert.ok(shipped.includes('bin/subtext-scan.mjs') && shipped.includes('src/index.d.ts') && shipped.includes('NOTICE'));
  assert.ok(!shipped.some((p) => p.startsWith('fixtures/') || p.startsWith('tests/')), 'fixtures and tests stay out of the package');

  npm('init -y', dir);
  npm(`install --no-audit --no-fund "${path.join(dir, filename)}"`, dir);
  const bin = path.join(dir, 'node_modules', 'subtext-scan', 'bin', 'subtext-scan.mjs');
  const fixture = path.join(ROOT, 'fixtures', 'pdf', 'supplier-certificate-hidden-note.pdf');

  const cli = spawnSync(process.execPath, [bin, fixture, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).summary.max, 'high');

  const lib = spawnSync(process.execPath, ['--input-type=module', '-e', `import { scan } from 'subtext-scan'; const r = await scan(${JSON.stringify(fixture)}); console.log(r.findings[0].rule);`], { cwd: dir, encoding: 'utf8' });
  assert.equal(lib.stdout.trim(), 'hidden-text', lib.stderr);
  console.log(`smoke ok: ${filename} (${shipped.length} files) installs, the CLI exits 1 on a high finding, and the library imports`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
