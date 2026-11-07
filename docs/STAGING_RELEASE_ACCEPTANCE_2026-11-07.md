# ANAS ERP — Staging Release Acceptance Plan
Date: 2026-11-07
Candidate branch: `staging/unified-release-candidate`
Current reviewed candidate: `5fcd6114b56ab0ea6b4d762354ca2f522eed9eaa`
Release PR: #263 (Draft; must remain unmerged during Staging acceptance)

## Release safety invariants

1. Production `main/index.html` must retain blob SHA `526cd060b331cdd9cb2415033673f1943ce60a09` until an explicit production approval.
2. All deployment targets must resolve to Firebase project `anas-erp-staging-a25e1`; never infer deployment from a successful PR validation job.
3. No financial mutation is accepted as complete until the trusted server response, persisted ledger state, idempotency record, and exact centime/micro-unit balances agree.
4. A failed, timed-out, or ambiguous network request must retain recoverable operation identity and must not be replayed as a new financial operation.
5. New synchronization code remains isolated from V42 until parity, crash-recovery, concurrency, and physical-device acceptance are demonstrated.

## Verified repository facts from the 2026-11-07 review

- PR #263 is OPEN, Draft, unmerged, and mergeable; its head was `5fcd6114b56ab0ea6b4d762354ca2f522eed9eaa` at review time.
- Production `main/index.html` still has blob SHA `526cd060b331cdd9cb2415033673f1943ce60a09`.
- Staging Test Gate run `42315329893` completed successfully. Its `financial-regression` job completed all listed steps successfully, including Firestore Emulator, Chromium, Android-resilient storage browser acceptance, backup/restore, and full HTML/inline-JavaScript validation.
- Functions PR validation run `42315329841` succeeded, but job `deploy-reverse-ledger-staging` was SKIPPED.
- Hosting PR validation run `42315329801` succeeded, but job `deploy-staging-console` was SKIPPED.
- The Functions workflow currently contains `if: ${{ false }}` on its deployment job, with a comment that deployment is frozen pending the isolated Staging IAM ActAs prerequisite. This is a hard deployment blocker, not a test failure.
- The current staging Functions and Hosting workflows include credential preflight, staging identity checks, and project-specific deployment commands. These must remain fail-closed while IAM is resolved.
- `sync/mutation_reconciliation.mjs` explicitly describes the reconciliation prototype as not wired into production `index.html`. The queue orchestrator is also documented as isolated from V42. Do not describe the prototype as production synchronization.
- The live E2E verifier requires a pre-seeded staging fixture and checks partial sale return, purchase return, cancellation, settlement allocation, idempotent replay, and exact financial assertions. Its backup/restore proof currently compares a snapshot hash before and after restoring the same state; this is useful integrity evidence but does not prove recovery of a prior state after subsequent mutations.

## Mandatory next-stage acceptance gates

### A. Enable isolated Staging deployment safely
- Resolve the dedicated Staging service account IAM prerequisites, including the precise `iam.serviceAccounts.actAs` permission required by the selected deployment identity.
- Keep production credentials and production project identifiers out of the Staging environment.
- Remove the Functions deployment freeze only in a reviewed change after IAM is independently verified.
- Run trusted push deployment workflows on the exact candidate SHA; capture completed deploy jobs and live verification output for both Functions and Hosting.
- Verify the deployed Firebase project ID and Hosting origin from live endpoints. A PR validation pass is not deployment evidence.

### B. Live financial acceptance
- Use dedicated, pre-seeded Staging users, grants, open financial periods, and known invoices; never create or alter production financial data.
- Exercise sale, purchase, partial returns, full cancellation, customer/supplier settlement allocation, cashbox effects, and stock effects.
- For every operation verify the trusted callable result, persisted operation document, immutable ledger entries, snapshot, and exact centime/micro-unit deltas.
- Replay identical operation IDs sequentially and concurrently; require identical results and exactly one financial posting.
- Reuse an operation ID with a changed payload; require deterministic rejection.
- Test two users/devices racing on the same source balance and verify that no allocation or stock quantity exceeds its available ceiling.

### C. Backup and restore acceptance
- Capture a known-good snapshot and its canonical hash plus a financial invariant report.
- Apply a controlled set of Staging-only mutations after the backup.
- Restore the earlier backup through the trusted restore callable.
- Verify the restored hash matches the original backup, all balances and stock quantities match the original invariant report, and post-backup operations are represented according to the documented restore policy.
- Verify restore authorization, audit trail, idempotency, and behavior when the restore request times out after server commit.

### D. Offline and Android field acceptance
- Test on physical Android devices and the actual installed WebView/PWA, not Chromium alone.
- Interrupt connectivity during local commit, upload, conflict response, authentication refresh, and application restart.
- Verify PREPARED journal recovery, queue retention, deterministic ordering, conflict retry, quarantine visibility, and no duplicate invoice/receipt/stock movement.
- Exercise IndexedDB unavailable, quota exceeded, blocked upgrade, transaction abort, corrupted metadata, and fallback persistence failure.
- Verify the application blocks financial writes when neither durable storage path is confirmed.
- Record device model, Android/WebView version, build SHA, steps, logs, and expected/actual balances for every run.

### E. Synchronization integration gate
- Keep the prototype isolated until the complete V42 mutation inventory is mapped to operation schemas and tested for parity.
- Add crash injection at every journal boundary and at each await/network boundary.
- Add multi-tab/multi-device concurrent local mutation tests; prove a sync acknowledgement cannot retire an operation created after the sync snapshot was captured.
- Test ambiguous success (server commits but client times out) and ensure operation IDs and payload hashes make retry safe.
- Require a server-enforced compare-and-swap revision and idempotency boundary; client-only ordering is insufficient.
- Quarantine unsupported or ambiguous operations without silently dropping them; expose a review and recovery workflow to an authorized operator.

### F. Performance and scale gate
- Establish measured baselines for cold start, warm start, screen transition, search, save, sync, and restore on representative low-end Android hardware.
- Test realistic and upper-bound datasets for products, invoices, movements, customers, suppliers, and multiple stores.
- Measure Firestore reads/writes, payload size, memory use, IndexedDB transaction latency, and offline queue growth.
- Set explicit budgets and fail CI on material regressions; do not optimize from intuition alone.

## Release decision

Current decision: **NOT READY FOR COMMERCIAL RELEASE**.

Reason: CI evidence is strong, but Functions deployment is explicitly frozen; Hosting/Functions live deployment is not proven by the PR runs; physical Android acceptance remains outstanding; and the sync prototype is not integrated into V42. The backup test must be extended to a genuine prior-state restore scenario.

Do not merge PR #263 or modify production `main` until all mandatory gates have evidence attached to this PR and the production shell has passed a documented behavioral-equivalence review.
