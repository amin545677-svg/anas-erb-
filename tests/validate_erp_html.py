#!/usr/bin/env python3
"""Static regression checks for the ANAS ERP single-file web application."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import re
import json
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "index.html"

class ERPParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.ids = []
        self.inline_handlers = []
        self.inline_scripts = []
        self._script_attrs = None
        self._script_chunks = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs and attrs["id"]:
            self.ids.append(attrs["id"])
        for name, value in attrs.items():
            if name.lower().startswith("on") and value:
                self.inline_handlers.append(value)
        if tag.lower() == "script":
            self._script_attrs = attrs
            self._script_chunks = []

    def handle_data(self, data):
        if self._script_attrs is not None:
            self._script_chunks.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self._script_attrs is not None:
            if not self._script_attrs.get("src"):
                source = "".join(self._script_chunks)
                if source.strip():
                    self.inline_scripts.append(source)
            self._script_attrs = None
            self._script_chunks = []

def fail(message):
    print("FAIL:", message)
    return False

def main():
    if not HTML.exists():
        return 1 if fail("index.html is missing") else 0
    source = HTML.read_text(encoding="utf-8")
    parser = ERPParser()
    parser.feed(source)
    parser.close()
    errors = []

    # The AI hub entry is a semantic button; descendants must be phrasing elements,
    # not divs, so the HTML remains conforming while retaining the existing card classes.
    ai_hub_button_start = source.find(
        """<button type="button" class="grid-card-item" onclick="openView('ai-excel-hub')" aria-label="فتح مركز الذكاء الاصطناعي">"""
    )
    ai_hub_button_end = source.find("</button>", ai_hub_button_start) if ai_hub_button_start >= 0 else -1
    ai_hub_button_markup = (
        source[ai_hub_button_start:ai_hub_button_end + len("</button>")]
        if ai_hub_button_start >= 0 and ai_hub_button_end > ai_hub_button_start
        else ""
    )
    if (
        not ai_hub_button_markup
        or '<span class="card-icon-box" aria-hidden="true">🤖</span>' not in ai_hub_button_markup
        or '<span class="card-title-text">مركز الذكاء الاصطناعي</span>' not in ai_hub_button_markup
        or "<div" in ai_hub_button_markup
    ):
        errors.append("AI hub touch target must be a semantic button with valid phrasing-content children")
    else:
        print("PASS: AI hub touch target uses semantic button markup with valid children")
    # Guard the mobile interaction/accessibility CSS used by the semantic dashboard button.
    touch_interaction_guards = [
        'button, [role="button"], .grid-card-item, .menu-action-card {',
        "touch-action: manipulation;",
        ".grid-card-item > .card-icon-box,",
        ".grid-card-item > .card-title-text,",
        ':where(button, input, select, textarea, a, [tabindex]):focus-visible {',
        ".grid-card-item .card-icon-box {",
        ".grid-card-item .card-title-text {",
    ]
    missing_touch_guards = [guard for guard in touch_interaction_guards if guard not in source]
    if missing_touch_guards:
        errors.append("mobile touch/focus styling regression: " + ", ".join(missing_touch_guards))
    else:
        print("PASS: dashboard touch targets retain touch-action, decorative-child handling, card styling, and visible keyboard focus")

    # AI hub must provide clear capabilities, safe gateway status, quick prompts, and robust Excel parser fallbacks.
    ai_hub_guards = [
        'id="view-ai-excel-hub" class="page-view"',
        'مركز الذكاء الاصطناعي | ANAS AI',
        'id="anasAiHubConnectionStatus" role="status" aria-live="polite"',
        "function anasSetAiPrompt(promptText)",
        "function anasRefreshAiHubStatus()",
        "async function anasLoadSheetJs()",
        "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
        "https://cdn.jsdelivr.net/npm/xlsx@0.20.3/dist/xlsx.full.min.js",
        "https://unpkg.com/xlsx@0.20.3/dist/xlsx.full.min.js",
        "if(!window.XLSX) await anasLoadSheetJs();",
        "const maxImportBytes=20*1024*1024",
        "const maxImportRows=100000, maxImportColumns=200",
    ]
    missing_ai_hub_guards = [guard for guard in ai_hub_guards if guard not in source]
    if missing_ai_hub_guards:
        errors.append("AI hub capability/upload regression: " + ", ".join(missing_ai_hub_guards))
    else:
        print("PASS: AI hub has a professional entry panel, quick prompts, gateway status, and resilient Excel parser loading")
    if "anasGoBack()" not in source[source.find('id="view-ai-excel-hub"'):source.find('id="view-ai-excel-hub"') + 500]:
        errors.append("AI hub back button must use the app navigation history")
    else:
        print("PASS: AI hub back button uses application navigation history")

    # Inline handlers must encode persisted identifiers for the JavaScript string context.
    inline_id_safety_guards = [
        "editCustomer(decodeURIComponent('${encodeURIComponent(String(c.id ?? '')).replace(/'/g,'%27')}'))",
        "wtPrintVoucher(decodeURIComponent('${encodeURIComponent(String(d.id)).replace(/'/g,'%27')}'))",
        "anasTruckRemoveDraftItem(decodeURIComponent('${encodeURIComponent(String(x.productId)).replace(/'/g,'%27')}'))",
        "anasTruckSetStatus(decodeURIComponent('${encodeURIComponent(String(t.id)).replace(/'/g,'%27')}'),this.value)",
        "anasTruckSettle(decodeURIComponent('${encodeURIComponent(String(t.id)).replace(/'/g,'%27')}'))",
        "anasTruckRecordExpense(decodeURIComponent('${encodeURIComponent(String(t.id)).replace(/'/g,'%27')}'))",
        "anasTruckDelete(decodeURIComponent('${encodeURIComponent(String(t.id)).replace(/'/g,'%27')}'))",
        "<td>${safeNum(i.systemQty)}</td>",
    ]
    for guard in inline_id_safety_guards:
        if guard not in source:
            errors.append("inline ID or stocktake rendering safety guard is missing: " + guard)
    if not any("inline ID or stocktake rendering safety guard is missing:" in error for error in errors):
        print("PASS: customer, warehouse, truck IDs and stocktake quantities are safely rendered")


    # Stocktake approval must not coerce booleans, arrays, or blank strings into valid counts/balances.
    stocktake_strict_quantity_guards = [
        "const validStocktakeQuantity=value=>(typeof value==='number'||typeof value==='string')",
        "!validStocktakeQuantity(item.physicalQty)",
        "!validStocktakeQuantity(item.systemQty)",
        "!validStocktakeQuantity(p.stock)",
    ]
    if not all(guard in source for guard in stocktake_strict_quantity_guards):
        errors.append("stocktake approval must reject malformed/coercible physical, baseline, and current quantities")
    else:
        print("PASS: stocktake approval strictly validates physical and system quantities")

    # POS search IDs and cart images must remain safe with imported product data.
    pos_safety_guards = [
        "selectPosSearchProduct(decodeURIComponent('${encodeURIComponent(String(p.id)).replace(/'/g,'%27')}'))",
        "const safeCartImage = /^(https:\\/\\/|data:image\\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(cartImage) ? cartImage : '';",
        'src="${anasEscapeHTML(safeCartImage)}"',
        "${anasEscapeHTML(item.unit || '')}",
        "(typeof item.qty === 'number' || typeof item.qty === 'string') && item.qty !== null && item.qty !== undefined && item.qty !== '' && Number.isFinite(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : null",
        "(typeof item.price === 'number' || typeof item.price === 'string') && item.price !== null && item.price !== undefined && item.price !== '' && !(typeof item.price === 'string' && item.price.trim() === '') && Number.isFinite(Number(item.price)) && Number(item.price) >= 0 ? Number(item.price) : null",
        "hasInvalidCartValues ? 'بيانات السلة غير صالحة — راجع السعر والكمية' : total.toFixed(2) + ' د.ج'",
        "if (invalidCart) return;",
        "تعذر فتح الدفع: السلة تحتوي على كمية أو سعر غير صالح",
        "${sub===null||!Number.isFinite(sub)?'غير صالح':sub.toFixed(2)}",
    ]

    for guard in pos_safety_guards:
        if guard not in source:
            errors.append("POS search/cart HTML safety guard is missing: " + guard)
    if not any("POS search/cart HTML safety guard is missing:" in error for error in errors):
        print("PASS: POS search ID and cart image HTML guards exist")

    # Normalized POS cart price and quantity remain escaped at the HTML output boundary.
    pos_cart_numeric_escape_guards = [
        "${priceNumber===null?'غير صالح':anasEscapeHTML(priceNumber)}",
        "${qtyNumber===null?'غير صالح':anasEscapeHTML(qtyNumber)}",
        "(typeof item.qty === 'number' || typeof item.qty === 'string') && item.qty !== null && item.qty !== undefined && item.qty !== '' && Number.isFinite(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : null",
        "(typeof item.price === 'number' || typeof item.price === 'string') && item.price !== null && item.price !== undefined && item.price !== '' && !(typeof item.price === 'string' && item.price.trim() === '') && Number.isFinite(Number(item.price)) && Number(item.price) >= 0 ? Number(item.price) : null",
        "${anasEscapeHTML(item.unit || '')}",
    ]
    for guard in pos_cart_numeric_escape_guards:
        if guard not in source:
            errors.append("POS cart numeric normalization/escaping guard is missing: " + guard)
    if not any("POS cart numeric normalization/escaping guard is missing:" in error for error in errors):
        print("PASS: POS cart price, quantity, and unit are normalized/escaped safely")


    # saveDB must persist a detached cart snapshot before changing live cart state.
    save_db_start = source.find("function saveDB()")
    save_db_end = source.find("\n        function openDrawer()", save_db_start)
    save_db_source = source[save_db_start:save_db_end] if save_db_start >= 0 and save_db_end > save_db_start else ""
    if not (
        "const snapshot = { ...AppData, posScreensCarts: nextCarts };" in save_db_source
        and "localStorage.setItem(ANAS_DB_KEY, serialized);" in save_db_source
        and save_db_source.find("localStorage.setItem(ANAS_DB_KEY, serialized);") < save_db_source.find("AppData.posScreensCarts = nextCarts;")
        and "invalidCarts.code = 'ANAS_INVALID_POS_CARTS';" in save_db_source
    ):
        errors.append("saveDB must persist a detached cart snapshot before updating memory and reject malformed cart maps")
    else:
        print("PASS: saveDB keeps POS cart-map state atomic across persistence failures")

    # Customer data and imported product images must be safe at HTML output boundaries.
    safety_guards = [
        "anasEscapeHTML(c.phone || '-')",
        "(typeof c.debt === 'number' || typeof c.debt === 'string') && c.debt !== null && c.debt !== undefined && c.debt !== '' && !(typeof c.debt === 'string' && c.debt.trim() === '') && Number.isFinite(Number(c.debt)) ? Number(c.debt).toFixed(2) : 'غير صالح'",
        "const safeStoredImage = /^(https:\\/\\/|data:image\\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(storedImage) ? storedImage : '';",
        'src="${anasEscapeHTML(safeStoredImage)}"',
        "${i.remaining !== null && i.remaining !== undefined && i.remaining !== '' && Number.isFinite(Number(i.remaining)) ? Number(i.remaining) : 'غير صالح'}",
        "${i.total !== null && i.total !== undefined && i.total !== '' && Number.isFinite(Number(i.total)) ? Number(i.total) : 'غير صالح'}",
        "${reportDisplay(p.stock)}",
        "${esc(p.id??'—')}",
        "const reportNumber = value => (typeof value === 'number' || typeof value === 'string') && value !== null && value !== undefined && value !== '' && !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value)) ? Number(value) : null;",
        "${reportDisplay(p.total)}</td><td>${reportDisplay(p.paid)}</td><td>${reportDisplay(p.remaining)}</td>",
        "${reportDisplay(i.paid)}</td><td>${reportDisplay(i.remaining)}</td>",
        "${reportDisplay(c.debt)} د.ج",
        "بيانات غير صالحة",
        "غير صالح — توجد قيم ناقصة أو تالفة",
        "غير صالح — توجد قيمة فاتورة غير صالحة",
        "const invalidProfitNumber = value => !((typeof value === 'number') || (typeof value === 'string')) || String(value).trim() === '' || !Number.isFinite(Number(value));",
        "const invalidPresentNumber = (record, keys) =>",
        "if (invalidProfitData)",
        "تعذر حساب الأرباح بدقة: توجد قيمة مالية أو كمية غير صالحة",
        "const creditInvoices = reportInvoices.filter(i => reportNumber(i.remaining) === null || reportNumber(i.remaining) > 0);",
        "const lowStock = AppData.products.filter(p => { const stock=reportNumber(p.stock); const min=reportNumber(p.minAlert); return stock===null || stock <= (min!==null&&min>0?min:5); });",
        "${reportDisplay(p.stock)} (الحد: ${reportNumber(p.minAlert)!==null && reportNumber(p.minAlert)>0 ? reportNumber(p.minAlert) : 5})",
        "value===null?'غير صالح':value",
        "${reportDisplay(e.amt)} د.ج",
    ]
    for guard in safety_guards:
        if guard not in source:
            errors.append("customer/report/image output safety guard is missing: " + guard)
    if not any("customer/report/image output safety guard is missing:" in error for error in errors):
        print("PASS: customer debt, report numeric values, and stored image preview are hardened")

    backup_trip_values_start = source.find("function anasValidateBackupData(incoming)")
    backup_trip_values_end = source.find("function importDataBackup", backup_trip_values_start)
    backup_trip_values = source[backup_trip_values_start:backup_trip_values_end] if backup_trip_values_start >= 0 and backup_trip_values_end > backup_trip_values_start else ""
    if ("validateMoneyField(trip, 'cost', 'تكلفة الرحلات')" not in backup_trip_values
        or "validateMoneyField(trip, 'weight', 'وزن الرحلات')" not in backup_trip_values):
        errors.append("backup restore must validate persisted truck trip cost and weight")
    else:
        print("PASS: backup restore validates truck trip cost and weight")

    cloud_validator_start = source.find("function anasValidateIncomingSyncData(incoming) {")
    cloud_validator_end = source.find("async function syncPushNow()", cloud_validator_start)
    cloud_validator = source[cloud_validator_start:cloud_validator_end] if cloud_validator_start >= 0 and cloud_validator_end > cloud_validator_start else ""
    if ("['products', incoming.products, true]" not in cloud_validator
        or "['invoices', incoming.invoices, false]" not in cloud_validator
        or "['truckTrips', incoming.truckTrips || [], false]" not in cloud_validator
        or "معرّف مكرر في قائمة" not in cloud_validator):
        errors.append("cloud restore must reject duplicate product, invoice, and truck trip IDs")
    else:
        print("PASS: cloud restore rejects duplicate operational record IDs")

    # Both restore paths must validate the archived stocktake items, not only the top-level record ID.
    if ("for (const record of (incoming.stocktakeRecords || []))" not in cloud_validator
        or "const seenProducts = new Set();" not in cloud_validator
        or "item.physicalQty === null || item.physicalQty === undefined" not in cloud_validator):
        errors.append("cloud restore must reject malformed stocktake audit item lists and duplicate product rows")
    else:
        print("PASS: cloud restore validates stocktake audit contents")

    backup_stocktake_start = source.find("function anasValidateBackupData(incoming)")
    backup_stocktake_end = source.find("function importDataBackup", backup_stocktake_start)
    backup_stocktake_validator = source[backup_stocktake_start:backup_stocktake_end] if backup_stocktake_start >= 0 and backup_stocktake_end > backup_stocktake_start else ""
    if ("for (const record of (incoming.stocktakeRecords || []))" not in backup_stocktake_validator
        or "const seenProducts = new Set();" not in backup_stocktake_validator
        or "item.physicalQty === null || item.physicalQty === undefined" not in backup_stocktake_validator):
        errors.append("backup restore must reject malformed stocktake audit item lists and duplicate product rows")
    else:
        print("PASS: backup restore validates stocktake audit contents")

    # Cloud restore must enforce invoice arithmetic consistency just like file-backup restore.
    if ("Number(inv.paid) > Number(inv.total) + 0.000001" not in cloud_validator
        or "Math.abs(Number(inv.remaining) - Math.max(0, Number(inv.total) - Number(inv.paid))) > 0.01" not in cloud_validator):
        errors.append("cloud restore must reject invoice paid/remaining totals that are internally inconsistent")
    else:
        print("PASS: cloud restore rejects inconsistent invoice balances")

    if ("validateCloudMoney(trip, 'cost', 'تكلفة الرحلات')" not in cloud_validator
        or "validateCloudMoney(trip, 'weight', 'وزن الرحلات')" not in cloud_validator):
        errors.append("cloud restore must validate persisted truck trip cost and weight")
    else:
        print("PASS: cloud restore validates truck trip cost and weight")

    backup_validator_start = source.find("function anasValidateBackupData(incoming)")
    backup_validator_end = source.find("function importDataBackup", backup_validator_start)
    backup_validator = source[backup_validator_start:backup_validator_end] if backup_validator_start >= 0 and backup_validator_end > backup_validator_start else ""
    if ("['invoices', incoming.invoices || [], false]" not in backup_validator
        or "['truckTrips', incoming.truckTrips || [], false]" not in backup_validator):
        errors.append("backup restore must reject duplicate invoice and truck trip IDs")
    else:
        print("PASS: backup restore rejects duplicate operational record IDs")

    backup_start = source.find("function anasValidateBackupData(incoming)")
    backup_end = source.find("\n        function importDataBackup", backup_start)
    backup_fn = source[backup_start:backup_end] if backup_start >= 0 and backup_end > backup_start else ""
    if not backup_fn or "Number(raw) > Number.MAX_SAFE_INTEGER" not in backup_fn:
        errors.append("backup restore must reject unsafe financial magnitudes in every validated money field")
    else:
        print("PASS: backup restore rejects unsafe financial magnitudes")
    if (not backup_fn
        or "for (const transfer of (incoming.warehouseTransfers || []))" not in backup_fn
        or "Object.prototype.hasOwnProperty.call(transfer, 'quantity')" not in backup_fn
        or "كميات التحويل المخزني" not in backup_fn
        or "قيم سندات التحويل المخزني" not in backup_fn):
        errors.append("backup restore must require warehouse transfer quantity and validate prices/totals")
    else:
        print("PASS: backup restore validates warehouse transfer financial fields")

    debt_start = source.find("function collectCustDebt(cId)")
    debt_end = source.find("\n        function ", debt_start)
    debt_fn = source[debt_start:debt_end] if debt_start >= 0 and debt_end > debt_start else ""
    if not debt_fn or "previousDebt > Number.MAX_SAFE_INTEGER" not in debt_fn or "previousDebtValue = c.debt" not in debt_fn or "previousCashBalanceValue = AppData.caisseBalance" not in debt_fn or "if (hadCashBalance) AppData.caisseBalance = previousCashBalanceValue; else delete AppData.caisseBalance;" not in debt_fn:
        errors.append("customer debt collection must reject unsafe existing debt balances before mutating cash or debt")
    else:
        print("PASS: customer debt collection rejects unsafe debt balances")

    # Restore must validate truck expense links, not only the truck UI action.
    if ("function anasValidateTruckExpenseLinks(incoming)" not in source
        or "anasValidateTruckExpenseLinks(incoming);" not in source
        or "matchingForTrip.length > 1" not in source
        or "matches[0].sourceType !== 'truck_trip'" not in source
        or "amount !== cost" not in source):
        errors.append("cloud and backup restore must reject stale, duplicate, mismatched truck expense links")
    else:
        print("PASS: restore validates truck expense links against trip and expense ledgers")

    # Execute the shared truck-expense restore validator against valid and corrupt ledger relationships.
    truck_link_start = source.find("function anasValidateTruckExpenseLinks(incoming) {")
    truck_link_end = source.find("\n        function anasValidateIncomingSyncData", truck_link_start)
    truck_link_fn = source[truck_link_start:truck_link_end] if truck_link_start >= 0 and truck_link_end > truck_link_start else ""
    if not truck_link_fn:
        errors.append("cannot locate truck expense link validator for runtime regression tests")
    else:
        truck_link_harness = r"""
