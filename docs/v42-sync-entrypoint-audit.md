# ANAS ERP V42 — Read-only Sync Entrypoint Audit

- Source: `main/index.html`
- Git blob SHA-1: `3919bd7d2832c321a80f72adb6bbf0f07d35bb61`
- Source line count: 9031
- Scope: static source inspection only. No production file was modified and no live Firebase request was made.

## Findings

### Persistent AppData
- `ANAS_DB_KEY` is defined at line 2544 as `ANAS_THE_ENTERPRISE_V11_OFFLINE`.
- `saveDB()` writes the serialized AppData snapshot through `localStorage.setItem(ANAS_DB_KEY, serialized)` at line 2751.
- The source scan found 15 direct `localStorage.setItem(...)` call sites overall. Most are unrelated preferences, AI gateway settings, drafts, diagnostics, or worker URL configuration; they are not all AppData writes.
- No direct `localStorage[key] = ...` assignment matched this scan.

### Cloud snapshot entrypoints
- The UI has a direct `anasFirebasePull()` button handler at line 2013 and its implementation at line 8878.
- The UI has a direct `anasFirebasePush()` button handler at line 2012 and its implementation at line 8877.
- `workerRequest()` is the common HTTP helper for the snapshot Worker at line 8875. The push path makes a metadata GET then POST; the pull path makes a GET.
- The pull implementation validates the restored payload, then assigns `AppData=restored` (line 8891), calls `saveDB()` (line 8899), and reloads the page (line 8907). This is a destructive local replacement flow after confirmation, not a merge/reconcile flow.
- Other `fetch()` calls exist for AI and worker health/diagnostic features. They should not be misclassified as AppData snapshot sync without inspecting their endpoints/payloads.
- No `addEventListener('online', ...)` pattern was found by the exact static scan. This does not prove there is no equivalent online hook under another spelling or wrapper.

### Transaction capture functions
- `confirmHasibPayment()` is defined at line 3430 and invoked from a UI button at line 2269.
- `collectCustDebt(cId)` is defined at line 4233 and invoked from the customer-debt action at line 4200.
- The isolated mutation bridge/orchestrator is not wired into these production functions in `main/index.html`.

### Quarantine/UI
- No quarantine identifiers (`QUARANTINED`, `ANAS_PENDING_MUTATIONS`, `appliedOpIds`, `syncOpId`) were found in production `index.html` by this scan.
- Therefore, the isolated prototype's quarantine results are not yet presented by the production UI. A production-facing warning/status panel is still required before users could safely interpret a quarantined sale.

## Safety decision

Do not monkey-patch the production page and do not replace the live `anasFirebasePull()` with the orchestrator until a staging adapter can preserve the distinction between:
1. an explicit full snapshot restore (current backup/restore behavior), and
2. an operational reconciliation pull (fetch V1, replay local pending mutations, CAS-push V2).

The first staging test should prove the recovery barrier runs before any network read and that an interrupted PREPARED operation is promoted only when its `opId` marker is present in the exact persisted AppData snapshot. This report is a static audit, not a browser E2E or live Firebase certification.
