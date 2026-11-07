---
name: debug
description: Debug NanoClaw service, container, routing, and delivery problems using the current runtime and its operating runbooks.
---

# NanoClaw debugging

Use the current deployment runbook and `docs/build-and-runtime.md` for the
runtime architecture, test commands, and outbound-delivery recovery. This
Yente overlay does not support WhatsApp messaging; the separate Msgvault
WhatsApp archive has its own runbook in the server configuration repository.

Start with service and journal evidence. On Yente's server:

```bash
systemctl status nanoclaw.service --no-pager
journalctl -u nanoclaw.service --since '1 hour ago' --no-pager
```

For an unavailable adapter, check the channel startup state and credentials
for the intended supported channel. The delivery ledger distinguishes a
starting channel's retry, an explicitly failed route, and an `unknown`
outcome where the platform may have accepted a message. Do not infer success
from a missing platform message ID, and do not blindly replay an unknown or
partially delivered message.

Session outbound messages and delivery outcomes use separate SQLite databases
under the runtime's `data/v2-sessions/<agent>/<session>/`. Follow the
**Reconciling outbound delivery** section of `docs/build-and-runtime.md` to
inspect a quarantine and, after checking the destination, record delivery or
requeue a message. A requeue is rejected if the source session is inactive.
Retain outbox attachments until the outcome is resolved.

For container startup and mounts, inspect the relevant runtime journal and
container logs, then compare the active mounts and runtime configuration with
the deployment runbook. Avoid printing credentials or removing session data.
Follow the server repository rules for service and provider changes.
