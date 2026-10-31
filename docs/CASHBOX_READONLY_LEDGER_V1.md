# ANAS ERP Cashbox Ledger View — Scope and Safety

## Current increment

The cashbox screen now includes a read-only view over the existing `AppData.cashMovements` collection:

- Search by movement ID, description, user, and source reference.
- Filter incoming (`add`), outgoing (`subtract`), or invalid records.
- Show recorded inflow/outflow totals and the count of malformed entries.
- Escape untrusted text before rendering it into the table.
- Preserve malformed rows as visible exceptions instead of coercing them to zero or dropping them.

## Explicit accounting boundary

This view is **not** a complete general ledger and is **not** a daily cash close. It does not infer an opening balance, manufacture missing sales/purchase movements, or reconcile cash from incomplete historical records. It only summarizes valid rows that are already present in `cashMovements`.

The renderer does not mutate `AppData`, balances, or movement history. Financial posting continues to use the existing validated operation paths.

## Next acceptance layer

Before adding cash closing or cross-source reconciliation, the application needs one canonical, complete cash journal with stable source IDs and direction for each supported posting path (POS cash receipts, customer debt collection, supplier payments, expenses, manual cash operations, and any other cash-affecting transaction). The close operation must then be atomic, idempotent, role-gated, and immutable after approval, with explicit reversal entries rather than historical edits.
