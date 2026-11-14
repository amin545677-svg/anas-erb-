# Live Firebase Staging E2E verification

This verifier is deliberately opt-in and fails closed outside the dedicated Firebase Staging console.

## Safety boundary

- Target project is fixed to `anas-erp-staging-a25e1`.
- Target origin is fixed to `https://anas-erp-staging-a25e1.web.app`.
- The script does not create Firebase users, grants, financial periods, invoices, inventory, or settlement allocations.
- Use only synthetic Staging records and a dedicated Staging account.
- Never supply Production credentials, customer records, or service-account JSON through the command line.
- The script submits real callable requests and therefore writes to the Staging ledger. Use fresh operation IDs and disposable synthetic invoices for every run.

## Required pre-seeded fixture

Copy `tests/fixtures/reverse-ledger-live-staging.example.json` to a private file outside the repository and replace every `REPLACE_...` value with IDs and exact integer-unit expectations from the isolated Staging dataset.

The fixture must contain:
- One version-2 sales invoice and a real, unallocated customer receipt source. The verifier creates the settlement allocation through the visible allocation modal and trusted callable, then uses that allocated invoice for the strictly partial `SALE_RETURN`.
- A separate eligible version-2 sales invoice for `INVOICE_CANCEL`. The cancellation must not target the partially returned invoice because a posted partial return blocks later full cancellation.
- One separate version-2 purchase invoice for `PURCHASE_RETURN`.
- Every seeded invoice, receipt movement, and product involved in the scenario must belong to the bootstrap grant's exact `tenantId` and permitted `storeIds`. In multi-tenant or multi-store snapshots, the relevant records must carry explicit matching `tenantId` / `storeId` fields; do not rely on browser-supplied scope.
- An open financial period, unique operation IDs, and exact expected centime/micro-unit balances after all three operations.

**Current acceptance path:** the Staging console exposes the trusted `executeSettlementAllocation` callable and trusted reverse-ledger/backup callables. The verifier drives the visible settlement-allocation modal, requires the trusted gateway, creates the allocation server-side, and checks the resulting allocation records before submitting the return/cancellation operations. The emulator DOM bridge separately exercises the actual V42 modal through `page.exposeFunction` and reads the committed state back from Firestore.

## Run

Install Playwright and Chromium in a trusted workstation or CI environment, then set these variables without committing them:

- `ANAS_STAGING_URL` — must be the fixed Staging origin.
- `ANAS_STAGING_EMAIL` and `ANAS_STAGING_PASSWORD` — dedicated synthetic Staging account.
- `ANAS_STAGING_E2E_FIXTURE` — path to the private fixture file.
- Optional `ANAS_STAGING_EVIDENCE_PATH` — local evidence JSON output path.

Run:

```sh
npm install --no-save playwright@1.56.1
npx playwright install chromium
node scripts/verify-live-staging-e2e.mjs
```

The Playwright flow signs into Staging, reads the cloud snapshot, verifies the exact allocation cents, submits the three operations through the actual `#modal-reverse-ledger` UI and `executeReverseLedger` callable, checks `POSTED`, tests concurrent same-payload idempotency and changed-payload `already-exists`, then creates/restores a trusted backup and compares the snapshot hash plus exact BigInt centime/micro-unit assertions.

The companion test is part of `Staging Test Gate`. It runs contract checks in ordinary CI and performs the live browser flow only when all dedicated live-test variables are explicitly present.

## Dedicated GitHub Actions live verification

The repository includes an explicit, manually approved workflow:
`.github/workflows/verify-live-staging-e2e.yml`.

It is restricted to `staging/unified-release-candidate`, uses the protected GitHub `staging` Environment, and does not run for pull requests or production branches. To run it after both the staging console and trusted Functions have been deployed:

1. Add `ANAS_STAGING_EMAIL` and `ANAS_STAGING_PASSWORD` as GitHub Environment secrets.
2. Add `ANAS_STAGING_E2E_FIXTURE_JSON` as a GitHub Environment secret containing the completed synthetic fixture JSON. It must contain only disposable Staging record IDs, exact expected centimes/micro-units, unique operation IDs in the `REV-STAGE-` namespace, and no `REPLACE_...` placeholders.
3. Optionally set `ANAS_STAGING_UID` as an Environment variable or secret to pin the expected Firebase Auth UID.
4. Open **Actions → Verify Live ANAS ERP Firebase Staging E2E → Run workflow**, select `staging/unified-release-candidate`, and explicitly choose `RUN_STAGING_FINANCIAL_E2E`.

The default choice is `NO`. The workflow fails closed if credentials or the project-scoped fixture are missing or malformed. It performs real financial mutations in the isolated Staging ledger, so use fresh operation IDs and disposable synthetic invoices for each run. Evidence is uploaded as a short-retention workflow artifact. This workflow verifies the deployed live system; it does not deploy Functions or Hosting itself.
