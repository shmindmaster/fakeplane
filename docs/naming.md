# Why "fakeplane"

Checked on 2026-10-23 against the npm registry, PyPI and GitHub.

| Candidate | npm | PyPI | GitHub | Notes |
|---|---|---|---|---|
| `agentsim` | taken | taken | many repos | Generic and already used |
| `mockplane` | taken | free | | npm name taken |
| `replaybench` | free | free | 5 repos with the name | "Replay" puts it in the record/replay space this tool is deliberately not in |
| `simyard`, `stubyard`, `fakeyard` | free | free | | Less clear about what the tool does |
| `fakesaas`, `agentfakes`, `sandsaas`, `shamstack`, `egresstest` | free | free | | Longer, awkward or narrow |
| **`fakeplane`** | **free** | **free** | **no repo with the name** (one unrelated "FakePlanetarium") | Chosen |

Why it fits:

- **It is honest about what it is.** The backends are fakes, and the name says so. No one will mistake it for a staging environment.
- **"Plane" is the layer the agent operates in**, as a control plane is the layer that operates real infrastructure. Every backend the agent touches lives in this one plane, which records what it would have done.
- **It stays out of record/replay.** That space is crowded with small tools that freeze responses. fakeplane is about stateful fakes and side-effect assertions.
- **Short and typeable**: `npx fakeplane run`.

The PyPI name is free too, which leaves room for a Python client later.
