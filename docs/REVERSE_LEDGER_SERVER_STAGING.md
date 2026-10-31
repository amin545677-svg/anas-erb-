# ANAS ERP — Reverse Ledger Firebase Functions (Staging)

## Scope and safety

This service is a staging-only server boundary for sale returns, purchase returns, and invoice cancellation. It uses Firebase callable Functions, Firebase Admin SDK, and one Firestore transaction to commit the updated per-user snapshot and the idempotency result together.

It is intentionally separate from the Cloudflare Firebase Snapshot Worker, the OpenAI AI Worker, and production Firebase configuration. The production `firebase.json`, production Firestore rules, `index.html`, and V42 application identity are not changed by this work.

The callable is App Check protected and accepts only a narrow allowlist of request fields. It never trusts `AppData.currentUser`, browser-supplied permissions, cash balances, inventory balances, invoice totals, or ledger records.

## Callable contract

Callable name: `executeReverseLedger`

Required data:

```json
{
  "operationId": "REV-OP-00000001",
  "periodId": "FY-2026-10",
  "originalInvoiceType": "sales_invoice",
  "returnType": "SALE_RETURN",
  "invoiceId": "INV-100",
  "items": [{ "productId": "P-1", "quantity": "1.250000" }],
  "settlementMode": "cash",
  "reason": "Damaged goods"
}
```

For `INVOICE_CANCEL`, omit `items`; the server derives every original invoice line and forces cash settlement. Quantities are parsed to six-decimal micro-units and money to integer centimes. Duplicate products, malformed identifiers, excess precision, and mismatched return/invoice types are rejected.

## Server-managed Firestore documents

Control-plane documents use the same root-level paths as the Cloudflare reservation Worker; the snapshot itself remains scoped to the authenticated Firebase UID:

- `users/{uid}/snapshots/latest`: existing ANAS ERP serialized state in the `payload` string field.
- `reverseLedgerGrants/{uid}`: server-managed authorization grant.
- `financialPeriods/{periodId}`: server-managed period; must contain `status: "OPEN"`.
- `reverseLedgerOperations/{operationId}`: immutable idempotency/result record created in the same transaction as the snapshot update.

Example grant document (create only through a trusted Admin SDK process):

```json
{
  "uid": "FIREBASE_UID",
  "active": true,
  "schemaVersion": 1,
  "permissions": [
    "reverse_sale_return",
    "reverse_purchase_return",
    "reverse_invoice_cancel",
    "reverse_cash_refund",
    "reverse_credit_issue"
  ]
}
```

A grant must not be created for a real user until the user's invoice and settlement data have been reconciled to the version-2 ledger. The server currently rejects invoices without `invoiceLedgerVersion: 2`; legacy reconciliation is not inferred or fabricated.

Example open period document:

```json
{
  "periodId": "FY-2026-10",
  "status": "OPEN"
}
```

## Two-step reservation and posting contract

First, the browser obtains a Firebase ID token and reserves the operation through the Cloudflare Worker:

```json
{
  "operationId": "REV-OP-00000001",
  "type": "SALE_RETURN",
  "invoiceId": "INV-100",
  "periodId": "FY-2026-10"
}
```

The Worker returns `reserved: true` and `posted: false`; this is only an idempotency reservation, never a financial success. The browser then calls the Firebase callable with the same `operationId` and `periodId`, plus `originalInvoiceType`, `returnType`, exact item quantities, settlement mode, and reason. The callable verifies that the RESERVED document belongs to the same UID and matches the operation type, invoice, and period before it posts.

Only the callable's successful transaction result confirms a posted return. A reservation response must never be displayed as a completed accounting operation.

## Atomicity and idempotency

The callable reads the user snapshot plus the shared root-level grant, financial period, and operation ID record inside a Firestore transaction. It can finalize a matching RESERVED record created by the Cloudflare reservation Worker, or create the operation record itself when no reservation exists. It executes the existing BigInt reverse-ledger engine against an isolated clone, validates the resulting operation against the trusted grant, then writes:

1. The complete serialized state snapshot.
2. The operation record with request hash, result, owner UID, and return ID.

Both writes commit or neither commits. Repeating the same operation ID with the same normalized request returns the stored result. Reusing that ID for a different request is rejected. Firestore transaction retries handle concurrent attempts; no browser-local posting path is enabled.

## Snapshot write lock

The staging Firestore rules allow snapshot reads by the owner but deny direct snapshot writes once a trusted reverse-ledger grant document exists. This is necessary: otherwise the legacy snapshot Worker could overwrite a transactionally posted financial state after the reverse operation commits.

