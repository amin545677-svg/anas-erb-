# ANAS ERP — Shared Sync Safety Gate (V42 production baseline)

## Purpose

This document records the verified gap between the current per-user snapshot backup and the required multi-phone wholesale-distribution workflow. It is a design/acceptance gate, not a claim that shared sync has been implemented.

## Verified current behavior

- `index.html` uses local `AppData` persistence; the generic webhook path sends a full serialized application state.
- The Firebase snapshot Worker stores one document at `users/{uid}/snapshots/latest`. It validates payload structure and applies Firestore update-time preconditions when a revision is supplied.
- `firebase/firestore.rules` authorizes each signed-in user only for their own `users/{userId}/snapshots/{snapshotId}` documents.
- The UI explicitly describes Firebase upload as a manual backup, not automatic synchronization; restore replaces the local app state after confirmation.
- Therefore this is not yet a verified shared organization database. Do not use the snapshot upload/download flow as a substitute for multi-user transaction sync.

## Required target model

1. **Organization identity**: each record belongs to a stable `orgId`; user membership and role are validated server-side. A client-supplied org ID alone is never authorization.
2. **Operation-based writes**: sales, collections, returns, transfers, trip status changes and settlement are submitted as uniquely identified operations. Never treat a whole-device `AppData` blob as a concurrent merge unit.
3. **Idempotency**: every mutation carries an operation ID generated once on the client. Retrying the same operation must not create a second invoice, collection, stock movement or transfer.
4. **Atomic business invariants**: stock deductions, invoice/paid/remaining consistency, truck loading, return acceptance and cash settlement must be checked atomically by the trusted backend or transaction mechanism.
5. **Conflict behavior**: stale revisions must return an explicit conflict; clients must not silently overwrite newer data or automatically retry destructive writes.
6. **Offline queue**: pending operations remain durable locally, have visible pending/synced/failed states, and are replayed idempotently after connectivity returns. A conflict requires reconciliation, not silent last-write-wins.
7. **Audit trail**: record operation ID, organization, actor, device, timestamp, entity, before/after or business delta, and outcome. Audit records are append-only to ordinary users.
8. **Role enforcement**: UI hiding is not security. Backend rules enforce admin, warehouse, truck salesperson and cashier permissions.
9. **Backup remains separate**: snapshots are recovery artifacts, not the live shared database. Test restore into a disposable/test organization before production restore.
10. **Payload limits**: the current Worker limits snapshots to 700 KiB. Larger business histories need a deliberate export/chunking/retention design; never bypass the limit by silently truncating data.

## Mandatory acceptance tests before any production rollout

- Two authenticated users in the same organization can see authorized shared changes; users from another organization cannot.
- Two devices submit the same sale operation ID: exactly one invoice and one stock deduction exist.
- Two devices attempt to sell the last unit: total accepted quantity never exceeds available stock.
- An old client revision cannot overwrite a newer state.
- Offline sale/collection queues survive reload, then sync once after reconnect.
- Failed network request is safely retryable; no duplicate cash or inventory movements.
- Truck load, trip delivery, returns and settlement preserve cross-ledger invariants.
- Unauthorized role cannot change prices, users, warehouse stock, debt adjustments or settlement.
- Restore creates a recoverable local backup, validates the incoming snapshot, and rolls back fully if local persistence fails.
- Existing V42 regression and safety checks pass; test output and commit SHA are attached to the PR.

## Scope and release guardrails

- Keep production `main/index.html` identity at V42 unless a separate, reviewed version reconciliation explicitly authorizes a change.
- Keep PR #228 (AI prompt diagnostics) separate from this work.
- No production deployment or merge based solely on static tests or a Worker health check.
- Do not write test records to the live business account. Use isolated test users/data.
- This document does not implement shared sync and does not authorize a destructive schema migration.
