import { formatReport, runDemo, shouldColor } from './demo.js';

const HELP = `Usage: replyonce demo [--conversations N] [--seed N]

Runs a chaos simulation of a support agent with and without replyonce and prints
how many customer messages were answered twice. The same --seed always gives the
same counts. Set FORCE_COLOR=1 for colour when output is piped or recorded.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'demo') {
    console.log(HELP);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
  const opt = (name: string, fallback: number, min: number) => {
    const i = rest.indexOf(`--${name}`);
    const v = i >= 0 ? Number(rest[i + 1]) : fallback;
    if (!Number.isInteger(v) || v < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return v;
  };
  const report = await runDemo({ conversations: opt('conversations', 100, 1), seed: opt('seed', 7, 0) });
  console.log(formatReport(report, { color: shouldColor() }));
  return report.with.duplicateAnswers === 0 ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
