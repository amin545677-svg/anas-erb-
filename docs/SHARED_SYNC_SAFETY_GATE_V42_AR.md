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


## Additional code-inspection note (2026-10-28)

A targeted scan of the current production `index.html` (blob SHA `3919bd7d2832c321a80f72adb6bbf0f07d35bb61`) found:
- Primary persistence reads/writes the whole application state through `localStorage` under `ANAS_THE_ENTERPRISE_V11_OFFLINE`.
- No obvious `orgId`, `organizationId`, `tenantId`, `operationId`, `idempotencyKey`, or named offline-operation queue symbol was found in the scanned source.
- This is a targeted source scan, not proof that no equivalent mechanism exists under another name. Treat organization scoping and idempotent offline operations as unverified until traced end-to-end.
- Do not add a superficial `orgId` field or queue in the UI alone: authorization, transaction semantics and duplicate prevention must be enforced by the trusted persistence layer.


## Tracing of V42 mutation paths (2026-10-28)

The following functions were located in the production `index.html` source at blob SHA `3919bd7d2832c321a80f72adb6bbf0f07d35bb61`. This is a source-path map, not proof of multi-device correctness:

- **Local persistence:** `saveDB()` serializes the whole `AppData` object and writes it to `localStorage`; it returns `true/false` and refreshes UI after the write.
- **POS sale:** `confirmHasibPayment()` validates cart lines, aggregates quantities per product, checks stock in the selected warehouse, validates customer/cash/invoice records, and then applies local mutations. The complete function and its rollback boundary still need focused review before calling this path transaction-safe across devices.
- **Customer debt collection:** `collectCustDebt(cId)` updates customer debt, cash balance, and a cash movement, then calls `saveDB()`; on local save failure it restores those in-memory values. This rollback protects one device's local persistence path, not concurrent writes from two devices.
- **Invoice editing:** `editSalesInvoice(invoiceId)` reconciles historical line quantities/prices with stock and financial records; its complete mutation and rollback path still requires separate review.
- **Truck load posting:** `postTripStock(trip)` validates the trip and product quantities and looks for prior truck-load movements. A local `stockPostedAt` marker and local movement scan are not server-enforced idempotency across phones.
- **Truck settlement:** the settlement flow records a `TR-SETTLE-` identifier, validates delivered/returned/damaged/missing quantities and links invoices to a trip. Its full final mutation/save/rollback path needs focused review; local checks alone cannot serialize competing device operations.
- **Generic webhook sync:** `syncPushNow()` POSTs the full `AppData` state; `syncPullNow()` fetches and can replace the local state after backup, validation, confirmation, and a local-change check. Neither flow is an operation queue or a verified merge protocol.
- **Firebase snapshot Worker:** `verifyFirebaseToken()` verifies the Firebase token and the Worker addresses `users/{uid}/snapshots/latest`. Firestore revision preconditions protect against overwriting a snapshot revision read earlier when the client supplies `revision`; they do not create organization membership, business-level transactions, or merge concurrent sales.

### Engineering conclusion from this trace

The code has meaningful **single-device validation and rollback safeguards**, but these must not be mistaken for atomic multi-device accounting. Before implementation, finish a function-by-function mutation inventory for sale, collection, invoice edit/return, truck load, trip status, and settlement; identify every mutation of stock, debt, cash, invoices, and movement ledgers; then design a trusted backend operation contract and isolated concurrency tests. Do not patch these paths with a UI-only queue or add an unverified organization field.
