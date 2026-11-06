# Operations

`fakeplane up` serves the fakes and the control endpoints in `API.md`:
health, state, calls, effects, reset, faults, turn, and assert. Use reset
between cases. Do not reuse a long-lived server across unrelated scenarios
without reset, or the next agent sees the previous ticket.

`from-trace` writes a scenario file. Review it before committing. It can
carry text from the transcript.

The local image tag is `fakeplane:local`. Remove it with
`docker image rm fakeplane:local` when you want the disk back. Docker is
started for the task and is not a login item.

A failed assertion names the effect count and the call numbers. Fix the
agent or the scenario. Do not delete the assertion.
