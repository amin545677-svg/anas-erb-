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
    if not sale_fn or "wtTryEnsureData" not in sale_fn or "hasDebtField" not in sale_fn:
        errors.append("integrated POS payment must retain warehouse preflight and malformed customer-debt rejection")
    if not transfer_fn or "if(!wtTryEnsureData())return;" not in transfer_fn:
        errors.append("integrated warehouse transfer must validate persisted stock data before mutation")
    if not transfer_fn or "WAREHOUSE_TRANSFER_OUT" not in transfer_fn or "WAREHOUSE_TRANSFER_IN" not in transfer_fn or "const movementsBefore=AppData.stockMovements.slice();" not in transfer_fn or "AppData.stockMovements=movementsBefore;" not in transfer_fn:
        errors.append("warehouse transfers must write balanced source/destination stock-ledger entries and roll them back on save failure")
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
        "رصيد دين العميل غير صالح. أصلح سجل العميل قبل أي تعديل مالي",
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
        "const optionalArrays = ['purchases', 'expenses', 'users', 'trucks', 'returns', 'warehouseTransfers', 'stockMovements', 'purchaseInvoices', 'alerts', 'truckTrips', 'cashMovements']",
        "Object.prototype.hasOwnProperty.call(incoming, key)",
        "Object.prototype.hasOwnProperty.call(incoming, 'warehouses')",
        "Object.prototype.hasOwnProperty.call(p, 'warehouseStock')",
        "!warehouse.trim()",
        "String(p.stock).trim() !== '' && Number.isFinite(Number(p.stock)) && Number(p.stock) >= 0",
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
        "truck settlement rejects unsafe loaded quantities before prompting or mutation":
            "loaded>Number.MAX_SAFE_INTEGER" in truck_settlement,
        "truck settlement rejects missing or duplicate product IDs before prompting or mutation":
            "productMatches=products.filter(" in truck_settlement
            and "productMatches.length!==1" in truck_settlement
            and "const p=productMatches[0]" in truck_settlement,
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

    transaction_checks = {
        "clearing POS cart restores both active cart and persisted cart map on save failure":
            "const previousCarts = AppData.posScreensCarts" in function_source("clearPosCart")
            and "previousCarts[activeTab] = previousTabCart" in function_source("clearPosCart")
            and "AppData.posScreensCarts = previousCarts" in function_source("clearPosCart"),
        "POS add/remove/clear cart reject missing or implicit persistence success":
            "typeof saveDB !== 'function' || saveDB() !== true" in pos_cart_add
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
        "truck trip creation and expense linking require explicit persistence success":
            "typeof saveDB!=='function' || saveDB()!==true" in truck_create
            and "typeof saveDB!=='function'||saveDB()!==true" in truck_expense,
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
        "backup restore validates per-warehouse stock maps":
            "rawBalance" in source and "Number(rawBalance) > Number.MAX_SAFE_INTEGER" in source,

        "backup restore rejects unsafe stock and financial magnitudes":
            "Number(p.stock) > Number.MAX_SAFE_INTEGER" in source
            and "Number(raw) > Number.MAX_SAFE_INTEGER" in source,
        "backup import validates before replacing state and restores prior data on save failure":
            "anasValidateBackupData(JSON.parse(evt.target.result))" in backup_import
            and "const previous = AppData" in backup_import and "try { restoreSaved = saveDB() === true; }" in backup_import
            and "catch (saveErr) { restoreSaveError = saveErr; }" in backup_import
            and "AppData = previous; posCart = previousCart" in backup_import,
    }
    for label, passed in transaction_checks.items():
        if passed:
            print("PASS:", label)
        else:
            errors.append("transaction-safety regression: " + label)

    if errors:
        for error in errors:
            print("FAIL:", error)
        return 1
    print("ANAS ERP static regression checks passed.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
