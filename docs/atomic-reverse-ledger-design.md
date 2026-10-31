# Atomic Reverse Ledger — Design Gate

Baseline: `382ed534f50b8d082acf71cc456744e5aa3a4872` (ANAS ERP v42)

## Verified baseline schema

- Sales invoices are stored in `AppData.invoices`; each has `id`, `items`, `total`, `paid`, `remaining`, `customerObj`, `warehouse`, and `paymentMethod`.
- Sales stock-out entries use `stockMovements` with `type: SALE_OUT`, `referenceType: sales_invoice`, and `referenceId: invoice.id`.
- Sales cash receipts use `cashMovements` with `type: add`, `referenceType: sales_invoice`, and `referenceId: invoice.id`, only when the invoice has a paid amount.
- Sales credit currently changes the aggregate `customer.debt`; there is no `clientMovements` or `customerMovements` ledger and no invoice-level allocation for later customer debt receipts. `collectCustDebt` records a cash movement with `referenceType: customer_debt` and `referenceId: customer.id`, not an invoice ID.
- Purchase invoices created by the current centime flow are stored in `AppData.purchases` (with `ledgerVersion: 1`), not `purchaseInvoices`. Their stock movement is `PURCHASE_IN` / `purchase_invoice`; supplier entries are `purchase` and, when paid on creation, `payment` / `purchase_invoice`; cash paid on creation is `subtract` / `purchase_invoice`.
- Later supplier debt payments are recorded against `referenceType: supplier_payment`, not allocated to a specific purchase invoice.
- `returns` is an optional array accepted by backup/cloud shape validation and initialized on restore, but no active `AppData.returns` posting engine exists. `salesReturns` and `purchaseReturns` appear in a history-protection list, not as active transaction ledgers.
- The current `anasValidatePurchaseLedgerParity` is invoked by both backup and cloud validators. It validates purchase invoices and purchase/supplier/cash/stock links only; it does not validate sales invoice parity or returns.
- `saveDB()` serializes the complete `AppData` snapshot to one localStorage key and returns false if serialization/storage fails. Callers that mutate multiple ledgers must snapshot and restore the complete state on failure.
- The current sales invoice editor mutates the original invoice's `items`, `total`, `remaining`, and `editedAt`, while appending stock adjustment movements. This conflicts with the proposed immutable-posted-invoice rule and must be gated/disabled for posted invoices or redesigned as a separately audited adjustment before reverse-ledger release.
- The existing return/cancel menu actions call parameterless prompts; they do not select or pass an invoice ID. A real workflow needs an explicit invoice selector and line/quantity selection.

## Required accounting design decisions before posting code

1. Add invoice-level customer settlement allocation history. Aggregate `customer.debt` and customer-level `customer_debt` cash receipts cannot establish which invoice's balance was paid. Do not infer an invoice allocation from the current aggregate debt.
2. Add invoice-level supplier settlement allocation history. Generic `supplier_payment` movements are not attributable to a purchase invoice without explicit allocations.
3. Preserve legacy history. Existing invoices with ambiguous/unallocated receipts must be marked as legacy-unallocated for return settlement; do not fabricate allocations. Require reconciliation or a conservative no-cash/no-debt-offset path before refunding.
4. Use BigInt for intermediate centime and micro-unit calculations, but never persist BigInt values into `AppData` because `JSON.stringify` in `saveDB()` cannot serialize BigInt. Persist canonical safe integers or validated decimal strings under a documented schema.
5. A reversal is an append-only document with a unique ID, original invoice reference, operator, timestamp, reason, line-level quantities, centime amounts, and explicit ledger movement references. Replays and duplicate IDs must be rejected.
6. Cancellation is a full reversal only when no prior return/reversal exists and all stock/settlement preconditions pass. Keep the original invoice and its monetary/line data unchanged; a separate status marker may indicate cancellation.
7. Extend both `anasValidateBackupData` and `anasValidateIncomingSyncData` through a shared reverse-ledger parity validator. Validate references, line and value ceilings, stock movement parity, settlement allocation parity, and duplicate/replay protection before accepting snapshots.


## Implemented structural guard layer (feature branch)

- index.html now initializes clientMovements, settlementAllocations, and returns only when absent. Existing malformed values remain visible to startup integrity checks; no historical allocation or invoice version is fabricated.
- saveDB() runs the shared reverse-ledger validator before serialization. Backup and cloud validators run the same validator before any state replacement; legacy snapshots may omit the new arrays and are normalized after successful validation.
- reverse-ledger.js exports pure constructors and seal functions. Constructors do not stamp ledgerVersion: 2. Sealing first validates a candidate full state and only then returns a version-2 record; failure leaves the caller's state unchanged.
- Settlement allocation validation checks the exact invoice/party relationship, source-ledger identity, per-invoice paid-centime ceiling, and per-source-movement amount ceiling. Customer debt receipts bind to the customer-level cash movement; supplier payments bind to the supplier ledger movement, including distinct initial-purchase-payment and later-supplier-payment references.
- Return validation checks original invoice existence and type, exact centime arithmetic, original line identity and unit-price ceiling, cumulative posted-return micro-unit ceiling, full-line/full-quantity cancellation, stock movement direction and quantity, and exact financial movement references and settlement totals. Purchase invoices use their actual single-line productId / qty / cost schema.
- Purchase returns may represent residual supplier credit explicitly as supplierCreditCentimes; this is included in the posted settlement equality check. Sales returns cannot create supplier credit.
- sw.js precaches the reverse-ledger runtime for offline startup.

### Deliberate non-goals at this gate

- No transaction flow yet creates customer allocations from collectCustDebt or supplier allocations from later supplier payments. The source functions still need a separate, auditable transaction integration before v2 settlement records are issued in production.
- No sale-return, purchase-return, or cancellation posting UI is enabled. cancelInvoicePrompt, returnSalePrompt, and returnPurchasePrompt remain fail-closed until the posting engine, rollback path, and operator confirmation flow are implemented.
- No legacy invoice is auto-migrated or assigned ledgerVersion: 2. Historical unallocated payments remain unallocated.

### Current verification on the feature head

- node --test reverse-ledger and financial invariant suite: 19/19 passed.
- Playwright/Chromium: 2/2 passed, including V42 backup acceptance, valid v2 allocation acceptance, orphan allocation rejection, over-return rejection, and unchanged AppData / localStorage after rejected backup/cloud candidates.
- The four primary CI gates and the additional service-worker cache regression passed on the same feature commit.

## Implementation and release gates

- No production merge or deployment. Keep PR #248 and this stacked PR Draft.
- Add Node unit tests for partial/full sale returns, purchase returns, cancellation, over-return, unavailable purchase-return stock, duplicate/replay, allocation edge cases, and failed-save rollback.
- Add Playwright/Chromium tests for actual UI selection, postings, localStorage persistence, reload, backup restore, and orphan/mismatched reverse-ledger rejection.
- Do not weaken existing purchase parity, backup, cloud-sync, stock, or safety validators.
- Release only after all four CI gates pass on the same commit and the Chromium report proves exact centime/micro-unit balances and unchanged source invoices.
