# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on [shmindmaster/fakeplane](https://github.com/shmindmaster/fakeplane/security/advisories/new). Don't open a public issue for security problems. You should get a response within 7 days.

Supported versions: the latest release on `main`.

## Threat model

fakeplane is a local test tool. Keep these in mind:

- **Scenario files are code.** `agent.command` runs a shell command, `script` assertions and `agent.module` import JavaScript. Only run scenarios and configs you trust, just as you would only run test files you trust.
- **`fakeplane up` has no authentication.** It binds to `127.0.0.1` by default. Anyone who can reach it can read recorded data and reset state. Don't bind it to a public interface (`--host 0.0.0.0`) on a shared network.
- **Recorded data may contain whatever your agent sent.** `--json` reports and `--record` files include call inputs and outputs. If your scenarios use real data, treat those files as sensitive. Bundled fixtures are synthetic.
- **`from-trace` redaction is best-effort.** It replaces emails, phone numbers, card numbers, SSNs and IBANs, but not names, addresses or free-text identifiers. Review generated scenarios before committing them.
- **The fakes never call real services.** If your agent still reaches a production API during a run, its base URL is not pointed at fakeplane.
