import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exceeds, scan } from '../src/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const { fixtures } = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

for (const fx of fixtures) {
  test(`${fx.kind}: ${fx.file} (${fx.technique})`, async () => {
    const r = await scan(path.join(ROOT, fx.file));
    assert.equal(r.summary.max, fx.max, `max severity; findings: ${JSON.stringify(r.findings.map((f) => [f.severity, f.rule, f.reason]))}`);
    for (const want of fx.expect) {
      const hit = r.findings.find((f) => f.rule === want.rule
        && (!want.mechanisms || want.mechanisms.every((m) => f.mechanisms?.includes(m)))
        && (want.page === undefined || f.page === want.page)
        && (!want.severity || f.severity === want.severity)
        && (!want.phrases || (want.phrases.length ? want.phrases.every((p) => f.phrases.includes(p)) : f.phrases.length === 0)));
      assert.ok(hit, `expected ${JSON.stringify(want)}; got ${JSON.stringify(r.findings, null, 1)}`);
    }
    if (fx.kind === 'benign') assert.equal(exceeds(r, 'high'), false, 'a benign fixture must not fail the default CI gate');
    else assert.equal(exceeds(r, 'medium'), fx.max !== 'low', 'a malicious fixture fails a medium gate unless it is a low-severity technique');
  });
}

test('the corpus covers every format and both kinds', () => {
  const formats = new Set(fixtures.map((f) => f.file.split('/')[0]));
  assert.deepEqual([...formats].sort(), ['docx', 'html', 'pdf', 'text']);
  for (const fmt of formats) {
    assert.ok(fixtures.some((f) => f.file.startsWith(fmt) && f.kind === 'benign'), `${fmt} has a benign fixture`);
    assert.ok(fixtures.some((f) => f.file.startsWith(fmt) && f.kind === 'malicious'), `${fmt} has a malicious fixture`);
  }
});