const vm = require('node:vm');
const validator = __VALIDATOR__;
const context = {};
vm.createContext(context);
vm.runInContext(validator + '\nthis.validate = anasValidateTruckExpenseLinks;', context);
const validate = context.validate;
const good = {truckTrips:[{id:'T-1',cost:125,expenseId:'E-1'}],expenses:[{id:'E-1',amt:125,sourceType:'truck_trip',sourceId:'T-1'}]};
validate(good);
validate({truckTrips:[{id:'T-2',cost:10}],expenses:[]});
const rejects = [
  {truckTrips:[{id:'T-1',cost:125}],expenses:[{id:'E-1',amt:125,sourceType:'truck_trip',sourceId:'missing'}]},
  {truckTrips:[{id:'T-1',cost:125}],expenses:[{id:'E-1',amt:125,sourceType:'truck_trip',sourceId:'T-1'},{id:'E-2',amt:125,sourceType:'truck_trip',sourceId:'T-1'}]},
  {truckTrips:[{id:'T-1',cost:125}],expenses:[{id:'E-1',amt:124,sourceType:'truck_trip',sourceId:'T-1'}]},
  {truckTrips:[{id:'T-1',cost:125,expenseId:'missing'}],expenses:[]},
  {truckTrips:[{id:'T-1',cost:125}],expenses:[{id:'E-1',amt:125,sourceType:'truck_trip',sourceId:'T-1'},{id:'E-1',amt:125,account:'other'}]}
];
for (const sample of rejects) {
  let rejected = false;
  try { validate(sample); } catch (_) { rejected = true; }
  if (!rejected) throw new Error('corrupt truck expense link was accepted: ' + JSON.stringify(sample));
}
console.log('PASS: truck expense link runtime tests accept valid/legacy-unlinked trips and reject orphaned, duplicate, stale, or mismatched links');
"""
        truck_link_harness = truck_link_harness.replace("__VALIDATOR__", json.dumps(truck_link_fn))
        with tempfile.TemporaryDirectory(prefix="anas-truck-expense-test-") as temp:
            test_path = Path(temp) / "truck-expense-links.js"
            test_path.write_text(truck_link_harness, encoding="utf-8")
            result = subprocess.run(["node", str(test_path)], capture_output=True, text=True)
            if result.returncode:
                errors.append("truck expense link runtime test failed: " + (result.stderr or result.stdout).strip()[:500])
            else:
                print(result.stdout.strip())

    # Combined POS/warehouse integration must retain the warehouse preflight and payment guards.
    sale_start = source.find("function confirmHasibPayment()")
    sale_end = source.find("\n        function ", sale_start)
    sale_fn = source[sale_start:sale_end] if sale_start >= 0 and sale_end > sale_start else ""
    transfer_start = source.find("function wtCreateTransfer()")
    transfer_end = source.find("\n        function ", transfer_start)
    transfer_fn = source[transfer_start:transfer_end] if transfer_start >= 0 and transfer_end > transfer_start else ""
    modal_start = source.find("function openHasibModal()")
    modal_end = source.find("\n        function ", modal_start)
    modal_fn = source[modal_start:modal_end] if modal_start >= 0 and modal_end > modal_start else ""
    if not sale_fn or "wtTryEnsureData" not in sale_fn or "hasDebtField" not in sale_fn or "stock > Number.MAX_SAFE_INTEGER" not in sale_fn or "رصيد المخزون غير صالح أو يتجاوز المجال الرقمي الآمن" not in sale_fn:
        errors.append("integrated POS payment must retain warehouse preflight and malformed customer-debt rejection")
    if not transfer_fn or "if(!wtTryEnsureData())return;" not in transfer_fn:
        errors.append("integrated warehouse transfer must validate persisted stock data before mutation")
    if not transfer_fn or "WAREHOUSE_TRANSFER_OUT" not in transfer_fn or "WAREHOUSE_TRANSFER_IN" not in transfer_fn or "const movementsBefore=AppData.stockMovements.slice();" not in transfer_fn or "AppData.stockMovements=movementsBefore;" not in transfer_fn:
        errors.append("warehouse transfers must write balanced source/destination stock-ledger entries and roll them back on save failure")
    if not transfer_fn or "usedTransferIds" not in transfer_fn or "usedMovementIds" not in transfer_fn or "usedTransferNumbers" not in transfer_fn or "while(usedTransferNumbers.has(transferNumber))" not in transfer_fn:
        errors.append("warehouse transfer creation must prevent ID, ledger-leg ID, and voucher number collisions")
    if not transfer_fn or "const hadMainStock=Object.prototype.hasOwnProperty.call(p,'stock');" not in transfer_fn or "if(hadMainStock)p.stock=beforeMain;else delete p.stock;" not in transfer_fn:
        errors.append("warehouse transfer rollback must preserve whether the main stock property originally existed")
    if not modal_fn or "تعذر فتح الدفع: السلة تحتوي على كمية أو سعر غير صالح" not in modal_fn or "return;" not in modal_fn:
        errors.append("integrated POS payment modal must remain blocked for malformed cart values")
    if sale_fn and transfer_fn and modal_fn and "wtTryEnsureData" in sale_fn and "hasDebtField" in sale_fn and "if(!wtTryEnsureData())return;" in transfer_fn and "تعذر فتح الدفع: السلة تحتوي على كمية أو سعر غير صالح" in modal_fn and "return;" in modal_fn:
        print("PASS: integrated POS payment and warehouse mutation guards remain intact")

    # Editing a historical invoice must not coerce corrupt customer debt or overwrite a corrupt stock ledger.
    edit_start = source.find("function editSalesInvoice(invoiceId)")
    edit_end = source.find("\n        function ", edit_start)
    edit_fn = source[edit_start:edit_end] if edit_start >= 0 and edit_end > edit_start else ""
    edit_guards = [
        "Number(item.qty) > Number.MAX_SAFE_INTEGER",
        "qty > Number.MAX_SAFE_INTEGER",
        "رصيد دين العميل غير صالح. أصلح سجل العميل قبل أي تعديل مالي",
        "available + delta > Number.MAX_SAFE_INTEGER",
        "خريطة أرصدة المخازن الفرعية تالفة للمنتج",
        "سجل حركات المخزون تالف. أصلح السجل أو استعد نسخة سليمة",
        "AppData.stockMovements.some(m => !m || typeof m !== 'object' || Array.isArray(m))",
    ]
    if not edit_fn or any(guard not in edit_fn for guard in edit_guards):
        errors.append("historical invoice editing must reject corrupt debt, warehouse maps, and stock movement history before mutation")
    else:
        print("PASS: invoice edits fail closed on corrupt financial and inventory records")

    # Startup must not silently replace present-but-corrupt persisted collections or save over unreadable data.
    if "if (!Object.prototype.hasOwnProperty.call(AppData, k))" not in source or "anasStartupIntegrityIssues.push(k)" not in source:
        errors.append("startup must initialize only absent collections and preserve present invalid collections")
    else:
        print("PASS: startup preserves present-but-invalid collections")

    if "anasStartupFatalLoadError = true" not in source or "if (anasStartupFatalLoadError || anasStartupIntegrityIssues.length)" not in source:
        errors.append("startup must block saves after unreadable JSON or invalid persisted collection shapes")
    else:
        print("PASS: startup blocks writes when persisted data integrity is uncertain")

    if "AppData.posScreensCarts && typeof AppData.posScreensCarts === 'object' && !Array.isArray(AppData.posScreensCarts)" not in source:
        errors.append("startup must not dereference malformed POS cart containers")
    else:
        print("PASS: startup safely reads the active POS cart")

    # Execute the actual startup block against malformed, unreadable, and legacy-but-incomplete saved data.
    startup_start = source.find("const ANAS_DB_KEY = 'ANAS_THE_ENTERPRISE_V11_OFFLINE';")
    startup_end_marker = "let activeAiTab = 'all';"
    startup_end = source.find(startup_end_marker, startup_start)
    if startup_start < 0 or startup_end < 0:
        errors.append("cannot locate startup block for runtime integrity smoke test")
    else:
        startup_js = source[startup_start:startup_end + len(startup_end_marker)]
        harness = r"""
