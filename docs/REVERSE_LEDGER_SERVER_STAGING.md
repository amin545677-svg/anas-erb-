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

All paths are scoped to the authenticated Firebase UID:

- `users/{uid}/snapshots/latest`: existing ANAS ERP serialized state in the `payload` string field.
- `users/{uid}/reverseLedgerGrants/{uid}`: server-managed authorization grant.
- `users/{uid}/financialPeriods/{periodId}`: server-managed period; must contain `status: "OPEN"`.
- `users/{uid}/reverseLedgerOperations/{operationId}`: immutable idempotency/result record created in the same transaction as the snapshot update.

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

A grant must not be created for a real user until the user's invoice and settlement data have been reconciled to the version-2 ledger. The server currently rejects invoices without `ledgerVersion: 2`; legacy reconciliation is not inferred or fabricated.

Example open period document:

```json
{
  "periodId": "FY-2026-10",
  "status": "OPEN"
}
```

## Atomicity and idempotency

The callable reads the snapshot, grant, financial period, and operation ID record inside a Firestore transaction. It executes the existing BigInt reverse-ledger engine against an isolated clone, validates the resulting operation against the trusted grant, then writes:

1. The complete serialized state snapshot.
2. The operation record with request hash, result, owner UID, and return ID.

Both writes commit or neither commits. Repeating the same operation ID with the same normalized request returns the stored result. Reusing that ID for a different request is rejected. Firestore transaction retries handle concurrent attempts; no browser-local posting path is enabled.

## Snapshot write lock

The staging Firestore rules allow snapshot reads by the owner but deny direct snapshot writes once a trusted reverse-ledger grant document exists. This is necessary: otherwise the legacy snapshot Worker could overwrite a transactionally posted financial state after the reverse operation commits.

Consequently, do not activate a grant for a user until a trusted server-side backup/restore route is available for that user. The existing snapshot Worker remains usable for users without a reverse-ledger grant. This is a deliberate fail-closed boundary, not a silent compatibility claim.

## Deploying to staging

The manual workflow `Deploy Reverse Ledger Firebase Functions (Staging)` requires the GitHub Actions secret:

- `FIREBASE_STAGING_SERVICE_ACCOUNT`: full JSON service-account key for project `anas-erp-staging-a25e1`, with the permissions required to deploy Firebase Functions v2 and Firestore rules.

The workflow verifies the staging project, checks that the bundled engine and authorization policy exactly match the canonical source files, installs the Functions dependencies, then deploys only the staging Firestore rules and `executeReverseLedger` function.

No production deployment is configured. Do not put service-account JSON, private keys, or API tokens in source control or chat.

## Remaining integration gates

- Provision and verify a dedicated staging user, server-managed grant, and open financial period.
- Add the Firebase Web SDK callable client and App Check initialization to the staging UI only.
- Add an Admin-SDK backup/restore route before enabling grants for users who depend on snapshot uploads.
- Run real Firestore emulator transaction tests for concurrent duplicate operation IDs, replay, mismatched replay, transaction abort, and snapshot read-after-write.
- Verify the live staging function and Firestore rules with a dedicated test account before any user grant is activated.
