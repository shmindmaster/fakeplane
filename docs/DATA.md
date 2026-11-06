# Data

A scenario file is the data. YAML or JSON. `fakeplane run <dir>` loads every
`.yaml`, `.yml`, and `.json` under the directory, skipping names that start
with `_` or `.`. A YAML file may hold several scenarios separated by `---`.

State paths the assertions read:

- `zendesk.tickets.<id>` and `zendesk.users.<id>`
- `slack.channels.<id>.messages`
- `linear.issues.<IDENTIFIER>`
- `generic.collections.<name>.<id>`

`fakeplane.config.yaml` in the working directory sets the default scenario
path, the agent command, and assertions appended to every scenario.

Nothing in the repository is customer data. The demo tickets and people are
synthetic. Trace fixtures under `test/fixtures/` are recorded shapes, not
live accounts.