const vm = require('node:vm');
const startup = __STARTUP__;
function boot(saved) {
  const writes = { count: 0 };
  const alerts = [];
  const initialDB = { products: [], customers: [], suppliers: [], invoices: [],
    purchaseInvoices: [], expenses: [], users: [], alerts: [], warehouseTransfers: [],
    warehouses: [], truckTrips: [], posScreensCarts: {1: []}, activePosScreenTab: 1 };
  const localStorage = { getItem: () => saved, setItem: () => { writes.count++; } };
  const context = { initialDB, localStorage, setTimeout: () => {}, alert: x => alerts.push(String(x)), console };
  vm.createContext(context);
  vm.runInContext(startup + "\nthis.__snapshot = { products: AppData.products, issues: anasStartupIntegrityIssues.slice(), fatal: anasStartupFatalLoadError, cart: posCart, writes: localStorage.setItem ? 0 : -1 };", context);
  return { ...context.__snapshot, alerts, writeCalls: writes.count };
}
const corrupt = boot(JSON.stringify({ products: null, posScreensCarts: {1: []} }));
if (corrupt.products !== null || !corrupt.issues.includes('products') || corrupt.fatal || corrupt.cart.length !== 0)
  throw new Error('present corrupt collection was not preserved/guarded safely');
const unreadable = boot('{not-json');
if (!unreadable.fatal || unreadable.writeCalls !== 0)
  throw new Error('unreadable saved JSON did not enter fail-safe mode');
const legacy = boot(JSON.stringify({ appName: 'Anas ERP' }));
if (!Array.isArray(legacy.products) || legacy.issues.length || legacy.fatal)
  throw new Error('absent legacy collections were not initialized safely');
const corruptCartSlot = boot(JSON.stringify({ products: [], posScreensCarts: {1: 'corrupt-cart'}, activePosScreenTab: 1 }));
if (!corruptCartSlot.issues.includes('posScreensCarts.1') || corruptCartSlot.cart.length !== 0)
  throw new Error('malformed POS cart slot was not preserved and blocked for safe handling');
console.log('PASS: startup runtime smoke tests preserve corrupt data, fail safe on unreadable JSON, initialize absent legacy collections, and detect malformed POS cart slots');
"""
        harness = harness.replace("__STARTUP__", json.dumps(startup_js))
        with tempfile.TemporaryDirectory(prefix="anas-startup-test-") as temp:
            test_path = Path(temp) / "startup-smoke.js"
            test_path.write_text(harness, encoding="utf-8")
            result = subprocess.run(["node", str(test_path)], capture_output=True, text=True)
            if result.returncode:
                errors.append("startup runtime smoke test failed: " + (result.stderr or result.stdout).strip()[:500])
            else:
                print(result.stdout.strip())

    # Execute the real saveDB function to prove corrupt startup state blocks persistent writes.
    save_start = source.find("function saveDB() {")
    save_end = source.find("function openDrawer()", save_start)
    if save_start < 0 or save_end < 0:
        errors.append("cannot locate saveDB function for startup write-block runtime test")
    else:
        save_js = source[save_start:save_end]
        save_harness = r"""
const vm = require('node:vm');
const saveFunction = __SAVE_FUNCTION__;
function attempt(fatal, issues) {
  let writes = 0;
  const alerts = [];
  const context = {
    anasStartupFatalLoadError: fatal,
    anasStartupIntegrityIssues: issues,
    alert: message => alerts.push(String(message)),
    console,
    AppData: { posScreensCarts: {1: []}, activePosScreenTab: 1 },
    posCart: [],
    ANAS_DB_KEY: 'test-key',
    localStorage: { setItem: () => { writes++; } },
    updateUIState: () => {},
    checkSystemAlerts: () => {},
    updateDashboardStats: () => {}
  };
  vm.createContext(context);
  vm.runInContext(saveFunction + '\nthis.__save = saveDB();', context);
  return { result: context.__save, writes, alerts };
}
const unreadable = attempt(true, []);
if (unreadable.result !== false || unreadable.writes !== 0 || !unreadable.alerts.length)
  throw new Error('saveDB must refuse writes after unreadable persisted JSON');
const malformed = attempt(false, ['products']);
if (malformed.result !== false || malformed.writes !== 0 || !malformed.alerts.length)
  throw new Error('saveDB must refuse writes when persisted collections are malformed');
const healthy = attempt(false, []);
if (healthy.result !== true || healthy.writes !== 1)
  throw new Error('saveDB must continue to persist valid state exactly once');
