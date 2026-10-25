# ANAS ERP — V42 / V54.25 candidate QA checkpoint
Date: 2026-10-25

## Exact artifacts compared

- Deployed repository baseline: `main/index.html`
  - Main commit at inspection: `ed23b01aa689f00d1cbac65dbd74ff8d2c4a477b`
  - Git blob: `cdd1abdc2dcea8a8c368fb25eeba644851f3fc75`
  - Internal title: `Anas ERP v42 - إصلاح الربط السحابي`
- Candidate inspected: Library artifact `ANAS_ERP_V54_25_TEST.html`
  - Exact size: 578,151 bytes
  - SHA-256: `d668ea61e7de4dbea89842038ae25da3efb52cab40d0ab5421fcb7645a61c3af`
  - Internal title: `ANAS ERP V54.25 - Release Candidate`
  - This is a locally available candidate artifact, not currently the deployed `main/index.html`.

Do not confuse this candidate with `ANAS_ERP_V54_25_MANIFEST_FIXED.html`: that is a different 569,721-byte file with SHA-256 `aea7e932644ea479bfdf48ffe05afe6a5e697006b75905b6278db5590f90ea19`, a different title, and fewer functions. The files must not be selected by filename alone.

## Candidate static checks performed

- 12 non-empty inline JavaScript blocks: all passed `node --check`.
- HTML parser processed 1,139 elements.
- 238 IDs; no duplicate IDs.
- 219 inline event handlers; heuristic handler-call scan found no unresolved calls.
- Candidate contains 248 named function declarations; deployed main contains 247. Similar counts do not imply behavioral equivalence.
- Manifest reference is `manifest.webmanifest`; Service Worker registration code is present.
- These are static checks, not a full browser or production test.

## Focused isolated behavior tests on this exact candidate

A small Node.js harness extracted the candidate's actual function bodies and supplied controlled stubs:

1. POS quantity edit: assigned secondary warehouse had 4 units while main warehouse had 100; attempting to set quantity to 5 was rejected and cart quantity stayed unchanged.
2. Warehouse transfer: when `saveDB()` returned false, main-store stock was restored.
3. Warehouse transfer: when `saveDB()` returned false, secondary-store stock was restored.
4. Warehouse transfer: when `saveDB()` returned false, the existing transfer journal was restored and the failed transfer was not retained.

Result: 4/4 focused isolated tests passed. This does not substitute for browser, multi-user, sync, persistence/reload, or device testing.

## Remaining semantic differences / integration blockers

The candidate contains newer paths such as IndexedDB primary storage helpers (`anasBootPrimaryStorage`, `anasOpenIDB`, `anasPersistSnapshotToIDB`, `anasReadSnapshotFromIDB`), permission guards (`anasHasPermission`, `anasRequirePermission`), and direct POS quantity editing (`setPosQty`). These require migration, authorization, and persistence acceptance tests before adoption.

The deployed V42 source has functions not found by name in this candidate, including:
- Warehouse context/availability: `wtAvailableStock`, `wtCurrentSaleWarehouse`, `wtEnsureMobileWarehouse`, `wtEnsureUserWarehouse`, `wtUserWarehouseName`, `wtReadStockBalance`.
- Reporting/date compatibility: `reportParseDate`, `safeContext`.
- UI helpers: `closePanel`, `openPanel`, `labelFor`.
- Product/import and Z-report helpers: `anasCreateUniqueBarcode`, `anasNormalizeBarcode`, `anasParseImportNumber`, `anasFormatZReportCashBalance`, `anasFormatZReportTotal`, `anasGetZReportTotal`, `populateProductCategorySuggestions`, `populateProductUnitOptions`.

A missing function name is a risk indicator, not proof the behavior is absent; each item must be traced to equivalent code and callers before merge. Conversely, candidate-only helpers do not prove their protections are wired to every sensitive action.

## Decision

**Do not replace or merge the candidate into production yet.** Keep the current mainline stable. Next acceptance work must compare complete critical function bodies and call sites for sales/invoice edits, warehouse-bound stock checks, truck loading/settlement, debt/cash accounting, report date/total calculations, permissions, sync validation, backup restore, and IndexedDB migration. Then build repeatable tests against a single pinned candidate and run browser/device acceptance before a release decision.

This report changes documentation only; it does not modify production application code or claim the V54.25 integration is complete.


## Follow-up: reproduced negative-stock bypass and candidate-only patch (2026-10-25)

### Reproduction on the original pinned candidate

The original `ANAS_ERP_V54_25_TEST.html` was executed in a Node.js VM with controlled stubs. With `AppData.allowNegativeStock = false`, main-store stock 100, assigned secondary-store stock `-1`, and requested POS quantity 5, the original `editPosQty` changed the cart quantity to 5 and showed no alert. The condition `available >= 0` caused the invalid negative balance to bypass the insufficient-stock check.

The original candidate's `wtBalance` also used `Number(value) || 0`, converting malformed numeric values to zero. Its transfer path did not validate the destination balance before adding stock, allowing a malformed destination balance to be overwritten as if it were zero.

### Candidate-only corrective artifact

A separate candidate file was prepared and saved in the Library as `/ANAS_ERP_V54_25_CANDIDATE_NEGATIVE_STOCK_GUARD.html`.

- Size: 580,295 bytes
- SHA-256: `3a60f3573ccc82a8322763567f35a62e6317a94c5192ddee14c0d53ff4916b2e`
- Production `main/index.html` was not changed by this candidate patch.

Changes in the candidate:
- `wtBalance` now returns `NaN` for malformed, non-finite, negative, or malformed-map stock data; a genuinely absent stock field/balance remains zero for legacy compatibility.
- `changePosQty`, `setPosQty`, and `editPosQty` reject invalid/negative balances before changing cart quantities, regardless of the negative-stock setting.
- `wtCreateTransfer` validates both source and destination balances before asking for confirmation or changing inventory.
- Existing rollback on failed transfer persistence remains in place.

### Verification on the patched candidate

- All 12 non-empty inline JavaScript blocks passed `node --check`.
- HTML parser processed 1,139 elements; 238 IDs were found, with no duplicates.
- 14/14 focused Node.js VM tests passed, covering all three POS quantity mutation entry points, malformed and negative stock handling, missing secondary balance compatibility, invalid source/destination transfer rejection, valid transfer behavior, and rollback on failed save.

These are isolated source-function tests with controlled mocks, not a full browser, cloud-sync, multi-user, or Android device acceptance run. The candidate artifact is not merged into or deployed as production; it must still undergo the V42 feature-preservation review described above.
