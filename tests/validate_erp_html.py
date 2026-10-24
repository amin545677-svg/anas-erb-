#!/usr/bin/env python3
"""Static regression checks for the ANAS ERP single-file web application."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import re
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
    load_snapshot = "warehouseStock:Array.isArray(p.warehouseStock)?p.warehouseStock.slice()"
    load_restore = "oldStocks.forEach(x=>{x.p.stock=x.stock;if(x.hadWarehouseStock)x.p.warehouseStock=x.warehouseStock;else delete x.p.warehouseStock;});"
    if load_guard not in source or settlement_snapshot not in source or settlement_restore not in source or load_snapshot not in source or load_restore not in source:
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
        "const optionalArrays = ['purchases', 'expenses', 'users', 'trucks', 'returns', 'warehouseTransfers', 'stockMovements']",
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

    if errors:
        for error in errors:
            print("FAIL:", error)
        return 1
    print("ANAS ERP static regression checks passed.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
