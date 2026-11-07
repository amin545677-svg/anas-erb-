import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "sw.js").read_text(encoding="utf-8")


class ServiceWorkerCacheRegressionTests(unittest.TestCase):
    def test_cache_version_is_bumped_to_force_worker_install(self):
        match = re.search(r"const CACHE = ['\\\"]([^'\\\"]+)['\\\"]", SOURCE)
        self.assertIsNotNone(match, "service worker cache version must be explicit")
        self.assertNotEqual(match.group(1), "anas-erp-v54-25", "old cache name would not force an app-shell refresh")

    def test_activation_removes_prior_app_shell_caches_only(self):
        self.assertIn("key.startsWith('anas-erp-') && key !== CACHE", SOURCE)
        self.assertIn("caches.delete(key)", SOURCE)

    def test_navigation_is_network_first_with_current_cache_fallback(self):
        nav = SOURCE.split("if (request.mode === 'navigate')", 1)[1].split("return;", 1)[0]
        self.assertIn("fetch(request)", nav)
        self.assertIn(".catch(() => caches.open(CACHE).then(cache => cache.match('./index.html')))", nav)
        self.assertIn("cache.match('./index.html')).then(cached => cached || response)", nav,
                      "HTTP error responses must fall back to the current cached shell")
        self.assertNotIn("caches.match('./index.html')", nav, "global cache lookup can return a stale prior app shell")

    def test_core_assets_are_network_first_not_cache_first(self):
        core = SOURCE.split("if (!CORE_URLS.has(url.href)) return;", 1)[1]
        self.assertIn("fetch(request)", core)
        self.assertIn("caches.open(CACHE).then(cache => cache.match(request))", core)
        self.assertLess(core.index("fetch(request)"), core.index(".catch("))

    def test_reverse_ledger_runtime_is_in_offline_core_shell(self):
        self.assertIn("'./reverse-ledger/reverse-ledger.js'", SOURCE)
        self.assertIn("new URL(path, self.location.href)", SOURCE)

    def test_all_local_html_runtime_dependencies_are_precached(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        core_match = re.search(r"const CORE = \[(.*?)\];", SOURCE, re.S)
        self.assertIsNotNone(core_match, "service worker must declare an explicit core asset list")
        core_assets = set(re.findall(r"""['"]([^'"]+)['"]""", core_match.group(1)))
        dependencies = re.findall(
            r"""<(?:script|link)\b[^>]*?\b(?:src|href)=['"]([^'"]+)['"]""",
            html, re.I
        )
        local_dependencies = {asset for asset in dependencies if asset.startswith("./")}
        self.assertTrue(local_dependencies, "application must expose local runtime dependencies")
        missing = sorted(local_dependencies - core_assets)
        self.assertEqual(
            missing, [],
            "offline app shell is missing local runtime dependencies: " + ", ".join(missing)
        )

    def test_non_get_and_cross_origin_requests_are_not_intercepted(self):
        self.assertIn("if (request.method !== 'GET') return;", SOURCE)
        self.assertIn("if (url.origin !== self.location.origin) return;", SOURCE)

    def test_runtime_cache_and_offline_behavior(self):
        subprocess.run(
            ["node", str(ROOT / "tests" / "service_worker_runtime_test.js")],
            cwd=ROOT,
            check=True,
        )

    def test_ocr_assets_are_cached_individually_without_blocking_shell_install(self):
        self.assertIn("Promise.allSettled(OCR_ASSETS.map(path => cache.add(path)))", SOURCE)
        self.assertNotIn("cache.addAll(OCR_ASSETS)", SOURCE)
        self.assertIn("const OCR_ASSETS = [", SOURCE)

if __name__ == "__main__":
    unittest.main()
