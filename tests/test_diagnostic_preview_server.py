"""Local-only regression tests for the restricted Android diagnostic preview server."""
import importlib.util
from pathlib import Path
import threading
import unittest
from urllib.request import urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "serve_ai_diagnostic_preview.py"
SPEC = importlib.util.spec_from_file_location("anas_diag_preview", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DiagnosticPreviewServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MODULE.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_root_serves_app_shell_without_cache(self):
        with urlopen(self.base + "/") as response:
            body = response.read(512).decode("utf-8", "replace")
            self.assertEqual(response.status, 200)
            self.assertIn("no-store", response.headers.get("Cache-Control", ""))
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertIn("<!DOCTYPE html>", body)

    def test_index_query_is_allowed_for_diagnostic_mode(self):
        with urlopen(self.base + "/index.html?anasDiagIsolated=1") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("no-store", response.headers.get("Cache-Control", ""))

    def test_repository_paths_are_not_served(self):
        for path in ("/.git/config", "/tests/ai_prompt_dom_trace.mjs",
                     "/tools/serve_ai_diagnostic_preview.py", "/.github/workflows/anas-erp-html-checks.yml"):
            with self.subTest(path=path):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(self.base + path)
                self.assertEqual(caught.exception.code, 404)

    def test_directory_listing_is_disabled(self):
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.base + "/?list=1")  # root is intentionally rewritten to index.html
        self.assertNotEqual(caught.exception.code, 403)  # app shell, never a listing


if __name__ == "__main__":
    unittest.main()
