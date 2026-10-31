#!/usr/bin/env python3
"""Static regression checks for the additive ANAS ERP classic UI layer."""
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / "index.html"
CSS_PATH = ROOT / "anas-classic-ui.css"

class StylesheetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stylesheets = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "link":
            return
        attrs = dict(attrs)
        rel = (attrs.get("rel") or "").lower().split()
        if "stylesheet" in rel:
            self.stylesheets.append(attrs.get("href", ""))

class ClassicUIRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = HTML_PATH.read_text(encoding="utf-8")
        cls.css = CSS_PATH.read_text(encoding="utf-8")
        cls.parser = StylesheetParser()
        cls.parser.feed(cls.html)
        cls.parser.close()

    def test_classic_stylesheet_is_linked_exactly_once(self):
        matches = [
            href for href in self.parser.stylesheets
            if href and re.search(r"(?:^|/)anas-classic-ui\.css(?:\?|$)", href)
        ]
        self.assertEqual(len(matches), 1, "classic stylesheet must be linked exactly once")
        self.assertEqual(matches[0].split("?", 1)[0], "./anas-classic-ui.css")
        self.assertTrue(CSS_PATH.is_file(), "linked stylesheet file must exist")
        self.assertNotIn(r"\n</head>", self.html, "HTML must not contain a literal escaped newline before head close")

    def test_responsive_breakpoints_cover_phone_and_desktop(self):
        self.assertRegex(self.css, r"@media\s*\(max-width:\s*420px\)")
        self.assertRegex(self.css, r"@media\s*\(min-width:\s*700px\)")
        self.assertRegex(self.css, r"@media\s*\(min-width:\s*1024px\)")
        self.assertRegex(self.css, r"@media\s*\(max-width:\s*360px\)")

    def test_dark_mode_uses_application_theme_tokens(self):
        self.assertIn(':root[data-anas-theme="dark"]', self.css)
        self.assertIn("var(--anas-bg", self.css)
        self.assertIn("var(--anas-text", self.css)
        self.assertIn("var(--anas-surface", self.css)
        self.assertIn("var(--anas-border", self.css)

    def test_keyboard_focus_and_touch_targets_remain_usable(self):
        self.assertIn(":focus-visible", self.css)
        self.assertIn("touch-action: manipulation", self.css)
        self.assertIn("min-height: 46px", self.css)

    def test_reduced_motion_preference_is_respected(self):
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.css)
        self.assertIn("transition-duration: .01ms", self.css)

    def test_mobile_pos_layout_is_scoped_and_scroll_safe(self):
        self.assertIn("#view-pos .sales-toolbar", self.css)
        self.assertIn("flex-wrap: wrap", self.css)
        self.assertRegex(self.css, r"@media\\s*\\(max-width:\\s*600px\\)")
        self.assertIn("#view-pos .invoice-items-body", self.css)
        self.assertIn("overscroll-behavior-x: contain", self.css)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", self.css)

    def test_drawer_respects_dynamic_viewport_and_safe_areas(self):
        self.assertIn("height: 100dvh", self.css)
        self.assertIn("env(safe-area-inset-top)", self.css)
        self.assertIn("env(safe-area-inset-bottom)", self.css)
        self.assertIn("min-height: 48px", self.css)

    def test_stylesheet_is_additive_and_does_not_override_business_logic(self):
        forbidden = ("<script", "localStorage", "firebase", "function ")
        for token in forbidden:
            self.assertNotIn(token.lower(), self.css.lower(), f"CSS must not contain executable/business token: {token}")

if __name__ == "__main__":
    unittest.main(verbosity=2)
