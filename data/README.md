# Demo data

System of record: `beneficiaries.json`, `clients.json`, `funding_accounts.json`, `investments.json`. Copy unchanged from the reference framework (temporal-sa/oai-temporal-wealth-management).

Where the workers keep the data depends on `DEMO_DATA_STORE`:

- `file` (the default): a demo run changes these files, and every browser shares them. Reset with `git checkout data/`.
- `redis`: each browser session gets its own copy in Redis, starting from these files, and the files never change. A
  copy expires a day after its last change.

See [Sharing one demo](../README.md#sharing-one-demo).