console.log('PASS: saveDB runtime tests block writes for corrupt startup state and preserve normal saves');
"""
        save_harness = save_harness.replace("__SAVE_FUNCTION__", json.dumps(save_js))
        with tempfile.TemporaryDirectory(prefix="anas-save-guard-test-") as temp:
            test_path = Path(temp) / "save-guard-smoke.js"
            test_path.write_text(save_harness, encoding="utf-8")
            result = subprocess.run(["node", str(test_path)], capture_output=True, text=True)
            if result.returncode:
                errors.append("saveDB runtime guard test failed: " + (result.stderr or result.stdout).strip()[:500])
            else:
                print(result.stdout.strip())

    user_warehouse_start = source.find("function wtEnsureUserWarehouse(user)")
    user_warehouse_end = source.find("function wtCurrentSaleWarehouse()", user_warehouse_start)
    user_warehouse_helper = source[user_warehouse_start:user_warehouse_end] if user_warehouse_start >= 0 and user_warehouse_end > user_warehouse_start else ""
    if "if(!Object.prototype.hasOwnProperty.call(AppData,'warehouses'))AppData.warehouses=[];" not in user_warehouse_helper or "AppData.warehouses.some(w=>" not in user_warehouse_helper or "if(!Array.isArray(AppData.warehouses))AppData.warehouses=[];" in user_warehouse_helper:
        errors.append("user warehouse assignment must preserve and reject malformed persisted warehouse lists")
    else:
        print("PASS: user warehouse assignment fails closed on malformed warehouse lists")

    # Imported product/customer names must be escaped in alert HTML; user names must use textContent.
    alert_and_badge_guards = [
        "const productName = anasEscapeHTML(String(p.name || 'منتج بدون اسم'));",
        "const customerName = anasEscapeHTML(String(c.name || 'عميل بدون اسم'));",
        "Number.isFinite(stockValue) && stockValue <= (Number(p.minAlert) || 5)",
        "Number.isFinite(debt) && debt > 0 && days > 30",
        "document.getElementById('topUserQuickBadge').textContent = '👑 ' + String(cur?.name ?? '');",
        "document.getElementById('drawerUserName').textContent = String(cur?.name ?? '');",
    ]
    for guard in alert_and_badge_guards:
        if guard not in source:
            errors.append("alert/user-badge safety guard is missing: " + guard)
    if not any("alert/user-badge safety guard is missing:" in error for error in errors):
        print("PASS: alert names are escaped and user badge is rendered as text")

    # Z report output is an HTML sink; escape configurable metadata and normalize cash before rendering.
    z_report_guards = [
        "anasEscapeHTML(AppData.appName || '')",
        'anasEscapeHTML(getReportRange().from || "—")',
        'anasEscapeHTML(getReportRange().to || "—")',
        "function anasFormatZReportCashBalance(value)",
        "anasFormatZReportCashBalance(AppData.caisseBalance)",
        "typeof value === 'number' || typeof value === 'string'",
        "String(value).trim() !== '' && Number.isFinite(Number(value))",
        "function anasGetZReportTotal(invoices, field)",
        "const totSales = anasGetZReportTotal(reportInvoices, 'total')",
        "const totPaid = anasGetZReportTotal(reportInvoices, 'paid')",
        "const totRem = anasGetZReportTotal(reportInvoices, 'remaining')",
        "anasFormatZReportTotal(totSales)",
        "anasFormatZReportTotal(totPaid)",
        "anasFormatZReportTotal(totRem)",
        "total += Number(value)",
    ]
    for guard in z_report_guards:
        if guard not in source:
            errors.append("Z report safety guard is missing: " + guard)
    if not any("Z report safety guard is missing:" in error for error in errors):
        print("PASS: Z report metadata is escaped and cash balance is normalized")

    counts = Counter(parser.ids)
    duplicates = sorted(key for key, count in counts.items() if count > 1)
    if duplicates:
        errors.append("duplicate HTML IDs: " + ", ".join(duplicates[:20]))
    else:
        print(f"PASS: {len(parser.ids)} non-empty HTML IDs are unique")

        # Catch common project-function calls from inline event handlers that no longer resolve.
    # This intentionally targets app-style names, not browser built-ins or arbitrary expressions.
    defined = set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", source))
    defined.update(re.findall(r"\bwindow\.([A-Za-z_$][\w$]*)\s*=", source))
    defined.update(re.findall(
        r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)",
        source,
    ))
    app_call = re.compile(
        r"\b((?:anas[A-Za-z0-9_$]*|wt[A-Z][A-Za-z0-9_$]*|"
        r"(?:open|save|render|submit|update|delete|add|edit|close|show|toggle|sync|import|export|print|quick|select|change|clear|confirm|cancel|return|switch|post|ask|trigger|apply|check|load|reset|filter|handle|collect|record|request|detect|populate|refresh|remove|preview|run|send|copy|reprint)[A-Z][A-Za-z0-9_$]*))\s*\("
    )
    unresolved = sorted({
        name for handler in parser.inline_handlers for name in app_call.findall(handler)
        if name not in defined
    })
    if unresolved:
        errors.append("unresolved app functions in inline event handlers: " + ", ".join(unresolved[:30]))
    else:
        print(f"PASS: {len(parser.inline_handlers)} inline event handlers have no unresolved app-function calls")

    if "<!doctype html" not in source.lower():
        errors.append("HTML doctype is missing")
    else:
        print("PASS: HTML doctype exists")

    if 'rel="manifest"' not in source.lower() and "rel='manifest'" not in source.lower():
        errors.append("PWA manifest link is missing")
    elif not (ROOT / "manifest.webmanifest").exists():
        errors.append("manifest.webmanifest is linked but missing")
    else:
        print("PASS: PWA manifest is linked and file exists")

    # POS sale must validate all warehouse balances and customer debt before financial mutation.
    if "if (typeof wtTryEnsureData === 'function' && !wtTryEnsureData()) return;" not in source:
        errors.append("POS sale must run warehouse preflight before mutating stock")
    if "Object.prototype.hasOwnProperty.call(cust,'debt')" not in source or "رصيد دين العميل غير صالح" not in source:
        errors.append("POS sale must reject malformed stored customer debt instead of coercing it to zero")
    if not any("POS sale must validate" in error or "POS sale must run" in error for error in errors):
        print("PASS: POS sale validates warehouse balances and customer debt before mutation")

    # POS sale must fail closed on malformed customer/invoice collections and cash balance.
    sale_start = source.find("function confirmHasibPayment()")
    sale_end = source.find("\n        function printLastConfirmedInvoice", sale_start)
    sale_source = source[sale_start:sale_end] if sale_start >= 0 and sale_end > sale_start else ""

    # POS cart +/- actions must not normalize malformed persisted quantities through Number(value || 0).
    pos_quantity_edit_start = source.find("function changePosQty(idx, delta)")
    pos_quantity_edit_end = source.find("\n        function ", pos_quantity_edit_start)
    pos_quantity_edit = source[pos_quantity_edit_start:pos_quantity_edit_end] if pos_quantity_edit_start >= 0 and pos_quantity_edit_end > pos_quantity_edit_start else ""
    if ("typeof rawQty === 'number'" not in pos_quantity_edit or
        "rawQty.trim() === ''" not in pos_quantity_edit or
        "Number(rawQty) > Number.MAX_SAFE_INTEGER" not in pos_quantity_edit or
        "next > Number.MAX_SAFE_INTEGER" not in pos_quantity_edit):
        errors.append("POS cart quantity edit must reject malformed or unsafe current and resulting quantities")
    else:
        print("PASS: POS cart quantity edits reject malformed or unsafe values")

    # POS sale must not coerce malformed persisted cart quantities/prices (e.g. true or [1]) into numbers.
    pos_strict_cart_guards = [
        "typeof item.qty === 'number') || (typeof item.qty === 'string'",
        "typeof item.qty === 'string' && item.qty.trim() === ''",
        "qty > Number.MAX_SAFE_INTEGER",
        "typeof item.price === 'number') || (typeof item.price === 'string'",
        "typeof item.price === 'string' && item.price.trim() === ''",
        "price > Number.MAX_SAFE_INTEGER",
    ]
    if not all(guard in sale_source for guard in pos_strict_cart_guards):
        errors.append("POS sale must reject coerced or unsafe cart quantities and prices before stock mutation")
    else:
        print("PASS: POS sale rejects malformed and unsafe cart values")
    sale_integrity_guards = [
        "Object.prototype.hasOwnProperty.call(AppData, 'customers')",
        "AppData.customers.some(c => !c || typeof c !== 'object' || Array.isArray(c))",
        "Object.prototype.hasOwnProperty.call(AppData, 'invoices')",
        "AppData.invoices.some(inv => !inv || typeof inv !== 'object' || Array.isArray(inv))",
        "Object.prototype.hasOwnProperty.call(AppData, 'caisseBalance')",
        "Number(AppData.caisseBalance) < 0",
        "رصيد الصندوق غير صالح",
    ]
    if not sale_source or any(guard not in sale_source for guard in sale_integrity_guards):
        errors.append("POS sale must reject malformed customer/invoice collections and invalid cash balance before mutation")
    else:
        print("PASS: POS sale rejects malformed financial collections and invalid cash balance before mutation")

    # Malformed array-shaped warehouse maps must block stock mutation, not be silently reset.
    sale_guard = "saleWarehouse !== 'المخزن الرئيسي' && Array.isArray(product.warehouseStock)"
    transfer_guard = "if(Array.isArray(p.warehouseStock)){alert('تعذر التحويل: خريطة أرصدة المخازن الفرعية تالفة لهذا المنتج. أصلح البيانات أو استعد نسخة سليمة قبل المتابعة.');return;}"
    settlement_guard = "if(Array.isArray(p.warehouseStock))throw new Error('خريطة أرصدة المخازن الفرعية تالفة"
    if sale_guard not in source or transfer_guard not in source or settlement_guard not in source:
        errors.append("POS, warehouse transfer, and truck settlement must fail closed on malformed warehouse stock maps")
    else:
        print("PASS: stock mutation paths fail closed on malformed warehouse maps")

    # Truck settlement must reject blank prompt inputs instead of Number('') silently becoming zero.
    settlement_prompt_guards = [
        "typeof deliveredRaw!=='string'||deliveredRaw.trim()===''",
        "typeof returnedRaw!=='string'||returnedRaw.trim()===''",
        "typeof damagedRaw!=='string'||damagedRaw.trim()===''",
        "typeof missingRaw!=='string'||missingRaw.trim()===''",
    ]
    if not all(guard in source for guard in settlement_prompt_guards):
        errors.append("truck settlement must reject blank delivered, returned, damaged, and missing quantity prompts")
    else:
        print("PASS: truck settlement rejects blank quantity prompts")

    # Truck settlement must reject aggregate quantity overflow before any stock or invoice mutation.
    settlement_aggregate_guards = [
        "let deliveredTotal=0;",
        "productDelivered>Number.MAX_SAFE_INTEGER",
        "deliveredTotal>Number.MAX_SAFE_INTEGER",
        "const nextInvoiced=(invoiced.get(key)||0)+qty;",
        "nextInvoiced>Number.MAX_SAFE_INTEGER",
    ]
    if not all(guard in source for guard in settlement_aggregate_guards):
        errors.append("truck settlement must reject per-product and total delivered/invoiced quantity overflow")
    else:
        print("PASS: truck settlement rejects unsafe aggregate quantities")

    # Truck stock posting must validate all persisted data before mutation and preserve corrupt ledgers.
    truck_preflight_guards = [
        "Object.prototype.hasOwnProperty.call(AppData,'stockMovements')&&(!Array.isArray(AppData.stockMovements)||AppData.stockMovements.some(m=>!m||typeof m!=='object'||Array.isArray(m)))",
        "Object.prototype.hasOwnProperty.call(AppData,'warehouses')&&(!Array.isArray(AppData.warehouses)||AppData.warehouses.some(w=>!(typeof w==='string'&&w.trim())&&(!w||typeof w!=='object'||Array.isArray(w)||typeof w.name!=='string'||!w.name.trim())))",
        "Object.prototype.hasOwnProperty.call(p,'warehouseStock')&&(!p.warehouseStock||typeof p.warehouseStock!=='object'||Array.isArray(p.warehouseStock))",
        "!((typeof p.stock==='number')||(typeof p.stock==='string'))||String(p.stock).trim()===''||!Number.isFinite(Number(p.stock))||Number(p.stock)<0",
        "const hadStockMovements=Object.prototype.hasOwnProperty.call(AppData,'stockMovements');",
        "if(!hadStockMovements)AppData.stockMovements=[];",
    ]
    for guard in truck_preflight_guards:
        if guard not in source:
            errors.append("truck stock posting preflight is missing: " + guard)
    if not any("truck stock posting preflight is missing:" in error for error in errors):
        print("PASS: truck posting rejects corrupt persisted maps/ledgers before mutation")

    # Truck loading must reject malformed maps before mutation; settlement rollback must preserve array shape.
    load_guard = "Object.prototype.hasOwnProperty.call(p,'warehouseStock')&&(!p.warehouseStock||typeof p.warehouseStock!=='object'||Array.isArray(p.warehouseStock))"
    settlement_snapshot = "warehouseStock:Array.isArray(p.warehouseStock)?p.warehouseStock.slice()"
    settlement_restore = "if(old.hadWarehouseStock)old.p.warehouseStock=old.warehouseStock;else delete old.p.warehouseStock"
    settlement_stock_presence_restore = "if(old.hadStock)old.p.stock=old.stock;else delete old.p.stock"
    load_snapshot = "warehouseStock:Array.isArray(p.warehouseStock)?p.warehouseStock.slice()"
    load_restore = "oldStocks.forEach(x=>{if(x.hadStock)x.p.stock=x.stock;else delete x.p.stock;if(x.hadWarehouseStock)x.p.warehouseStock=x.warehouseStock;else delete x.p.warehouseStock;});"
    if load_guard not in source or settlement_snapshot not in source or settlement_restore not in source or settlement_stock_presence_restore not in source or load_snapshot not in source or load_restore not in source:
        errors.append("truck load guard or rollback preservation for malformed warehouse maps is missing")
    else:
        print("PASS: truck loading blocks malformed maps and rollback preserves original map shape")

    # Mobile warehouse creation and truck movement history must fail closed too.
    if "else if(!Array.isArray(AppData.stockMovements)||AppData.stockMovements.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw new Error('سجل حركات المخزون تالف" not in source:
        errors.append("warehouse preflight must reject malformed stock movement history")
    if "else if(!Array.isArray(AppData.warehouses)||AppData.warehouses.some(w=>!(typeof w==='string'&&w.trim())&&(!w||typeof w!=='object'||Array.isArray(w)||typeof w.name!=='string'||!w.name.trim()))){alert('قائمة المخازن تالفة؛ أُوقفت عملية الشاحنة دون استبدال البيانات.');return null;}" not in source:
        errors.append("truck warehouse creation must not replace malformed warehouse data")
    if "if(wtEnsureMobileWarehouse(warehouseName)===null)throw new Error('تعذر إنشاء مخزن الشاحنة بسبب فساد قائمة المخازن.');" not in source:
        errors.append("truck loading must abort when mobile warehouse creation fails")
    if not any("warehouse preflight must reject malformed stock movement history" in error or "truck warehouse creation must not replace malformed warehouse data" in error or "truck loading must abort when mobile warehouse creation fails" in error for error in errors):
        print("PASS: truck operations preserve malformed warehouse and movement histories")

    # Truck settlement must detect orphaned ledger entries before applying stock changes again.
    settlement_ledger_guards = [
        "Object.prototype.hasOwnProperty.call(AppData,'stockMovements')&&(!Array.isArray(AppData.stockMovements)||AppData.stockMovements.some(m=>!m||typeof m!=='object'||Array.isArray(m)))",
        "String(m.referenceType||'')==='truck_settlement'&&String(m.referenceId||'')===settlementId",
        "عُثر على حركات تسوية سابقة لهذه الرحلة دون علامة تسوية موثوقة",
    ]
    for guard in settlement_ledger_guards:
        if guard not in source:
            errors.append("truck settlement idempotency guard is missing: " + guard)
    if not any("truck settlement idempotency guard is missing:" in error for error in errors):
        print("PASS: truck settlement rejects orphaned prior ledger entries and malformed movement history")

    # Settlement must reject invalid main/truck balances before it mutates any product.
    settlement_balance_guards = [
        "رصيد المخزن الرئيسي غير صالح أو يتجاوز المجال الرقمي الآمن للمنتج '+line.productName+'؛ أُوقفت التسوية دون تعديل الأرصدة.",
        "رصيد مخزن الشاحنة غير صالح أو يتجاوز المجال الرقمي الآمن للمنتج '+line.productName+'؛ أُوقفت التسوية دون تعديل الأرصدة.",
        "if(p.warehouseStock&&Object.prototype.hasOwnProperty.call(p.warehouseStock,warehouse)){",
    ]
    for guard in settlement_balance_guards:
        if guard not in source:
            errors.append("truck settlement balance preflight is missing: " + guard)
    for guard in [
        "Number(p.stock)>Number.MAX_SAFE_INTEGER",
        "Number(p.stock)+line.returned>Number.MAX_SAFE_INTEGER",
        "Number(balance)>Number.MAX_SAFE_INTEGER",
    ]:
        if guard not in source:
            errors.append("truck settlement safe numeric bound is missing: " + guard)
    if not any("truck settlement balance preflight is missing:" in error for error in errors):
        print("PASS: truck settlement validates main and truck balances before stock mutation")

    # Existing malformed history must fail closed rather than being silently replaced with empty arrays.
    history_guard = "else if(!Array.isArray(AppData.warehouseTransfers)||AppData.warehouseTransfers.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw new Error('سجل تحويلات المخازن تالف"
    warehouses_guard = "else if(!Array.isArray(AppData.warehouses)||AppData.warehouses.some(w=>!(typeof w==='string'&&w.trim())&&(!w||typeof w!=='object'||Array.isArray(w)||typeof w.name!=='string'||!w.name.trim())))throw new Error('قائمة المخازن تالفة"
    warehouse_record_guard = "AppData.warehouses.some(w=>!(typeof w==='string'&&w.trim())&&(!w||typeof w!=='object'||Array.isArray(w)||typeof w.name!=='string'||!w.name.trim()))"
    products_guard = "if(!Array.isArray(AppData.products))throw new Error('قائمة المنتجات غير صالحة"
    product_record_guard = "if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('سجل منتج غير صالح"
    map_guard = "if(Object.prototype.hasOwnProperty.call(p,'warehouseStock')&&(!p.warehouseStock||typeof p.warehouseStock!=='object'||Array.isArray(p.warehouseStock)))throw new Error('خريطة أرصدة المخازن غير صالحة"
    if history_guard not in source or warehouses_guard not in source or warehouse_record_guard not in source or products_guard not in source or product_record_guard not in source or map_guard not in source:
        errors.append("warehouse initialization must preserve malformed history and reject invalid product/map shapes")
    else:
        print("PASS: warehouse initialization fails closed without silently replacing malformed history")

    # Missing maps may be initialized for legacy products, but explicit null/invalid maps must not be erased.
    missing_only_guard = "AppData.products.forEach(p=>{if(!Object.prototype.hasOwnProperty.call(p,'warehouseStock'))p.warehouseStock={};});"
    guarded_ui_calls = [
        "function wtTryEnsureData(){try{wtEnsureData();return true;}catch(e){alert((e&&e.message)||'بيانات المخازن غير صالحة. أُوقفت العملية دون تعديل الأرصدة.');return false;}}",
        "if(!wtTryEnsureData())return; const from=document.getElementById('wtFrom')",
        "if(!wtTryEnsureData())return;const from=document.getElementById('wtFrom').value",
        "function wtInitStockScreen(){if(!wtTryEnsureData())return;",
    ]
    if missing_only_guard not in source or map_guard not in source:
        errors.append("warehouseStock initialization must preserve explicit null/malformed values instead of silently replacing them")
    else:
        print("PASS: only absent warehouseStock maps are initialized; explicit malformed maps fail closed")
    for guard in guarded_ui_calls:
        if guard not in source:
            errors.append("warehouse validation UI handling is missing: " + guard)
    if not any("warehouse validation UI handling is missing:" in error for error in errors):
        print("PASS: warehouse screen, transfer, and stock screen surface validation errors safely")

    # Existing numeric balances must be validated before legacy maps are initialized.
    numeric_balance_guards = [
        "(!((typeof p.stock==='number')||(typeof p.stock==='string')))||p.stock===null||p.stock===''||(typeof p.stock==='string'&&p.stock.trim()==='')||!Number.isFinite(Number(p.stock))||Number(p.stock)<0",
        "!((typeof value==='number')||(typeof value==='string'))||value===null||value===''||(typeof value==='string'&&value.trim()==='')||!Number.isFinite(Number(value))||Number(value)<0",
        "// Initialize legacy maps only after every existing record passes validation.",
    ]
    for guard in numeric_balance_guards:
        if guard not in source:
            errors.append("warehouse numeric balance preflight guard is missing: " + guard)
    if not any("warehouse numeric balance preflight guard is missing:" in error for error in errors):
        print("PASS: invalid numeric stock balances fail closed before legacy-map initialization")

    # POS rollback must preserve malformed map shape, and transfers must fail closed from either side.
    sale_snapshot = "warehouseStock:Array.isArray(p.warehouseStock)?p.warehouseStock.slice()"
    sale_restore = "if(stockState.hadWarehouseStock)p.warehouseStock=stockState.warehouseStock;"
    transfer_guard_any_direction = "if(Array.isArray(p.warehouseStock)){alert('تعذر التحويل: خريطة أرصدة المخازن الفرعية تالفة لهذا المنتج. أصلح البيانات أو استعد نسخة سليمة قبل المتابعة.');return;}"
    if sale_snapshot not in source or sale_restore not in source or transfer_guard_any_direction not in source:
        errors.append("POS rollback must preserve malformed warehouse map shape and transfers must reject it")
    else:
        print("PASS: POS rollback preserves malformed maps and transfers reject them from either direction")

    warehouse_names_guard = "if(p.warehouseStock&&typeof p.warehouseStock==='object'&&!Array.isArray(p.warehouseStock))Object.keys(p.warehouseStock)"
    if warehouse_names_guard not in source:
        errors.append("warehouse selector must ignore array-shaped warehouseStock maps")
    else:
        print("PASS: warehouse selector ignores malformed array-shaped maps")

    # Cloud restore must reject explicitly malformed warehouse history and stock maps.
    sync_validator_start = source.find("function anasValidateIncomingSyncData(incoming)")
    sync_validator_end = source.find("\n        async function syncPushNow()", sync_validator_start)
    sync_validator = source[sync_validator_start:sync_validator_end] if sync_validator_start >= 0 and sync_validator_end > sync_validator_start else ""
    sync_guards = [
        "const optionalArrays = ['purchases', 'expenses', 'users', 'trucks', 'returns', 'warehouseTransfers', 'stockMovements', 'purchaseInvoices', 'alerts', 'truckTrips', 'cashMovements', 'stocktakeRecords']",
        "Object.prototype.hasOwnProperty.call(incoming, key)",
        "if (typeof AppData !== 'undefined' && Array.isArray(AppData[key]) && AppData[key].length)",
        "النسخة السحابية تفتقد قائمة ",
        "continue;",
        "Object.prototype.hasOwnProperty.call(incoming, 'warehouses')",
        "Object.prototype.hasOwnProperty.call(p, 'warehouseStock')",
        "!warehouse.trim()",
        "String(p.stock).trim() !== '' && Number.isFinite(Number(p.stock)) && Number(p.stock) >= 0",
        "['warehouseTransfers', incoming.warehouseTransfers || [], false]",
        "['stockMovements', incoming.stockMovements || [], false]",
    ]
    if not sync_validator or any(guard not in sync_validator for guard in sync_guards):
        errors.append("cloud restore must reject explicitly null/malformed warehouse history, blank warehouse keys, and invalid stock balances")
    else:
        print("PASS: cloud restore rejects malformed warehouse history and stock balances")

    # Historical invoice edits must reject malformed source line values and inconsistent money totals.
    edit_start = source.find("function editSalesInvoice(invoiceId)")
    edit_end = source.find("\n        function ", edit_start + 1)
    edit_invoice = source[edit_start:edit_end] if edit_start >= 0 and edit_end > edit_start else ""
    edit_guards = [
        "Historical invoice quantities and prices are the baseline for stock reconciliation.",
        "Number(item.qty) <= 0",
        "Number(item.price) < 0",
        "Validate every touched product map, even for a main-warehouse invoice:",
        "Object.prototype.hasOwnProperty.call(p, 'warehouseStock')",
        "(!p.warehouseStock || typeof p.warehouseStock !== 'object' || Array.isArray(p.warehouseStock))",
        "validMoneyField = value =>",
        "oldPaid > oldTotal + 0.000001",
        "oldRemaining - Math.max(0, oldTotal - oldPaid)",
    ]
    if not edit_invoice or any(guard not in edit_invoice for guard in edit_guards):
        errors.append("historical invoice edits must reject invalid source quantities/prices and inconsistent totals before stock/account mutation")
    else:
        print("PASS: historical invoice edits reject corrupt source lines and inconsistent financial totals")

    # Backup and cloud restore must not silently replace populated local history with empty lists.
    backup_start = source.find("function anasValidateBackupData(incoming)")
    backup_end = source.find("\n        function importDataBackup(e)", backup_start)
    backup_validator = source[backup_start:backup_end] if backup_start >= 0 and backup_end > backup_start else ""
    restore_start = source.find("async function syncPullNow()")
    restore_end = source.find("\n        function exportDataBackup()", restore_start)
    cloud_restore = source[restore_start:restore_end] if restore_start >= 0 and restore_end > restore_start else ""
    backup_guards = [
        "Array.isArray(AppData[key]) && AppData[key].length",
        "النسخة تفتقد قائمة المخازن الموجودة حاليًا",
        "warehouseTransfers", "stockMovements", "purchaseInvoices", "truckTrips",
        "Object.prototype.hasOwnProperty.call(incoming, 'posScreensCarts')",
        "النسخة تفتقد سلال نقاط البيع التي تحتوي على أصناف",
        "for (const [key, currentCart] of Object.entries(AppData.posScreensCarts))",
        "النسخة تفتقد سلة نقطة البيع ",
        "idCollections", "seenIds", "معرّف مكرر في قائمة",
        "['stocktakeRecords', incoming.stocktakeRecords || [], true]",
        "['warehouseTransfers', incoming.warehouseTransfers || [], false]",
        "['stockMovements', incoming.stockMovements || [], false]",
    ]
    if not backup_validator or any(guard not in backup_validator for guard in backup_guards):
        errors.append("file restore must reject missing history collections when local records exist")
    else:
        print("PASS: file restore blocks incomplete backups that would erase populated local history")
    sync_guards = [
        "Array.isArray(AppData[key]) && AppData[key].length",
        "النسخة السحابية تفتقد قائمة المخازن المحلية",
        "purchaseInvoices", "truckTrips",
        "Object.prototype.hasOwnProperty.call(incoming, 'posScreensCarts')",
        "النسخة السحابية تفتقد سلال نقاط البيع التي تحتوي على أصناف",
        "for (const [key, currentCart] of Object.entries(AppData.posScreensCarts))",
        "النسخة السحابية تفتقد سلة نقطة البيع ",
    ]
    if not cloud_restore or "if (!exportDataBackup())" not in cloud_restore or not sync_validator or any(guard not in sync_validator for guard in sync_guards):
        errors.append("cloud restore must require a successful local backup and block loss of omitted history")
    else:
        print("PASS: cloud restore requires a local backup and preserves omitted local history")
    file_restore_start = source.find("function importDataBackup(e)")
    file_restore_end = source.find("// ================= مركز الإكسل", file_restore_start)
    file_restore = source[file_restore_start:file_restore_end] if file_restore_start >= 0 and file_restore_end > file_restore_start else ""
    repair_guards = [
        "const previousStartupIssues = anasStartupIntegrityIssues.slice()",
        "const previousFatalLoadError = anasStartupFatalLoadError",
        "anasStartupIntegrityIssues = []",
        "anasStartupFatalLoadError = false",
        "anasStartupIntegrityIssues = previousStartupIssues",
        "anasStartupFatalLoadError = previousFatalLoadError",
    ]
    if not file_restore or any(guard not in file_restore for guard in repair_guards):
        errors.append("file restore must clear startup fail-safe only for a validated save and restore guards on failure")
    if not cloud_restore or any(guard not in cloud_restore for guard in repair_guards):
        errors.append("cloud restore must clear startup fail-safe only for a validated save and restore guards on failure")
    if file_restore and cloud_restore and all(guard in file_restore for guard in repair_guards) and all(guard in cloud_restore for guard in repair_guards):
        print("PASS: validated restore can repair corrupt startup state and restores fail-safe guards if persistence fails")

    # The legacy Firebase pull button must use the same safe backup validator and transactional local save.
    firebase_pull_start = source.find("window.anasFirebasePull=async function()")
    firebase_pull_end = source.find("  };", firebase_pull_start)
    firebase_pull = source[firebase_pull_start:firebase_pull_end] if firebase_pull_start >= 0 and firebase_pull_end > firebase_pull_start else ""
    firebase_pull_guards = [
        "if(typeof exportDataBackup!=='function'||!exportDataBackup())",
        "if(typeof anasValidateBackupData!=='function')",
        "anasValidateBackupData(restored)",
        "const previousStartupIssues=anasStartupIntegrityIssues.slice()",
        "const previousFatalLoadError=anasStartupFatalLoadError",
        "anasStartupIntegrityIssues=[]",
        "anasStartupFatalLoadError=false",
        "if(!saved)",
        "anasStartupIntegrityIssues=previousStartupIssues",
        "anasStartupFatalLoadError=previousFatalLoadError",
    ]
    if not firebase_pull or any(guard not in firebase_pull for guard in firebase_pull_guards):
        errors.append("legacy Firebase pull must validate the cloud backup, create a local backup, and roll back failed persistence")
    else:
        print("PASS: legacy Firebase pull validates and transactionally saves cloud backups")

    # Sales invoice print templates must escape imported/store/customer/item values before HTML insertion.
    thermal_start = source.find("function printThermalReceipt(inv) {")
    thermal_end = source.find("function printLegalA4Invoice(inv", thermal_start)
    a4_start = thermal_end
    a4_end = source.find("function openInvoicePreview(title, html, printAction)", a4_start)
    thermal_source = source[thermal_start:thermal_end] if thermal_start >= 0 and thermal_end > thermal_start else ""
    a4_source = source[a4_start:a4_end] if a4_start >= 0 and a4_end > a4_start else ""
    print_escape_guards = [
        (thermal_source, "${anasEscapeHTML(sc.name)}"),
        (thermal_source, "${anasEscapeHTML(sc.footer)}"),
        (thermal_source, "${anasEscapeHTML(inv.customer)}"),
        (thermal_source, "${anasEscapeHTML(inv.total)}"),
        (thermal_source, "${anasEscapeHTML(it.unit || '')}"),
        (a4_source, "${anasEscapeHTML(sc.name)}"),
        (a4_source, "${anasEscapeHTML(inv.id)}"),
        (a4_source, "${anasEscapeHTML(cust.name || inv.customer)}"),
        (a4_source, "${anasEscapeHTML(cust.address || 'غير محدد')}"),
        (a4_source, "${anasEscapeHTML(it.name)}"),
        (a4_source, "${anasEscapeHTML(it.unit || 'قطعة')}"),
    ]
    if not thermal_source or not a4_source or any(guard not in part for part, guard in print_escape_guards):
        errors.append("thermal/A4 sales invoice templates must HTML-escape dynamic store, customer, invoice, and item fields")
    else:
        print("PASS: thermal and A4 sales invoice templates escape dynamic text fields")

    if "serviceWorker.register" not in source:
        errors.append("service worker registration is missing")
    elif not (ROOT / "sw.js").exists():
        errors.append("service worker is registered but sw.js is missing")
    else:
        print("PASS: service worker registration and sw.js exist")

    node = subprocess.run(["node", "--version"], capture_output=True, text=True)
    if node.returncode != 0:
        errors.append("Node.js is required to syntax-check inline JavaScript")
    else:
        checked = 0
        with tempfile.TemporaryDirectory(prefix="anas-erp-check-") as temp:
            for index, script in enumerate(parser.inline_scripts):
                script_path = Path(temp) / f"inline-{index}.js"
                script_path.write_text(script, encoding="utf-8")
                result = subprocess.run(
                    ["node", "--check", str(script_path)],
                    capture_output=True, text=True
                )
                if result.returncode != 0:
                    detail = (result.stderr or result.stdout).strip().splitlines()
                    errors.append(
                        f"inline script #{index + 1} has a syntax error: "
                        + (detail[0] if detail else "node --check failed")
                    )
                checked += 1
        if not any("inline script #" in item for item in errors):
            print(f"PASS: {checked} inline JavaScript blocks pass node --check")


    # Transaction-safety regression guards for money and inventory mutations.
    def function_source(name, end_marker=None):
        marker = "function " + name + "("
        start = source.find(marker)
        if start < 0:
            return ""
        candidates = [pos for pos in (source.find("\n        function ", start + len(marker)), source.find("\nfunction ", start + len(marker))) if pos >= 0]
        end = min(candidates) if candidates else len(source)
        if end_marker:
            marker_end = source.find(end_marker, start)
            if marker_end >= 0 and marker_end < end:
                end = marker_end
        return source[start:end]

    sale = function_source("confirmHasibPayment")
    purchase = function_source("savePurchaseItem")
    transfer = function_source("wtCreateTransfer")
    backup_import = function_source("importDataBackup", "// ================= مركز الإكسل")
    stock_edit = function_source("editPosQty")
    stock_balance = function_source("wtReadStockBalance")
    stock_transfer = function_source("wtCreateTransfer")
    stock_balance_checks = {
        "POS quantity edit rejects invalid or negative assigned-warehouse balances":
            "(!Number.isFinite(available) || available < 0)" in stock_edit
            and "q > available" in stock_edit,
        "warehouse balance reader rejects negative, non-finite, and malformed stock":
            "Number(raw)<0" in stock_balance
            and "Number.isFinite(Number(raw))" in stock_balance
            and "return NaN" in stock_balance,
        "warehouse transfer validates both source and destination balances before mutation":
            "Number.isFinite(available)" in stock_transfer
            and "available>Number.MAX_SAFE_INTEGER" in stock_transfer
            and "Number.isFinite(destinationBalance)" in stock_transfer
            and "destinationBalance=wtBalance(p,to)" in stock_transfer,
        "warehouse transfer rejects duplicate product IDs and destination overflow":
            "productMatches=(AppData.products||[]).filter(" in stock_transfer
            and "productMatches.length!==1" in stock_transfer
            and "Number.isFinite(destinationBalance+qty)" in stock_transfer
            and "destinationBalance+qty>Number.MAX_SAFE_INTEGER" in stock_transfer,
        "truck load rejects unsafe source and destination stock bounds before mutation":
            "Number(p.stock)>Number.MAX_SAFE_INTEGER" in function_source("postTripStock")
            and "Number.isFinite(truckBalance+qty)" in function_source("postTripStock")
            and "truckBalance+qty>Number.MAX_SAFE_INTEGER" in function_source("postTripStock"),
        "failed truck load rollback preserves stock property presence exactly":
            "hadStock:Object.prototype.hasOwnProperty.call(p,'stock')" in function_source("postTripStock")
            and "if(x.hadStock)x.p.stock=x.stock;else delete x.p.stock;" in function_source("postTripStock"),
        "failed truck load rollback preserves whether the warehouses collection existed":
            "const hadWarehouses=Object.prototype.hasOwnProperty.call(AppData,'warehouses');" in function_source("postTripStock")
            and "const oldWarehouses=hadWarehouses?JSON.parse(JSON.stringify(AppData.warehouses)):null;" in function_source("postTripStock")
            and "if(hadWarehouses)AppData.warehouses=oldWarehouses;else delete AppData.warehouses;" in function_source("postTripStock"),
    }
    for label, passed in stock_balance_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("stock-balance regression: " + label)

    # Truck load and settlement must never resolve ambiguous product IDs with Array.find().
    truck_load = function_source("postTripStock")
    settlement_start = source.find("window.anasTruckSettle = function(id){")
    settlement_end = source.find("\n  };", settlement_start)
    truck_settlement = source[settlement_start:settlement_end] if settlement_start >= 0 and settlement_end > settlement_start else ""
    truck_identity_checks = {
        "truck load rejects missing or duplicate product IDs before stock mutation":
            "matches=products.filter(" in truck_load
            and "matches.length!==1" in truck_load
            and "const p=matches[0]" in truck_load,
        "truck load rejects coerced quantities and aggregate overflow":
            "typeof item.qty==='number'" in truck_load
            and "typeof item.qty==='string'" in truck_load
            and "qty>Number.MAX_SAFE_INTEGER" in truck_load
            and "aggregateQty>Number.MAX_SAFE_INTEGER" in truck_load,
        "truck settlement rejects unsafe loaded quantities before prompting or mutation":
            "loaded>Number.MAX_SAFE_INTEGER" in truck_settlement
            and "typeof item.qty==='number'" in truck_settlement
            and "typeof item.qty==='string'" in truck_settlement
            and "String(item.qty).trim()===''" in truck_settlement,
        "truck settlement rejects missing or duplicate product IDs before prompting or mutation":
            "productMatches=products.filter(" in truck_settlement
            and "productMatches.length!==1" in truck_settlement
            and "const p=productMatches[0]" in truck_settlement,
        "truck settlement rejects missing or duplicate invoice IDs before mutating stock":
            "invoiceMatches=invoices.filter(" in truck_settlement
            and "invoiceMatches.length!==1" in truck_settlement
            and "const inv=invoiceMatches[0]" in truck_settlement,
        "truck settlement rejects coerced or unsafe invoice quantities":
            "typeof item.qty==='number'" in truck_settlement
            and "typeof item.qty==='string'" in truck_settlement
            and "String(item.qty).trim()===''" in truck_settlement
            and "qty>Number.MAX_SAFE_INTEGER" in truck_settlement,
    }
    for label, passed in truck_identity_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("truck product identity regression: " + label)

    cash_operation = function_source("submitCashOperation")
    expense_operation = function_source("submitExpenseOperation")
    pos_cart_change = function_source("savePosCartChange")
    pos_screen_switch = function_source("switchPosScreen")
    pos_clear_screens = function_source("clearAllPosScreens")
    pos_price_tier = function_source("setPosPriceTier")
    truck_create_start = source.find("window.anasTruckSaveTrip = function(){")
    truck_create_end = source.find("\n  window.anasTruckSetStatus", truck_create_start)
    truck_create = source[truck_create_start:truck_create_end] if truck_create_start >= 0 and truck_create_end > truck_create_start else ""
    truck_expense_start = source.find("window.anasTruckRecordExpense = function(id){")
    truck_expense_end = source.find("\n  window.anasTruckExportCSV", truck_expense_start)
    truck_expense = source[truck_expense_start:truck_expense_end] if truck_expense_start >= 0 and truck_expense_end > truck_expense_start else ""

    pos_cart_add = function_source("addItemToPosCart")
    pos_cart_remove = function_source("removePosCartItem")
    pos_cart_clear = function_source("clearPosCart")
    product_delete = function_source("deleteProduct")
    category_create = function_source("addNewProductCategory")
    bulk_price_update = function_source("bulkEditPricesPrompt")
    custom_unit_create = function_source("addNewCustomUnit")
    product_save = function_source("saveNewProductFromModal")
    user_switch = function_source("switchActiveUser")
    user_delete = function_source("deleteUserRecord")
    user_save = function_source("saveUserRecord")
    stocktake_start = source.find("window.anasSaveStocktakeDraft=function(){")
    stocktake_end = source.find("  window.anasExportStocktake=", stocktake_start)
    stocktake_draft = source[stocktake_start:stocktake_end] if stocktake_start >= 0 and stocktake_end > stocktake_start else ""
    stocktake_approve_start = source.find("window.anasApproveStocktake=function(){")
    stocktake_approve_end = source.find("})();", stocktake_approve_start)
    stocktake_approve = source[stocktake_approve_start:stocktake_approve_end] if stocktake_approve_start >= 0 and stocktake_approve_end > stocktake_approve_start else ""
    legacy_destructive_guards = {
        "old_clearAllSalesInvoices": "clearAllSalesInvoices();",
        "old_clearAllPurchaseInvoices": "clearAllPurchaseInvoices();",
        "old_autoResetAllInvoicesNow": "autoResetAllInvoicesNow();",
        "old_cancelInvoicePrompt": "cancelInvoicePrompt();",
        "old_returnSalePrompt": "returnSalePrompt();",
        "old_returnPurchasePrompt": "returnPurchasePrompt();",
    }
    for legacy_name, guard_call in legacy_destructive_guards.items():
        legacy_fn = function_source(legacy_name)
        if guard_call not in legacy_fn or "saveDB(" in legacy_fn or "AppData." in legacy_fn:
            errors.append("legacy destructive action is not routed to its safe guard: " + legacy_name)
    if all(guard_call in function_source(name) and "saveDB(" not in function_source(name) for name, guard_call in legacy_destructive_guards.items()):
        print("PASS: legacy destructive invoice actions delegate to safe guards")

    if "duplicateProductIds" not in stocktake_approve or "other.productId" not in stocktake_approve:
        errors.append("stocktake approval must reject duplicate product IDs and duplicate rows")
    else:
        print("PASS: stocktake approval rejects ambiguous product identities")

    if "!validStocktakeQuantity(item.physicalQty)" not in stocktake_approve or "!validStocktakeQuantity(item.systemQty)" not in stocktake_approve or "!validStocktakeQuantity(p.stock)" not in stocktake_approve:
        errors.append("stocktake approval must reject malformed or unsafe counted, baseline, and current stock quantities before mutation")
    else:
        print("PASS: stocktake approval strictly validates numeric bounds before mutation")

    if "if(current!==system)" not in stocktake_approve or "تغير رصيد المنتج" not in stocktake_approve:
        errors.append("stocktake approval must reject stale stock snapshots before mutating inventory")
    else:
        print("PASS: stocktake approval rejects stock changed since count began")

    if ("Object.prototype.hasOwnProperty.call(AppData,'stockMovements')" not in stocktake_approve
        or "AppData.stockMovements.some(m=>!m||typeof m!=='object'||Array.isArray(m))" not in stocktake_approve
        or "Object.prototype.hasOwnProperty.call(AppData,'stocktakeRecords')" not in stocktake_approve
        or "AppData.stocktakeRecords.some(r=>!r||typeof r!=='object'||Array.isArray(r))" not in stocktake_approve):
        errors.append("stocktake approval must reject malformed existing stock movement and audit records without replacing history")
    else:
        print("PASS: stocktake approval preserves malformed-ledger evidence and fails closed")

    transaction_checks = {
        "clearing POS cart restores both active cart and persisted cart map on save failure":
            "const previousCarts = AppData.posScreensCarts" in function_source("clearPosCart")
            and "previousCarts[activeTab] = previousTabCart" in function_source("clearPosCart")
            and "AppData.posScreensCarts = previousCarts" in function_source("clearPosCart"),
        "POS add/remove/clear cart reject missing or implicit persistence success":
            ("typeof saveDB !== 'function' || saveDB() !== true" in pos_cart_add
             or "cartSaved = typeof saveDB === 'function' && saveDB() === true" in pos_cart_add)
            and "typeof saveDB !== 'function' || saveDB() !== true" in pos_cart_remove
            and "typeof saveDB !== 'function' || saveDB() !== true" in pos_cart_clear,
        "failed user edit restores the prior record and active-user reference":
            "previousUser = Object.assign({}, u)" in function_source("saveUserRecord")
            and "Object.keys(u).forEach(key => { if (!previousUserKeys.includes(key)) delete u[key]; });" in function_source("saveUserRecord")
            and "AppData.currentUser = previousCurrentUser" in function_source("saveUserRecord"),
        "catalog and user mutations require explicit save success with rollback":
            "saved !== true" in product_delete and "saveDB()!==true" in category_create
            and "saveDB()!==true" in bulk_price_update and "saveDB()!==true" in custom_unit_create
            and "saveDB()!==true" in product_save and "saveDB()!==true" in user_switch
            and "saveDB()!==true" in user_delete and "saveDB()!==true" in user_save,
        "stocktake draft and approval require explicit save success":
            "saveDB()!==true" in stocktake_draft
            and "const saved=typeof saveDB==='function'?saveDB():false;" in stocktake_approve
            and "if(saved!==true)throw" in stocktake_approve,
        "cash movements and expenses require explicit saveDB true before success":
            "cashSaved = saveDB() === true" in cash_operation
            and "expenseSaved = saveDB() === true" in expense_operation,
        "cash and expense rollback preserve raw cash-balance value and property presence":
            "const previousCashBalance = AppData.caisseBalance;" in cash_operation
            and "if (hadCashBalance) AppData.caisseBalance = previousCashBalance; else delete AppData.caisseBalance;" in cash_operation
            and "const previousCashBalance = AppData.caisseBalance;" in expense_operation
            and "if (hadCashBalance) AppData.caisseBalance = previousCashBalance; else delete AppData.caisseBalance;" in expense_operation,
        "POS cart and screen operations reject false, undefined, and missing persistence":
            "typeof saveDB !== 'function' || saveDB() !== true" in pos_cart_change
            and "saved = saveDB() === true" in pos_screen_switch
            and "saved = saveDB() === true" in pos_clear_screens
            and "saved = saveDB() === true" in pos_price_tier,
        "truck deletion fails closed when persistence is missing or implicit":
            "typeof saveDB!=='function'||saveDB()!==true" in source[source.find("window.anasTruckDelete = function(id){"):source.find("window.anasTruckRender = function(){")],
        "truck trip cost and weight reject unsafe numeric magnitudes":
            "weight>Number.MAX_SAFE_INTEGER" in truck_create
            and "cost>Number.MAX_SAFE_INTEGER" in truck_create
            and "amount>Number.MAX_SAFE_INTEGER" in truck_expense,
        "truck deletion rejects ambiguous trip IDs":
            "tripMatches.length!==1" in source[source.find("window.anasTruckDelete = function(id){"):source.find("window.anasTruckRender = function(){")],
        "truck trip creation and expense linking require explicit persistence success":
            "typeof saveDB!=='function' || saveDB()!==true" in truck_create
            and "typeof saveDB!=='function'||saveDB()!==true" in truck_expense,
        "truck status, settlement, and expense reject ambiguous trip IDs":
            "tripMatches.length!==1" in source[source.find("window.anasTruckSetStatus = function(id,status){"):source.find("  // V54 draft: guarded truck custody settlement.")]
            and "tripMatches.length!==1" in truck_settlement
            and "tripMatches.length!==1" in truck_expense,
        "truck expense rejects malformed and blank persisted cost values":
            "const rawAmount=trip.cost;" in truck_expense
            and "(typeof rawAmount==='number')||(typeof rawAmount==='string')" in truck_expense
            and "String(rawAmount).trim()===''" in truck_expense,
        "truck expense refuses malformed or ambiguous existing expense records":
            "Object.prototype.hasOwnProperty.call(AppData,'expenses')&&(!Array.isArray(AppData.expenses)||AppData.expenses.some(e=>!e||typeof e!=='object'||Array.isArray(e)))" in truck_expense
            and "existingExpenses=AppData.expenses.filter(" in truck_expense
            and "existingExpenses.length>1" in truck_expense
            and "دون استبدال السجل" in truck_expense,
        "sale aggregates repeated product quantities and validates numeric inputs":
            "aggregateQty = (required.get(id) || 0) + qty" in sale
            and "Number.isFinite(qty)" in sale and "Number.isFinite(price)" in sale,
        "POS sale rejects unsafe invoice, quantity, cash, and customer-debt arithmetic":
            "total > Number.MAX_SAFE_INTEGER" in sale
            and "aggregateQty > Number.MAX_SAFE_INTEGER" in sale
            and "oldDebt + remaining > Number.MAX_SAFE_INTEGER" in sale
            and "currentCash + paid > Number.MAX_SAFE_INTEGER" in sale,
        "POS sale rejects missing or duplicate product IDs and reuses unique preflight records":
            "productMatches = (AppData.products || []).filter(" in sale
            and "productMatches.length !== 1" in sale
            and "saleProducts.set(id, product)" in sale
            and "saleProducts.get(id)" in sale,
        "POS sale rejects duplicate or stale selected customer IDs":
            "customerMatches = cId ? customers.filter(" in sale
            and "customerMatches.length !== 1" in sale
            and "const selectedCustomer = cId ? customerMatches[0] : null" in sale,
        "sale restores exact stock, debt, debt-date, cash, invoice, and cart state after persistence failure":
            "if (!saveDB()) throw" in sale
            and "hadStock:Object.prototype.hasOwnProperty.call(p,'stock')" in sale
            and "if(stockState.hadStock)p.stock=stockState.stock;" in sale
            and "else delete p.stock;" in sale
            and "if(stockState.hadWarehouseStock)p.warehouseStock=stockState.warehouseStock;" in sale
            and "if (hasDebtField) cust.debt = rawDebt; else delete cust.debt;" in sale
            and "hadDebtDate = Object.prototype.hasOwnProperty.call(cust, 'debtDate')" in sale
            and "if (hadDebtDate) cust.debtDate = oldDebtDate; else delete cust.debtDate;" in sale
            and "const rawCaisseBalance = AppData.caisseBalance;" in sale
            and "if (hadCaisseBalance) AppData.caisseBalance = rawCaisseBalance; else delete AppData.caisseBalance;" in sale
            and "AppData.invoices = invoicesBefore" in sale and "posCart = oldCart" in sale
            and "AppData.posScreensCarts" not in sale,
        "purchase validates safe integer quantity and restores AppData on failed persistence":
            "Number.isSafeInteger(qty)" in purchase and "saveDB() !== true" in purchase
            and "AppData = previous" in purchase,
        "purchase rejects stale supplier IDs before recording a cash purchase":
            "if (suppId && supplierMatches.length === 0)" in purchase
            and "supplierMatches.length > 1" in purchase
            and "const supplier = supplierMatches[0] || null;" in purchase,
        "purchase rejects duplicate product names and invalid or overflowing stock before mutation":
            "productMatches.length > 1" in purchase
            and "existingProduct && !((typeof existingStock === 'number' || typeof existingStock === 'string')" in purchase
            and "Number(existingStock) + qty > Number.MAX_SAFE_INTEGER" in purchase
            and "let product = existingProduct" in purchase,
        "purchase preserves malformed product and purchase collections instead of replacing them":
            "Object.prototype.hasOwnProperty.call(AppData, 'products')" in purchase
            and "Object.prototype.hasOwnProperty.call(AppData, 'purchases')" in purchase
            and "سجل المشتريات تالف" in purchase,
        "warehouse transfer rejects insufficient stock and restores inventory/transfer records on failure":
            "qty>available" in transfer and "if(!saveDB())throw" in transfer
            and "p.stock=beforeMain" in transfer and "AppData.warehouseTransfers=transfersBefore" in transfer,
        "warehouse transfer rejects finite purchase/sale totals above the safe integer limit":
            "buyPrice*qty>Number.MAX_SAFE_INTEGER" in transfer
            and "salePrice*qty>Number.MAX_SAFE_INTEGER" in transfer,
        "backup restore validates per-warehouse stock maps":
            "rawBalance" in source and "Number(rawBalance) > Number.MAX_SAFE_INTEGER" in source,
        "backup restore rejects invoice paid/remaining balances inconsistent with total":
            "Number(invoice.paid) > Number(invoice.total) + 0.000001" in backup_fn
            and "Math.abs(Number(invoice.remaining) - Math.max(0, Number(invoice.total) - Number(invoice.paid))) > 0.01" in backup_fn,

        "backup restore rejects unsafe stock and financial magnitudes":
            "Number(p.stock) > Number.MAX_SAFE_INTEGER" in source
            and "Number(raw) > Number.MAX_SAFE_INTEGER" in source,
        "backup import validates before replacing state and restores prior data on save failure":
            "anasValidateBackupData(JSON.parse(evt.target.result))" in backup_import
            and "const previous = AppData" in backup_import and "try { restoreSaved = saveDB() === true; }" in backup_import
            and "catch (saveErr) { restoreSaveError = saveErr; }" in backup_import
            and "AppData = previous; posCart = previousCart" in backup_import,
        "cloud restore aborts if local data changes while the network request is pending":
            "localStateAtRequestStart = JSON.stringify(AppData)" in cloud_restore
            and "currentLocalState !== localStateAtRequestStart" in cloud_restore
            and "أُلغي الاسترجاع لأن البيانات المحلية تغيرت أثناء جلب النسخة" in cloud_restore,
    }
    for label, passed in transaction_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("transaction-safety regression: " + label)


    # Execute AI morning-brief and natural-language draft functions with synthetic data in an isolated Node VM.
    # These tests validate behavior and AppData immutability; they never call the network or persistence layer.
    ai_draft_fn = function_source("anasPrepareNaturalLanguageDraft")
    ai_brief_fn = function_source("anasRefreshAiMorningBrief")
    if not ai_draft_fn or not ai_brief_fn:
        errors.append("AI behavioral runtime tests could not locate the draft or morning-brief function")
    else:
        ai_behavior_harness = r"""
