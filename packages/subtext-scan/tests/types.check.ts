// Compiled by `npm run typecheck` (never run): the published types describe the API a TypeScript caller sees.
import { exceeds, findInstructionPhrases, scan, type Finding, type ScanResult } from 'subtext-scan';

const result: ScanResult = await scan('invoice.pdf', { minFontPt: 3 });
const high: Finding[] = result.findings.filter((f) => f.severity === 'high');
const blocked: boolean = exceeds(result, 'medium');
const where: number | null = high[0]?.page ?? null;
const ids: string[] = findInstructionPhrases('Ignore all previous instructions').map((h) => h.id);
void [blocked, where, ids];
