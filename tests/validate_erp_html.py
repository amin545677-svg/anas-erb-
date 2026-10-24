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
console.log('PASS: startup runtime smoke tests preserve corrupt data, fail safe on unreadable JSON, and initialize absent legacy collections');
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

    user_warehouse_start = source.find("function wtEnsureUserWarehouse(user)")
    user_warehouse_end = source.find("function wtCurrentSaleWarehouse()", user_warehouse_start)
    user_warehouse_helper = source[user_warehouse_start:user_warehouse_end] if user_warehouse_start >= 0 and user_warehouse_end > user_warehouse_start else ""
    if "if(!Object.prototype.hasOwnProperty.call(AppData,'warehouses'))AppData.warehouses=[];" not in user_warehouse_helper or "AppData.warehouses.some(w=>" not in user_warehouse_helper or "if(!Array.isArray(AppData.warehouses))AppData.warehouses=[];" in user_warehouse_helper:
        errors.append("user warehouse assignment must preserve and reject malformed persisted warehouse lists")
    else:
        print("PASS: user warehouse assignment fails closed on malformed warehouse lists")

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