const vm = require('node:vm');
process.on('uncaughtException', err => { console.error('AI_RUNTIME_FAILURE:', err.message); process.exit(1); });
function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(), children: [], dataset: {}, style: {}, attributes: {},
    value: '', type: '', min: '', step: '', disabled: false, _text: '',
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this._text = ''; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    focus() {}, scrollIntoView() {},
    querySelector(selector) {
      const requested = selector.match(/^\[data-draft-field="([^"]+)"\]$/);
      const match = (n) => {
        if (requested && n.dataset && n.dataset.draftField === requested[1]) return n;
        return (n.children || []).map(match).find(Boolean) || null;
      };
      return match(this);
    },
    get textContent() { return this._text + this.children.map(c => c.textContent || '').join(''); },
    set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  };
  return node;
}
const elements = {
  anasAiQuestion: makeNode('textarea'),
  anasAiNaturalDraft: makeNode('div'),
  anasAiMorningBrief: makeNode('div')
};
const fixedNow = new Date('2026-10-27T12:00:00');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow.getTime()])); }
  static now() { return fixedNow.getTime(); }
}
const context = {
  AppData: {
    invoices: [
      { id: 'SYN-1', date: 'not-a-date', createdAt: '2026-10-26', total: 10 },
      { id: 'SYN-2', date: '2026-10-26', createdAt: '2026-10-26', total: 20 },
      { id: 'SYN-3', date: 'invalid', createdAt: '', total: 99 }
    ],
    products: [], customers: [], syntheticMarker: 'UNCHANGED'
  },
  document: {
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return makeNode(tag); }
  },
  Date: FixedDate,
  console,
  Number, String, Math, Array, Object, JSON, RegExp
};
vm.createContext(context);
vm.runInContext(__DRAFT_FN__ + '\n' + __BRIEF_FN__, context);
const before = JSON.stringify(context.AppData);
context.anasRefreshAiMorningBrief();
const brief = elements.anasAiMorningBrief.textContent;
if (!brief.includes('مجموع الفواتير المؤرخة أمس فقط = 30') || !brief.includes('من 2 فاتورة مؤرخة')) {
  throw new Error('date fallback/deduplication failed: expected exactly two dated invoices totaling 30');
}
if (!brief.includes('1 فاتورة بلا تاريخ قابل للتحقق')) {
  throw new Error('undated invoice was not classified exactly once');
}
const cases = [
  { command: 'بيع ٢٫٥ كرتونة شاي', expectedQty: '2.5', expectedItem: 'شاي' },
  { command: 'بيع 3 باكي شاي للعميل أحمد بسعر 250', expectedQty: '3', expectedItem: 'شاي', expectedCustomer: 'أحمد', expectedPrice: '250' },
  { command: 'بيع ١٬٢٥٠ كرتونة شاي', expectedQty: '', expectedItem: 'شاي' }
];
for (const test of cases) {
  elements.anasAiQuestion.value = test.command;
  context.anasPrepareNaturalLanguageDraft();
  const root = elements.anasAiNaturalDraft;
  const field = (key) => root.querySelector('[data-draft-field="' + key + '"]');
  if (!field('quantity') || field('quantity').value !== test.expectedQty) {
    throw new Error('quantity extraction failed for synthetic command: ' + test.command);
  }
  if (!field('item') || field('item').value !== test.expectedItem) {
    throw new Error('item extraction failed for synthetic command: ' + test.command + '; got=' + (field('item') && field('item').value));
  }
  if (test.expectedCustomer && (!field('customer') || field('customer').value !== test.expectedCustomer)) {
    throw new Error('customer extraction failed for synthetic command: ' + test.command + '; got=' + (field('customer') && field('customer').value));
  }
  if (test.expectedPrice && (!field('unitPrice') || field('unitPrice').value !== test.expectedPrice)) {
    throw new Error('unit price extraction failed for synthetic command: ' + test.command + '; got=' + (field('unitPrice') && field('unitPrice').value));
  }
  if (!root.textContent.includes('مسودة قابلة للتعديل أو الرفض فقط')) {
    throw new Error('draft is not clearly marked review-only');
  }
}
if (JSON.stringify(context.AppData) !== before) {
  throw new Error('AI draft or morning brief mutated AppData');
}
console.log('PASS: AI behavioral tests validate date fallback/deduplication, Arabic decimal and colloquial-unit extraction, and AppData immutability');
""";
        ai_behavior_harness = ai_behavior_harness.replace("__DRAFT_FN__", json.dumps(ai_draft_fn))
        ai_behavior_harness = ai_behavior_harness.replace("__BRIEF_FN__", json.dumps(ai_brief_fn))
        with tempfile.TemporaryDirectory(prefix="anas-ai-behavior-") as temp:
            test_path = Path(temp) / "ai-behavior.js"
            test_path.write_text(ai_behavior_harness, encoding="utf-8")
            result = subprocess.run(["node", str(test_path)], capture_output=True, text=True)
            if result.returncode:
                detail = (result.stderr or result.stdout).strip().splitlines()
                diagnostic = next((line.strip() for line in detail if "AI_RUNTIME_FAILURE:" in line), detail[0] if detail else "node test failed")
                errors.append("AI behavioral runtime test failed: " + diagnostic)
            else:
                print(result.stdout.strip())


    # Intercept the real AI request function with a fake fetch and synthetic records.
    # Assert consent gates the actual serialized payload and no sensitive value is logged.
    ai_ask_start = source.find("async function askAnasBusinessAI(){")
    ai_ask_end = source.find("\n        // Load the spreadsheet parser", ai_ask_start)
    ai_ask_fn = source[ai_ask_start:ai_ask_end] if ai_ask_start >= 0 and ai_ask_end > ai_ask_start else ""
    ai_snapshot_fn = function_source("anasBuildBusinessSnapshot")
    ai_append_fn = function_source("anasAiAppendMessage")
    ai_fallback_fn = function_source("anasAiLocalFallback")
    if not ai_ask_fn or not ai_snapshot_fn or not ai_append_fn or not ai_fallback_fn:
        errors.append("AI payload runtime test could not locate functions: ask=" + str(bool(ai_ask_fn)) + ", snapshot=" + str(bool(ai_snapshot_fn)) + ", append=" + str(bool(ai_append_fn)) + ", fallback=" + str(bool(ai_fallback_fn)))
    else:
        ai_payload_harness = r"""
