import { describe, expect, it } from 'vitest';
import { formatReport, runDemo, shouldColor } from '../src/demo.js';
import { eachStore } from './helpers.js';

// CI sets this to run each seed several times: timing differs per run, so a rare
// interleaving that a single pass misses shows up across repeats.
const repeat = Math.max(1, Number(process.env.REPLYONCE_DEMO_REPEAT ?? 1));

describe('demo on simulated time (the CLI)', () => {
  it('gives the same counts every time for a seed', async () => {
    for (const seed of [1, 7, 42]) {
      const first = await runDemo({ conversations: 150, seed });
      const second = await runDemo({ conversations: 150, seed });
      expect(second).toEqual(first);
      expect(first.without.duplicateAnswers).toBeGreaterThan(0);
      expect(first.with.duplicateAnswers).toBe(0);
      expect(first.with.unanswered).toBe(0);
    }
  });

  it('colours the report only when asked, and FORCE_COLOR beats NO_COLOR and pipes', async () => {
    const report = await runDemo({ conversations: 40, seed: 3 });
    const ansi = /\x1b\[\d+m/;
    expect(formatReport(report)).not.toMatch(ansi);
    expect(formatReport(report, { color: true })).toMatch(ansi);
    expect(formatReport(report, { color: true }).replace(/\x1b\[\d+m/g, '')).toBe(formatReport(report));
    expect(shouldColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: '' }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(shouldColor({}, true)).toBe(true);
    expect(shouldColor({}, false)).toBe(false);
  });

  it('gives different seeds different runs', async () => {
    const a = await runDemo({ conversations: 150, seed: 1 });
    const b = await runDemo({ conversations: 150, seed: 2 });
    expect(b.faults.without).not.toEqual(a.faults.without);
  });
});

eachStore('chaos demo', (makeStore, name) => {
  const conversations = name === 'memory' ? 200 : 60;
  for (const seed of [1, 2, 3]) {
    for (let i = 1; i <= repeat; i++) {
      const label = repeat > 1 ? ` (pass ${i}/${repeat})` : '';
      it(`seed ${seed}${label}: no customer message answered twice, none left unanswered`, async () => {
        const report = await runDemo({ conversations, seed, store: await makeStore() });
        expect(report.without.duplicateAnswers).toBeGreaterThan(0);
        expect(report.with.duplicateAnswers).toBe(0);
        expect(report.with.unanswered).toBe(0);
      });
    }
  }
});
