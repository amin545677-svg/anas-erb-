# ANAS ERP — Staging Release Acceptance Plan
Date: 2026-11-07
Candidate branch: `staging/unified-release-candidate`
Current reviewed candidate: `80ac6412815777faa6ac98802b699cd5064db43d`
Release PR: #263 (Draft; must remain unmerged during Staging acceptance)

## Release safety invariants

1. Production `main/index.html` must retain blob SHA `526cd060b331cdd9cb2415033673f1943ce60a09` until an explicit production approval.
2. All deployment targets must resolve to Firebase project `anas-erp-staging-a25e1`; never infer deployment from a successful PR validation job.
3. No financial mutation is accepted as complete until the trusted server response, persisted ledger state, idempotency record, and exact centime/micro-unit balances agree.
4. A failed, timed-out, or ambiguous network request must retain recoverable operation identity and must not be replayed as a new financial operation.
5. New synchronization code remains isolated from V42 until parity, crash-recovery, concurrency, and physical-device acceptance are demonstrated.

## Verified repository facts from the 2026-11-07 review

- PR #263 is OPEN, Draft, unmerged, and mergeable; its current head is `80ac6412815777faa6ac98802b699cd5064db43d` and base is `cea809ac8bb25ac0016287c725611d0b5842c594`.
- Production `main/index.html` still has blob SHA `526cd060b331cdd9cb2415033673f1943ce60a09`.
- Staging Test Gate run `42316659441` completed successfully on the current head. The `financial-regression` job passed P0 binary source hygiene, syntax checks, V42 integrity, financial/RBAC/idempotency audits, Firestore Emulator concurrency/security-rules tests, two-device HTTP 409 CAS acceptance, Android WebView resilient-storage Chromium acceptance, and backup/restore browser tests.
- HTML Regression run `42316659450` completed successfully on the same head.
- Hosting deployment run `42316652577` (push event, exact head `80ac641...`) completed successfully. It authenticated as `anas-staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com`, verified the isolated project identity, built the full ERP/POS PWA and reverse-ledger console, uploaded 34 files, finalized and released the Hosting version, and reported `Deploy complete!`.
- The same Hosting job verified live HTTP responses for `/config.js` (Staging project ID and staging-only allowed origin) and `/erp/` (Staging project config), then reported that the ERP/POS PWA, offline storage assets, console, and staging-only Firebase configuration were live. Hosting URL: `https://anas-erp-staging-a25e1.web.app`; ERP URL: `https://anas-erp-staging-a25e1.web.app/erp/`.
- Hosting PR validation run `42316659425` skipped its deployment job as expected for a pull request; the separate trusted push run above is the actual deployment evidence.
- Functions PR validation run `42316659520` succeeded, but its deployment job was SKIPPED. Functions push run `42316652849` was also SKIPPED.
- The Functions workflow still contains `if: ${{ false }}` on its deployment job, with a comment that deployment is frozen pending the isolated Staging IAM ActAs prerequisite. This is a hard Functions deployment blocker, not a test failure.
- Staging readiness preflight reported 29/29 checks passed. This validates source/config readiness only; it does not deploy Functions.
- The staging Functions and Hosting workflows include credential preflight, staging identity checks, and project-specific deployment commands. Keep them fail-closed.
- `sync/mutation_reconciliation.mjs` explicitly describes the reconciliation prototype as not wired into production `index.html`. The queue orchestrator is also documented as isolated from V42. Do not describe the prototype as production synchronization.
- The live E2E verifier requires a pre-seeded staging fixture and checks partial sale return, purchase return, cancellation, settlement allocation, idempotent replay, and exact financial assertions. Its backup/restore proof currently compares a snapshot hash before and after restoring the same state; this is useful integrity evidence but does not prove recovery of a prior state after subsequent mutations.

## Mandatory next-stage acceptance gates

### A. Enable isolated Staging deployment safely
- Resolve the dedicated Staging service account IAM prerequisites, including the precise `iam.serviceAccounts.actAs` permission required by the selected deployment identity.
- Keep production credentials and production project identifiers out of the Staging environment.
- Remove the Functions deployment freeze only in a reviewed change after IAM is independently verified.
- Hosting is deployed and live-verified for candidate `80ac641...` as recorded above; preserve that exact SHA-to-deployment evidence.
- Resolve and independently verify the dedicated Staging Functions service-account IAM prerequisites, including the precise `iam.serviceAccounts.actAs` permission required by the selected deployment identity.
- Remove the Functions deployment freeze only in a reviewed change after IAM is independently verified; then run the trusted Functions push deployment on the exact reviewed candidate SHA.
- Capture completed Functions deploy jobs and live callable/rules verification. A successful PR validation or 29/29 source readiness check is not deployment evidence.

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

Reason: Hosting is now deployed and live-verified on candidate `80ac641...`, and CI evidence is strong. However, Functions deployment remains explicitly frozen and no live callable deployment is proven; physical Android acceptance remains outstanding; the sync prototype is not integrated into V42; and backup/restore still needs a genuine prior-state restore after subsequent mutations.

Do not merge PR #263 or modify production `main` until all mandatory gates have evidence attached to this PR and the production shell has passed a documented behavioral-equivalence review.