const vm = require('node:vm');
function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(), children: [], dataset: {}, style: {}, attributes: {},
    value: '', checked: false, disabled: false, textContent: '', scrollTop: 0,
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    focus() {}, scrollIntoView() {}
  };
  return node;
}
const elements = {
  anasAiQuestion: makeNode('textarea'),
  anasAiAskBtn: makeNode('button'),
  anasAiShareContext: makeNode('input'),
  anasAiAnswerStyle: makeNode('select'),
  anasAiOfflineFallback: makeNode('div'),
  anasAiChatLog: makeNode('div')
};
elements.anasAiAnswerStyle.value = 'concise';
const calls = [], consoleCalls = [];
const context = {
  AppData: {
    products: [{name:'SYNTHETIC_PRIVATE_PRODUCT',stock:7,buyPrice:2}],
    customers: [{name:'SYNTHETIC_PRIVATE_CUSTOMER',debt:1234}],
    suppliers: [], invoices: [], purchases: [], truckTrips: [],
    stockMovements: [], warehouseTransfers: [], warehouses: [], expenses: [],
    caisseBalance: 55
  },
  document: {
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return makeNode(tag); },
    createTextNode(value) { const n=makeNode('#text'); n.textContent=String(value); return n; }
  },
  localStorage: { getItem(key) { return key === 'anasErpAiGatewayUrlV1' ? 'https://synthetic.invalid/ai' : null; } },
  navigator: { onLine: true },
  console: { log(...args){consoleCalls.push(args)}, warn(...args){consoleCalls.push(args)}, error(...args){consoleCalls.push(args)} },
  alert() {},
  setTimeout() { return 1; }, clearTimeout() {},
  AbortController: class { constructor(){this.signal={};} abort(){} },
  fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {ok:true,status:200,headers:{get(){return 'application/json'}},text:async()=>JSON.stringify({text:'synthetic response'})};
  },
  anasNormalizeAiGatewayUrl(value) { return value; },
  Number, String, Math, Array, Object, JSON, RegExp, Map
};
vm.createContext(context);
vm.runInContext(__SNAPSHOT_FN__ + '\n' + __APPEND_FN__ + '\n' + __FALLBACK_FN__ + '\nconst anasAiAnswerCache=new Map();\n' + __ASK_FN__, context);
(async () => {
  elements.anasAiQuestion.value = 'سؤال اصطناعي دون مشاركة';
  elements.anasAiShareContext.checked = false;
  await context.askAnasBusinessAI();
  elements.anasAiQuestion.value = 'سؤال اصطناعي مع مشاركة';
  elements.anasAiShareContext.checked = true;
  await context.askAnasBusinessAI();
  if (calls.length !== 2) throw new Error('expected two intercepted AI requests');
  if (Object.prototype.hasOwnProperty.call(calls[0], 'businessData')) {
    throw new Error('unchecked consent still included businessData');
  }
  if (!calls[1].businessData || !calls[1].businessData.counts || !calls[1].businessData.totals) {
    throw new Error('checked consent did not include the aggregate business snapshot');
  }
  const serialized = JSON.stringify(calls[1].businessData);
  if (serialized.includes('SYNTHETIC_PRIVATE_CUSTOMER') || serialized.includes('SYNTHETIC_PRIVATE_PRODUCT')) {
    throw new Error('aggregate payload leaked synthetic customer or product identity');
  }
  if (Object.prototype.hasOwnProperty.call(calls[1].businessData, 'sampleProducts') ||
      Object.prototype.hasOwnProperty.call(calls[1].businessData, 'topDebtors')) {
    throw new Error('aggregate payload included per-record collections');
  }
  if (consoleCalls.length) throw new Error('AI request path emitted console output during the synthetic privacy test');
  console.log('PASS: intercepted AI requests omit businessData without consent and send only identity-free aggregates with consent; no console output');
})().catch(err => { console.error('AI_PAYLOAD_FAILURE:', err.message); process.exitCode = 1; });
""";
        ai_payload_harness = ai_payload_harness.replace("__SNAPSHOT_FN__", json.dumps(ai_snapshot_fn))
        ai_payload_harness = ai_payload_harness.replace("__APPEND_FN__", json.dumps(ai_append_fn))
        ai_payload_harness = ai_payload_harness.replace("__FALLBACK_FN__", json.dumps(ai_fallback_fn))
        ai_payload_harness = ai_payload_harness.replace("__ASK_FN__", json.dumps(ai_ask_fn))
        with tempfile.TemporaryDirectory(prefix="anas-ai-payload-") as temp:
            test_path = Path(temp) / "ai-payload.js"
            test_path.write_text(ai_payload_harness, encoding="utf-8")
            result = subprocess.run(["node", str(test_path)], capture_output=True, text=True)
            if result.returncode:
                detail = (result.stderr or result.stdout).strip().splitlines()
                diagnostic = next((line.strip() for line in detail if "AI_PAYLOAD_FAILURE:" in line), detail[0] if detail else "node test failed")
                errors.append("AI payload runtime test failed: " + diagnostic)
            else:
                print(result.stdout.strip())

    ai_privacy_checks = {
        "AI business context is opt-in and unchecked by default":
            'id="anasAiShareContext" type="checkbox"' in source
            and 'const shareContext=!!document.getElementById(\'anasAiShareContext\')?.checked;' in source
            and 'if(shareContext)payload.businessData=businessData;' in source
            and 'businessData:anasBuildBusinessSnapshot()' not in source,
        "AI answer style controls are present":
            'id="anasAiAnswerStyle"' in source
            and "نمط الإجابة المطلوب:" in source,
        "AI answer cache is in-memory only and bounded":
            "const anasAiAnswerCache=new Map();" in source
            and "while(anasAiAnswerCache.size>20)" in source
            and "sessionStorage" not in source[source.find("const anasAiAnswerCache=new Map();"):source.find("// Load the spreadsheet parser")],
        "AI offline fallback offers local workflows":
            "function anasAiLocalFallback(question)" in source
            and "if(!navigator.onLine)" in source
            and "الفحص المحلي" in source,
        "AI request explicitly avoids HTTP cache":
            "cache:'no-store'" in source,
    }
    for label, passed in ai_privacy_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("AI privacy/UX regression: " + label)

    # AI semantic guards cover malformed numbers, previous-day scoping, and review-only drafts.
    ai_ux_checks = {
        "AI hub collapses quick-action and answer grids below 360px":
            "@media (max-width: 359px)" in source
            and "#aiHubTabContent .anas-ai-grid { grid-template-columns: minmax(0, 1fr); }" in source
            and "anas-ai-quick-actions" in source,
        "AI hub provides 44px touch targets and keyboard-focus scrolling":
            "min-height: 44px" in source
            and "field.scrollIntoView({ block: 'center', behavior: 'auto' })" in source
            and "scroll-margin-block: 18px" in source,
        "AI hub contains chat scrolling and respects reduced motion":
            "overscroll-behavior: contain" in source
            and "-webkit-overflow-scrolling: touch" in source
            and "prefers-reduced-motion: reduce" in source,
        "AI context-sharing disclosure matches aggregate-only payload":
            "دون أسماء العملاء أو المنتجات أو أرصدة الأفراد" in source
            and "عينات محدودة من أسماء المنتجات والعملاء" not in source,
        "AI center provides ready-to-use quick actions":
            "تحليل مبيعات اليوم" in source
            and "تلخيص الديون" in source
            and "تنبيهات المخزون" in source
            and "تدقيق البيانات" in source
            and "anasSetAiPrompt(" in source,
        "proactive business insights are computed locally":
            "function anasRefreshAiProactiveInsights()" in source
            and 'id="anasAiProactiveInsights"' in source
            and "noStock.length" in source
            and "debtors.length" in source
            and "invalidStock.length" in source,
        "proactive insights use text nodes rather than injected HTML":
            "target.replaceChildren(list)" in source
            and "li.textContent=note" in source,
        "proactive insight rendering runs after the AI hub template is inserted":
            source.find("anasRefreshAiProactiveInsights();", source.find("function renderAiHub()"))
            < source.find("function triggerAiGeneration(section)"),
        "AI numeric parsing rejects empty and non-numeric values":
            "const strictNum=v=>" in source
            and "const raw=String(v).trim();" in source
            and "if(!/^-?" in source
            and "Number.isFinite(n)?n:null" in source,
        "AI numeric parsing rejects ambiguous thousands separators":
            "raw.replace(',','.')" in source
            and ",\\d{1,2}" in source,
        "missing stock is not silently classified as zero":
            "const missingStock=products.filter" in source
            and "لم تُعامل القيم الفارغة كصفر" in source,
        "morning brief filters invoices to the previous local calendar day":
            "مبيعات أمس (" in source
            and "yesterday.getFullYear()" in source
            and "const dated=[],undated=[];" in source
            and "'invoice_date'" in source,
        "morning brief flags undated invoices and invalid totals":
            "فاتورة بلا تاريخ قابل للتحقق" in source
            and "تعذر قراءة إجمالي" in source,
        "natural-language draft exposes editable review fields without saving":
            "field.dataset.draftField=key" in source
            and "مسودة قابلة للتعديل أو الرفض فقط" in source
            and "لم تُحفظ فاتورة ولم يتغير المخزون أو الحساب" in source,
        "natural-language draft supports Arabic-Indic digits":
            "replace(/[٠-٩]/g" in source
            and "replace(/[۰-۹]/g" in source,
        "morning brief falls back across invalid date fields without truthiness selection":
            "const dateCandidates=row?" in source
            and "const parsed=parseInvoiceDate(candidate);" in source
            and "if(parsed){date=parsed;break;}" in source,
        "natural-language draft flags invalid quantity and unit price without saving":
            "invalidNumeric.push('الكمية يجب أن تكون رقمًا أكبر من صفر')" in source
            and "invalidNumeric.push('سعر الوحدة يجب أن يكون رقمًا غير سالب')" in source
            and "لا يوجد اعتماد أو حفظ تلقائي" in source,
        "natural-language draft recognizes additional Arabic and colloquial units":
            "كرتونة|كرتون|باكي|باكية|باكيات|سربيس" in source,
        "AI business context is minimized to aggregates without per-record identities":
            "Minimize outbound business context: aggregates only" in source
            and "sampleProducts:recentProducts" not in source
            and "topDebtors:debtors" not in source
            and "if(shareContext)payload.businessData=businessData;" in source,
    }
    for label, passed in ai_ux_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("AI UX regression: " + label)

    if errors:
        for error in errors:
            print("FAIL:", error)
        return 1
    print("ANAS ERP static regression checks passed.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
