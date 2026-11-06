# Product

Stateful fakes of the systems an agent acts on: a Zendesk-style helpdesk,
Slack, Linear, and any HTTP/JSON API. You script the conversation, inject
faults (timeouts that actually committed, 429s, duplicate webhooks), and
assert on the side effects: one reply, no refund above a limit, no customer
contact details in Slack.

Record/replay tools freeze responses. fakeplane keeps state. A ticket you
update stays updated. A reply that timed out is still on the ticket when
the agent reads it back.

The name was chosen on 2026-10-23 because `fakeplane` was free on npm, PyPI,
and GitHub. The backends are fakes, and the name says so. "Plane" is the
layer the agent operates in. The name stays out of the record/replay space
on purpose.

The bundled demo runs three scenarios against a naive support agent and a
careful one. The naive agent double-replies, double-refunds, and leaks an
email and a phone into Slack. The careful agent passes.
