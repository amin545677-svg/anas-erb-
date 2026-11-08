import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const source = await readFile(resolve("index.html"), "utf8");
const marker = '<style id="anas-firebase-mobile-layout-v3">';
const styleStart = source.lastIndexOf(marker);
const styleEnd = source.indexOf("</style>", styleStart);
assert.notEqual(styleStart, -1, "document-level Firebase responsive CSS must exist");
assert.ok(styleEnd > styleStart, "responsive CSS style block must be complete");
assert.ok(styleStart > source.lastIndexOf("</script>"), "responsive CSS must be outside inline JavaScript strings");
assert.ok(styleStart < source.lastIndexOf("</body>"), "responsive CSS must be inside the live document");
const css = source.slice(styleStart, styleEnd + "</style>".length);

async function createPage(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 820 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">${css}
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; }
    .page { width: 100%; max-width: 760px; margin: 0 auto; padding: 14px; }
    .field-input { min-height: 48px; }
  </style></head><body>
    <main class="page">
      <section class="anas-firebase-auth-card">
        <h3>ربط Firebase — Anas ERP</h3>
        <label>البريد الإلكتروني</label><input class="field-input">
        <label>كلمة المرور</label><input class="field-input" type="password">
        <div class="anas-firebase-auth-actions">
          <button>🧪 اختبار اتصال الخادم</button>
          <button>🔎 فحص شامل للربط</button>
          <button>🔐 تسجيل الدخول بالبريد</button>
          <button>🔵 المتابعة باستخدام Google</button>
          <button>تسجيل الخروج</button>
        </div>
        <div style="height:18px"></div>
        <div class="anas-firebase-cloud-actions">
          <button>☁️ رفع نسخة البيانات</button>
          <button>⬇️ استرجاع من السحابة</button>
        </div>
        <p>تنبيه: حافظ على قواعد Firestore الآمنة.</p>
      </section>
      <div style="height:1100px"></div>
    </main>
    <button id="anasContextAiFab">✨ مساعد ChatGPT</button>
    <section id="anasContextAiPanel">مساعد ANAS ERP</section>
  </body></html>`, { waitUntil: "domcontentloaded" });
  return page;
}

test("Firebase auth and cloud buttons remain readable and non-overlapping on narrow Android viewports", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await createPage(browser, 360);
    const metrics = await page.evaluate(() => {
      const auth = document.querySelector(".anas-firebase-auth-actions");
      const cloud = document.querySelector(".anas-firebase-cloud-actions");
      const buttons = [...document.querySelectorAll(".anas-firebase-auth-actions button, .anas-firebase-cloud-actions button")];
      const fab = document.getElementById("anasContextAiFab");
      return {
        authColumns: getComputedStyle(auth).gridTemplateColumns.split(" ").length,
        cloudColumns: getComputedStyle(cloud).gridTemplateColumns.split(" ").length,
        buttons: buttons.map(button => ({
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          direction: getComputedStyle(button).direction,
          fontSize: getComputedStyle(button).fontSize
        })),
        bodyPaddingBottom: parseFloat(getComputedStyle(document.body).paddingBottom),
        fabZ: Number(getComputedStyle(fab).zIndex)
      };
    });
    assert.equal(metrics.authColumns, 1);
    assert.equal(metrics.cloudColumns, 1);
    assert.equal(metrics.buttons.length, 7);
    for (const button of metrics.buttons) {
      assert.ok(button.width >= 300, "button must have enough horizontal room for Arabic words");
      assert.ok(button.height >= 52, "button must retain a comfortable touch target");
      assert.equal(button.direction, "rtl");
    }
    assert.ok(metrics.bodyPaddingBottom >= 96);
    assert.equal(metrics.fabZ, 80);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const overlap = await page.evaluate(() => {
      const lastCloudButton = document.querySelector(".anas-firebase-cloud-actions button:last-child").getBoundingClientRect();
      const fab = document.getElementById("anasContextAiFab").getBoundingClientRect();
      return lastCloudButton.bottom > fab.top && lastCloudButton.top < fab.bottom;
    });
    assert.equal(overlap, false, "floating assistant must not cover the cloud restore button");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("Firebase auth and cloud controls use a balanced two-column grid on wider screens", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await createPage(browser, 768);
    const result = await page.evaluate(() => ({
      authColumns: getComputedStyle(document.querySelector(".anas-firebase-auth-actions")).gridTemplateColumns.split(" ").length,
      cloudColumns: getComputedStyle(document.querySelector(".anas-firebase-cloud-actions")).gridTemplateColumns.split(" ").length,
      direction: getComputedStyle(document.querySelector(".anas-firebase-cloud-actions button")).direction
    }));
    assert.equal(result.authColumns, 2);
    assert.equal(result.cloudColumns, 2);
    assert.equal(result.direction, "rtl");
    await page.close();
  } finally {
    await browser.close();
  }
});
