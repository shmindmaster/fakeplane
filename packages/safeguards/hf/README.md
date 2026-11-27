---
license: cc-by-4.0
language:
  - en
pretty_name: Agent prompt safeguards 2026
size_categories:
  - n<1K
task_categories:
  - text-classification
tags:
  - ai-safety
  - agents
  - system-prompts
  - guardrails
  - prompt-injection
  - human-in-the-loop
configs:
  - config_name: prompts
    default: true
    data_files: data/prompts.csv
  - config_name: controls
    data_files: data/controls.csv
---

# Agent prompt safeguards 2026

Per-prompt scores for 356 publicly collected AI system prompts against 23 written safeguards: 83 prompts behind production agent products and 273 GPT Store prompts. Each row carries the source collection, pinned commit, upstream path, a link to the file, content hashes, an overall score, 8 group scores and a 0/1 flag for each safeguard.

**Prompt text is not included.** The prompts belong to the vendors and GPT authors who wrote them. Use `source_url` to read a prompt at its pinned commit and `content_sha256` to verify it.

## Key results

- No prompt states half of the 23 safeguards; the highest score is 34/100.
- Median score: 10 for production agent prompts, 0 for GPT Store prompts. Cliff's delta 0.614 (95% CI 0.491 to 0.729), permutation *p* = 0.0001.
- "A human must approve": 18/83 vs 0/273. "Name what triggers stopping": 21/83 vs 0/273. "Cap spend, tokens, or rate": 5/83 vs 0/273.
- 5 of 23 safeguards appear in no prompt, including every audit safeguard.

## Limits

Scores measure what a prompt's text states, matched by regular expressions. They do not measure runtime behaviour, prompt quality, or controls implemented in code. The source collections are of unknown completeness and lean toward coding assistants.

## Source, methodology and code

Everything, including the datasheet, methodology and the script that re-runs the study from the pinned sources, is at **https://github.com/shmindmaster/safeguards**. Write-up: https://saroshhussain.com/blog/what-356-ai-system-prompts-write-down

## Licence and citation

Data: CC BY 4.0. Code (in the GitHub repository): Apache-2.0.

> Hussain, S. (2026). *Agent prompt safeguards 2026: written safeguards in 356 AI system prompts* (Version 1.0.0) [Data set]. https://github.com/shmindmaster/safeguards
