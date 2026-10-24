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

    # Warehouse balances must be actual finite non-negative numbers or non-empty numeric strings.
    warehouse_balance_guard = "String(balance).trim() !== '' && Number.isFinite(Number(balance)) && Number(balance) >= 0"
    if warehouse_balance_guard not in source or "typeof balance === 'number' || typeof balance === 'string'" not in source:
        errors.append("backup validator must reject blank, boolean, object, non-finite, and negative warehouse balances")
    else:
        print("PASS: backup validator rejects blank and non-numeric warehouse balances")

    if "Object.prototype.hasOwnProperty.call(incoming,key)" not in source or "Object.prototype.hasOwnProperty.call(p,'warehouseStock')" not in source or "!p.warehouseStock || typeof p.warehouseStock !== 'object' || Array.isArray(p.warehouseStock)" not in source:
        errors.append("backup validator must reject explicit null history arrays and explicit null/invalid warehouseStock maps")
    else:
        print("PASS: backup validator rejects explicit null history and stock maps")

    if "Object.prototype.hasOwnProperty.call(incoming,'warehouses')" not in source or "typeof w === 'string' && w.trim()" not in source or "typeof w.name !== 'string' || !w.name.trim()" not in source:
        errors.append("backup validator must accept valid legacy string warehouse names and validate object warehouse records")
    else:
        print("PASS: backup validator supports legacy string and object warehouse entries safely")

    primary_stock_guard = "typeof p.stock === 'number' || typeof p.stock === 'string'"
    if primary_stock_guard not in source or "String(p.stock).trim() !== '' && Number.isFinite(Number(p.stock)) && Number(p.stock) >= 0" not in source:
        errors.append("backup validator must reject blank, boolean, object, non-finite, and negative primary stock values")
    else:
        print("PASS: backup validator rejects malformed primary stock values")

    if "Object.prototype.hasOwnProperty.call(incoming,'posScreensCarts')" not in source or "!incoming.posScreensCarts || typeof incoming.posScreensCarts !== 'object' || Array.isArray(incoming.posScreensCarts)" not in source:
        errors.append("backup validator must reject explicitly present null/invalid POS cart collections")
    else:
        print("PASS: backup validator rejects explicit null POS cart collections")

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