Consequently, do not activate a grant for a user until a trusted server-side backup/restore route is available and verified for that user. `createTrustedReverseLedgerBackup` stores the validated snapshot plus the user's operation/idempotency records in an Admin-SDK-only backup archive. `restoreTrustedReverseLedgerBackup` restores both transactionally, rejects stale backups that would omit a posted operation, refuses request-hash conflicts or posted-record downgrades, and preserves pending Worker reservations. The existing snapshot Worker remains usable for users without a reverse-ledger grant. This is a deliberate fail-closed boundary, not a silent compatibility claim. The archive is bounded to a 700 KiB snapshot, at most 300 operation records, 200 KiB per record, and 6 MiB total operation data; oversized backups fail closed.

## Deploying to staging

The manual workflow `Deploy Reverse Ledger Firebase Functions (Staging)` via `.github/workflows/deploy-reverse-ledger-functions-staging.yml` requires the GitHub Actions secret:

- `FIREBASE_STAGING_SERVICE_ACCOUNT`: full JSON service-account key for project `anas-erp-staging-a25e1`, with the permissions required to deploy Firebase Functions v2 and Firestore rules.

The workflow verifies the staging project, checks that the bundled engine and authorization policy exactly match the canonical source files, installs the Functions dependencies, then deploys only the staging Firestore rules plus `executeReverseLedger`, `createTrustedReverseLedgerBackup`, and `restoreTrustedReverseLedgerBackup`.

No production deployment is configured. Do not put service-account JSON, private keys, or API tokens in source control or chat.

## Staging browser callable client

The isolated client lives at `staging/reverse-ledger-gateway.js`; it is intentionally **not loaded by the production V42 page**. A staging-only UI must load the Firebase compat SDKs (including App Check) before this client, then inject a dedicated staging configuration:

```html
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check-compat.js"></script>
<script>
window.ANAS_REVERSE_LEDGER_STAGING_CONFIG = {
  firebaseConfig: {
    apiKey: "STAGING_WEB_APP_API_KEY",
    authDomain: "anas-erp-staging-a25e1.firebaseapp.com",
    projectId: "anas-erp-staging-a25e1",
    appId: "STAGING_WEB_APP_ID"
  },
  appCheckSiteKey: "STAGING_RECAPTCHA_V3_SITE_KEY",
  allowedOrigins: ["https://YOUR-STAGING-HOST"],
  functionsRegion: "us-central1"
};
</script>
<script src="./staging/reverse-ledger-gateway.js"></script>
```

The staging page must sign users in through `ANASReverseLedgerStagingAuth` (the named staging Firebase app), not the production app's default `auth` instance. Once signed in, the client exposes `ANASReverseLedgerServer.execute(request)`, matching the modal's existing gateway contract. It refreshes the staging ID token, requires an App Check token, calls `executeReverseLedger`, and reports success only when the callable returns a posted document with a return ID. The callable can create the idempotency record in its own Firestore transaction, so this client does not treat the Cloudflare reservation response as a posted financial result.

The client hard-rejects any Firebase project other than `anas-erp-staging-a25e1`, requires HTTPS (except localhost), and requires an explicit exact-origin allowlist. The configuration contains public web-app/App Check identifiers only; never embed service-account credentials. The staging client and its tests do not alter the production V42 page or its Firebase configuration.

## Verification completed and remaining gates

The Staging Test Gate now runs a deterministic in-memory transaction harness and a real Firestore Emulator suite. The emulator suite covers snapshot/result commit, same-operation replay, concurrent duplicate requests, competing operations against the same invoice, mismatched replay, authorization abort, no-prior-reservation creation, snapshot read-after-write, trusted backup creation, restoration of pending and posted operation records, posted-return parity, stale-snapshot rejection, and refusal to omit posted operations. It also executes sales return, purchase return, and full invoice cancellation end-to-end with the canonical BigInt engine against reconciled `invoiceLedgerVersion: 2` invoices, checking debt, cash, stock, historical COGS, WAC book value, and valuation variance. The in-memory harness additionally verifies that a simulated commit failure leaves both records unchanged.

Still required before enabling real posting:

- 
- Provision and verify a dedicated staging user, server-managed grant, and open financial period.
- Add the Firebase Web SDK callable client and App Check initialization to the staging UI only.
- Complete the Firestore Emulator backup/restore tests, including pending reservation preservation and rejection of stale backups that omit posted operations.
- Verify the live staging function and Firestore rules with a dedicated test account before any user grant is activated.
