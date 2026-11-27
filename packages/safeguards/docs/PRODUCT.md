# Product

Per-prompt scores for 356 publicly collected system prompts against 23 written safeguards. The question is which safeguards real AI system prompts write down. It does not measure whether an agent obeys its prompt, how well the prompt is written, or what controls exist in the product's code. A low score means the text is silent, not that the product is unsafe.

- No prompt states half of the 23 safeguards. The highest score is 34 out of 100. Production-agent prompts have a median of 10. GPT Store prompts have a median of 0.
- Production prompts write down more. Cliff's delta is 0.614 (95% CI 0.491 to 0.729). The permutation *p* is 0.0001. Dropping every zero score leaves the delta at 0.667.
- The safeguards that separate the two groups are about acting: a human must approve, name what triggers stopping, cap spend or tokens or rate, and treat instructions inside user content as data.
- Five safeguards appear in no prompt: grounding answers in provided sources, logging actions and decisions, keeping that log tamper-evident, recording who did what and when, and naming a data-protection technique.

Full tables are in [RESULTS.md](RESULTS.md). Limits are in [DATA.md](DATA.md).

The study was first run with an earlier, now-archived prompt-scoring tool. Every per-prompt score and every summary statistic matches that tool. This repository adds the upstream path, source URL, and content hashes, and it corrects the source licence notes.

Citation: Hussain, S. (2026). *Agent prompt safeguards 2026: written safeguards in 356 AI system prompts* (Version 1.0.0) [Data set]. https://github.com/shmindmaster/safeguards

Write-up: https://saroshhussain.com/blog/what-356-ai-system-prompts-write-down
