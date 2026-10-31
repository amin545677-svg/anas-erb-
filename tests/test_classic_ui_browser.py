#!/usr/bin/env python3
"""Browser smoke tests for ANAS ERP classic UI. Runs only against a local HTTP server."""
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading
import time
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *_args):
        pass

@contextmanager
def local_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/index.html"
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()

class ClassicUIBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_context = local_server()
        cls.url = cls.server_context.__enter__()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()
        cls.page = cls.browser.new_page()
        # Prevent any live Firebase/auth/API traffic; local UI assets remain available.
        cls.page.route("**/*", lambda route: route.abort()
                       if any(host in route.request.url for host in (
                           "googleapis.com", "firebaseapp.com", "firebasestorage.app",
                           "cloudfunctions.net"))
                       else route.continue_())
        cls.response = cls.page.goto(cls.url, wait_until="domcontentloaded", timeout=45000)
        cls.page.wait_for_selector("#view-dashboard.active", timeout=15000)
        cls.page.wait_for_timeout(500)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server_context.__exit__(None, None, None)

    def test_local_app_and_classic_stylesheet_load(self):
        self.assertIsNotNone(self.response)
        self.assertEqual(self.response.status, 200)
        self.assertIn("v42", self.page.title().lower())
        links = self.page.locator('link[rel="stylesheet"][href*="anas-classic-ui.css"]')
        self.assertEqual(links.count(), 1)
        self.assertTrue(self.page.evaluate("""() => {
          const link = document.querySelector('link[href*="anas-classic-ui.css"]');
          return !!link && [...document.styleSheets].some(s => s.href && s.href.includes('anas-classic-ui.css'));
        }"""))

    def test_dashboard_cards_render(self):
        self.assertGreaterEqual(self.page.locator("#view-dashboard .grid-card-item").count(), 8)

    def test_responsive_viewports_have_no_horizontal_document_overflow(self):
        for width, height in ((360, 800), (390, 844), (768, 1024), (1365, 900)):
            with self.subTest(viewport=(width, height)):
                self.page.set_viewport_size({"width": width, "height": height})
                self.page.wait_for_timeout(100)
                metrics = self.page.evaluate("""() => ({
                  viewport: document.documentElement.clientWidth,
                  html: document.documentElement.scrollWidth,
                  body: document.body.scrollWidth,
                  dashboard: document.querySelector('#view-dashboard').getBoundingClientRect().width
                })""")
                self.assertLessEqual(metrics["html"], metrics["viewport"] + 1, metrics)
                self.assertLessEqual(metrics["body"], metrics["viewport"] + 1, metrics)
                self.assertGreater(metrics["dashboard"], 0, metrics)

    def test_drawer_opens_and_closes_without_business_actions(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.locator(".btn-hamburger").click()
        self.assertTrue(self.page.locator("#drawerMenu").evaluate("(e) => e.classList.contains('active')"))
        self.assertTrue(self.page.locator("#drawerOverlay").evaluate("(e) => e.classList.contains('active')"))
        self.page.locator("#drawerOverlay").click(position={"x": 8, "y": 8}, force=True)
        self.assertFalse(self.page.locator("#drawerMenu").evaluate("(e) => e.classList.contains('active')"))
        self.assertFalse(self.page.locator("#drawerOverlay").evaluate("(e) => e.classList.contains('active')"))

if __name__ == "__main__":
    unittest.main(verbosity=2)
