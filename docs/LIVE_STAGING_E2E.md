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
- One version-2 sales invoice with a settlement allocation already persisted in `settlementAllocations`; the same invoice is used for the partial `SALE_RETURN` followed by the full `INVOICE_CANCEL`. The verifier checks the invoice paid centimes, matching allocation records, and that the first return quantity is strictly partial.
- A separate version-2 purchase invoice for the `PURCHASE_RETURN`.
- An open financial period, unique operation IDs, and exact expected centime/micro-unit balances after all three operations.

**Important current boundary:** the Staging console has a trusted reverse-ledger callable and trusted backup/restore callables. The existing settlement-allocation modal still uses the legacy local `saveDB()` path; there is not yet a trusted server-side settlement-allocation callable in this branch. Therefore this E2E verifier proves the allocation ledger is present and reconciled before reversal, but does not create a new allocation. Do not treat that as end-to-end allocation acceptance.

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
