# Security

fakeplane is a test double. Do not point it at production credentials and
do not put a real token in a scenario file.

`no_pii` treats seed emails and phones as values that must not show up in
effects. Failure output masks them. Internal Zendesk notes are skipped
unless the assertion names those effects. Do not weaken that default to
make a demo pass.

The GitHub Action fails the job when the naive agent is not blocked. That
check is the release gate for the action. `SECURITY.md` at the repo root
remains the GitHub security-policy file.

Scenarios and traces can contain copied prompts. Do not commit a customer
transcript.
