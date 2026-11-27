import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync, createSign } from "node:crypto";

// Load the real Worker source without changing the app's package/module settings.
const source = await readFile(resolve("cloudflare/worker_openai_ai.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);

function request(path, { method = "GET", origin, body, tokenProjectId = "anas-erb", tokenClaims = {} } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", "Bearer " + firebaseToken(tokenClaims, tokenProjectId));
    headers.set("CF-Connecting-IP", "203.0.113.10");
  }
  return new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
}

const jwksUrl = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const firebaseJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-firebase-key", alg: "RS256", use: "sig" };
function firebaseToken(overrides = {}, projectId = "anas-erb") {
  const encode = value => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-firebase-key" }));
  const claims = encode(JSON.stringify({ aud: projectId, iss: "https://securetoken.google.com/" + projectId, sub: "test-user", iat: now, exp: now + 3600, auth_time: now, ...overrides }));
  const input = header + "." + claims;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return input + "." + signer.sign(privateKey).toString("base64url");
}
function installFetch(mock = async () => { throw new Error("unexpected upstream request"); }) {
  globalThis.fetch = async (url, init) => {
    if (String(url) === jwksUrl) return new Response(JSON.stringify({ keys: [firebaseJwk] }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    return mock(url, init);
  };
}
installFetch();
const allowedOrigin = "https://amin545677-svg.github.io";
const allowLimiter = { limit: async () => ({ success: true }) };
const testEnv = () => ({ OPENAI_API_KEY: "test-secret", AI_USER_RATE_LIMITER: allowLimiter, AI_ANON_USER_RATE_LIMITER: allowLimiter, AI_IP_RATE_LIMITER: allowLimiter });

test("preflight permits the isolated Staging ERP origin and required auth headers", async () => {
  const origin = "https://anas-erp-staging-a25e1.web.app";
  const response = await worker.fetch(new Request("https://worker.test/", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type"
    }
  }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/i);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Content-Type/i);
});

test("preflight permits the Firebase Hosting alternate Staging origin", async () => {
  const origin = "https://anas-erp-staging-a25e1.firebaseapp.com";
  const response = await worker.fetch(new Request("https://worker.test/chat", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type"
    }
  }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("preflight rejects untrusted origins without reflecting them", async () => {
  const origin = "https://untrusted.example";
  const response = await worker.fetch(new Request("https://worker.test/", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
  }), {});
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});


test("interrupted OpenAI response returns a readable CORS-enabled 502 instead of an unhandled Worker failure", async () => {
  const oldFetch = globalThis.fetch;
  installFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("upstream socket closed")); }
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: "https://anas-erp-staging-a25e1.web.app",
      tokenProjectId: "anas-erp-staging-a25e1",
      body: { message: "اختبار انقطاع الاستجابة" }
    }), testEnv());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://anas-erp-staging-a25e1.web.app");
    assert.match((await response.json()).error, /connection ended/i);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("health reports service status without exposing the API key", async () => {
  const response = await worker.fetch(request("/health"), testEnv());
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.configured, true);
  assert.equal(data.rateLimitConfigured, true);
  assert.equal(JSON.stringify(data).includes("test-secret"), false);
});

test("browser requests from an unapproved origin are rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", origin: "https://evil.example", body: { message: "hello" }
  }), testEnv());
  assert.equal(response.status, 403);
});

test("POST without an Origin is rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", body: { message: "hello" }
  }), testEnv());
  assert.equal(response.status, 403);
});

test("missing API key returns a safe configuration error", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", origin: allowedOrigin, body: { message: "hello" }
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
});

test("invalid JSON is rejected before calling OpenAI", async () => {
  const oldFetch = globalThis.fetch;
  installFetch(async () => { throw new Error("upstream must not be called"); });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, body: "{bad json"
    }), testEnv());
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("empty question is rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", origin: allowedOrigin, body: { message: "   " }
  }), testEnv());
  assert.equal(response.status, 400);
});

test("successful request returns only the expected answer contract", async () => {
  const oldFetch = globalThis.fetch;
  installFetch(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.match(init.headers.Authorization, /^Bearer test-secret$/);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "تحليل تجريبي" }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, body: { message: "حلل المبيعات", language: "ar" }
    }), testEnv());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
    assert.deepEqual(await response.json(), { ok: true, text: "تحليل تجريبي", model: "gpt-4.1-mini" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("streaming requests forward text deltas as server-sent events", async () => {
  const oldFetch = globalThis.fetch;
  installFetch(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(JSON.parse(init.body).stream, true);
    const payload = [
      { type: "response.output_text.delta", delta: "مرحبا " },
      { type: "response.output_text.delta", delta: "بك" },
      { type: "response.completed" }
    ].map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin,
      body: { message: "اختبار بث", stream: true }
    }), testEnv());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /"delta":"مرحبا "/);
    assert.match(body, /"delta":"بك"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("oversized request body is rejected", async () => {
  const oversized = { message: "x".repeat(121 * 1024) };
  const response = await worker.fetch(request("/", {
    method: "POST", origin: allowedOrigin, body: oversized
  }), testEnv());
  assert.equal(response.status, 413);
});

test("oversized request stream is cancelled as soon as it crosses the byte limit", async () => {
  const oldFetch = globalThis.fetch;
  let cancelled = false;
  let pulled = 0;
  globalThis.fetch = async () => { throw new Error("OpenAI must not be called for an oversized request"); };
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(120 * 1024 + 1));
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  try {
    const response = await worker.fetch(new Request("https://worker.test/", {
      method: "POST",
      headers: { Origin: allowedOrigin, "Content-Type": "application/json", Authorization: "Bearer " + firebaseToken(), "CF-Connecting-IP": "203.0.113.10" },
      body,
      duplex: "half"
    }), testEnv());
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/i);
    assert.equal(cancelled, true, "request body stream must be cancelled at the limit");
    assert.equal(pulled, 1, "the worker must stop reading once the limit is crossed");
  } finally {
    globalThis.fetch = oldFetch;
  }
});


const appHtml = await readFile(resolve("index.html"), "utf8");
test("contextual AI helper authenticates Firebase requests to the protected gateway", () => {
  const helperRoot = appHtml.indexOf("const fab=document.getElementById('anasContextAiFab')");
  const helperStart = appHtml.indexOf("send.addEventListener('click',async function(){", helperRoot);
  const helperEnd = appHtml.indexOf("\n  });\n})();", helperStart);
  assert.notEqual(helperRoot, -1, "contextual AI helper must exist");
  assert.notEqual(helperStart, -1, "contextual AI send handler must exist");
  assert.notEqual(helperEnd, -1, "contextual AI send handler must be closed");
  const handler = appHtml.slice(helperStart, helperEnd);
  assert.match(handler, /window\.anasGetFirebaseIdToken\(8000\)/, "contextual helper must await shared Firebase session restoration");
  assert.match(handler, /['"]?Authorization['"]?\s*:\s*['"]Bearer ['"]\s*\+\s*firebaseIdToken/);
  assert.match(handler, /تعذر التحقق من الجلسة السحابية/);
});

test("AI hub timeout remains active until the response stream is fully consumed", () => {
  const streamIndex = appHtml.indexOf("answer=await anasAiReadEventStream(resp");
  assert.notEqual(streamIndex, -1, "AI hub must consume streaming responses");
  const timerStart = appHtml.lastIndexOf("timer=setTimeout(()=>controller.abort(),45000);", streamIndex);
  assert.notEqual(timerStart, -1, "AI hub must start a bounded request timeout");
  const earlyClear = appHtml.indexOf("clearTimeout(timer)", timerStart);
  assert.ok(earlyClear === -1 || earlyClear > streamIndex, "timeout must not be cleared when response headers arrive");
  const cleanup = appHtml.indexOf("if(timer!==null)clearTimeout(timer)", streamIndex);
  assert.ok(cleanup > streamIndex, "timeout must be cleared after response consumption");
});

test("PDF analysis sends a Firebase ID token to the protected AI gateway", () => {
  const start = appHtml.indexOf("async function anasAskAiAboutPdf()");
  const end = appHtml.indexOf("function parseSmartCsv", start);
  assert.notEqual(start, -1, "PDF analysis handler must exist");
  assert.ok(end > start, "PDF handler boundary must exist");
  const handler = appHtml.slice(start, end);
  assert.match(handler, /anasGetFirebaseIdToken/);
  assert.match(handler, /Authorization.*firebaseIdToken/, "PDF analysis must send its Firebase ID token");
  assert.match(handler, /خدمة استعادة جلسة Firebase غير جاهزة/);
});

test("Excel import column analysis is local and does not require a Firebase or cloud AI session", () => {
  const start = appHtml.indexOf("box.querySelector('#smartImportAiAnalyze').onclick=async()=>{");
  const end = appHtml.indexOf("box.querySelector('#smartImportCancel')", start);
  assert.notEqual(start, -1, "Excel local analysis handler must exist");
  assert.ok(end > start, "Excel handler boundary must exist");
  const handler = appHtml.slice(start, end);
  assert.match(handler, /const norm=s=>/);
  assert.match(handler, /const aliases=/);
  assert.match(handler, /Header matching is entirely local/);
  assert.match(handler, /return;/);
  assert.doesNotMatch(handler, /anasGetFirebaseIdToken|Authorization|fetch\(/,
    "local column analysis must not request Firebase credentials or call a cloud endpoint");
});

test("Arabic sales draft matches local records and converts to a review-only POS cart", () => {
  assert.match(appHtml, /normalizeDigits/);
  assert.match(appHtml, /productCandidates/);
  assert.match(appHtml, /customerCandidates/);
  assert.match(appHtml, /تحويل إلى فاتورة مبيعات جاهزة/);
  assert.match(appHtml, /anasConvertNaturalDraftToSale/);
  assert.match(appHtml, /__anasPendingSaleCustomerId/);
  assert.match(appHtml, /لم تُعتمد الفاتورة بعد/);
});

test("local AI audit values stock at both purchase and selling prices", () => {
  assert.match(appHtml, /function anasInventoryCostAggregateCents\(products\)/);
  assert.match(appHtml, /const stockCostAggregate=anasInventoryCostAggregateCents\(products\)/);
  assert.match(appHtml, /const stockSell=products\.reduce/);
  assert.match(appHtml, /قيمة المخزون بسعر الشراء/);
  assert.match(appHtml, /قيمة المخزون بسعر البيع/);
  assert.match(appHtml, /anasRunLocalBusinessAudit\(\)/);
});

test("mobile customer, expense and purchase forms scroll focused fields above the keyboard", () => {
  assert.match(appHtml, /max-height: 85dvh/);
  assert.match(appHtml, /overflow-y: auto/);
  assert.match(appHtml, /field\.scrollIntoView\(\{behavior:'smooth',block:'center',inline:'nearest'\}/);
  assert.match(appHtml, /#view-expenses \.panel-card-form/);
  assert.match(appHtml, /#view-purchases \.panel-card-form/);
});

test("Staging-origin AI requests validate Firebase ID tokens against the Staging project", async () => {
  const oldFetch = globalThis.fetch;
  const stagingOrigin = "https://anas-erp-staging-a25e1.web.app";
  installFetch(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(JSON.parse(init.body).store, false);
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "إجابة Staging" }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST",
      origin: stagingOrigin,
      tokenProjectId: "anas-erp-staging-a25e1",
      body: { message: "اختبار بيئة Staging" }
    }), testEnv());
    assert.equal(response.status, 200, "Staging Firebase token must not be rejected as a Production token");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), stagingOrigin);
    assert.deepEqual(await response.json(), { ok: true, text: "إجابة Staging", model: "gpt-4.1-mini" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Staging-origin AI requests reject Production Firebase tokens", async () => {
  const stagingOrigin = "https://anas-erp-staging-a25e1.web.app";
  const response = await worker.fetch(request("/", {
    method: "POST",
    origin: stagingOrigin,
    tokenProjectId: "anas-erb",
    body: { message: "must be rejected" }
  }), testEnv());
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Invalid or expired Firebase session/);
});


test("paid AI requests fail closed when rate-limit bindings are missing", async () => {
  const oldFetch = globalThis.fetch; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", { method: "POST", origin: allowedOrigin, body: { message: "missing limiter" } }), { OPENAI_API_KEY: "test-secret" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /rate limiting is not configured/i);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("per-user rate limit blocks before OpenAI and keys the Firebase UID", async () => {
  const oldFetch = globalThis.fetch; let openAiCalls = 0; let userKey = ""; let ipKey = "";
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", { method: "POST", origin: allowedOrigin, body: { message: "rate limit" } }), {
      OPENAI_API_KEY: "test-secret",
      AI_USER_RATE_LIMITER: { limit: async ({ key }) => { userKey = key; return { success: false }; } },
      AI_IP_RATE_LIMITER: { limit: async ({ key }) => { ipKey = key; return { success: true }; } }
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(userKey, "uid:test-user");
    assert.equal(ipKey, "ip:203.0.113.10");
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("per-IP rate limit blocks requests when the Firebase UID is within quota", async () => {
  const oldFetch = globalThis.fetch; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", { method: "POST", origin: allowedOrigin, body: { message: "rate limit" } }), {
      OPENAI_API_KEY: "test-secret", AI_USER_RATE_LIMITER: allowLimiter,
      AI_IP_RATE_LIMITER: { limit: async ({ key }) => ({ success: key !== "ip:203.0.113.10" }) }
    });
    assert.equal(response.status, 429);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("rate-limit backend errors fail closed without contacting OpenAI", async () => {
  const oldFetch = globalThis.fetch; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", { method: "POST", origin: allowedOrigin, body: { message: "limiter error" } }), {
      OPENAI_API_KEY: "test-secret",
      AI_USER_RATE_LIMITER: { limit: async () => { throw new Error("limiter unavailable"); } },
      AI_IP_RATE_LIMITER: allowLimiter
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /temporarily unavailable/i);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});


test("an IP-blocked request does not consume an individual user's quota", async () => {
  const oldFetch = globalThis.fetch; let userLimiterCalls = 0; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", { method: "POST", origin: allowedOrigin, body: { message: "shared network" } }), {
      OPENAI_API_KEY: "test-secret",
      AI_IP_RATE_LIMITER: { limit: async () => ({ success: false }) },
      AI_USER_RATE_LIMITER: { limit: async () => { userLimiterCalls++; return { success: true }; } }
    });
    assert.equal(response.status, 429);
    assert.equal(userLimiterCalls, 0);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});


test("rate-limit configuration preserves a user budget and shared-mobile-IP safety margin", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(resolve("cloudflare/wrangler-openai.toml"), "utf8");
  assert.ok(config.includes('name = "AI_USER_RATE_LIMITER"'));
  assert.ok(config.includes('simple = { limit = 12, period = 60 }'));
  assert.ok(config.includes('name = "AI_ANON_USER_RATE_LIMITER"'));
  assert.ok(config.includes('simple = { limit = 3, period = 60 }'));
  assert.ok(config.includes('name = "AI_IP_RATE_LIMITER"'));
  assert.ok(config.includes('simple = { limit = 120, period = 60 }'));
  assert.ok(source.includes("/[\\s,]/.test(ip)"));
});


test("health reports rate-limit bindings as unavailable when they are not bound", async () => {
  const response = await worker.fetch(request("/health"), { OPENAI_API_KEY: "test-secret" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.configured, true);
  assert.equal(data.rateLimitConfigured, false);
});

test("deployment workflow pins Wrangler v4 and verifies rate-limit bindings in its smoke test", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(resolve(".github/workflows/deploy-openai-ai-worker.yml"), "utf8");
  assert.ok(workflow.includes("cloudflare/wrangler-action@v4"));
  assert.ok(workflow.includes('wranglerVersion: "4.158.0"'));
  assert.ok(workflow.includes("wrangler@4.158.0"));
  assert.ok(workflow.includes("rateLimitConfigured!==true"));
  assert.ok(!workflow.includes("wrangler@3.90.0"));
});


test("anonymous Firebase users receive a separate stricter UID quota", async () => {
  const oldFetch = globalThis.fetch; let anonymousKey = ""; let registeredCalls = 0; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called after anonymous quota denial"); });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, tokenClaims: { firebase: { sign_in_provider: "anonymous" } },
      body: { message: "anonymous rate limit" }
    }), {
      OPENAI_API_KEY: "test-secret",
      AI_USER_RATE_LIMITER: { limit: async () => { registeredCalls++; return { success: true }; } },
      AI_ANON_USER_RATE_LIMITER: { limit: async ({ key }) => { anonymousKey = key; return { success: false }; } },
      AI_IP_RATE_LIMITER: allowLimiter
    });
    assert.equal(response.status, 429);
    assert.equal(anonymousKey, "anon:uid:test-user");
    assert.equal(registeredCalls, 0);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("anonymous requests fail closed when their dedicated limiter is missing", async () => {
  const oldFetch = globalThis.fetch; let openAiCalls = 0;
  installFetch(async () => { openAiCalls++; throw new Error("OpenAI must not be called"); });
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, tokenClaims: { firebase: { sign_in_provider: "anonymous" } },
      body: { message: "missing anonymous limiter" }
    }), { OPENAI_API_KEY: "test-secret", AI_USER_RATE_LIMITER: allowLimiter, AI_IP_RATE_LIMITER: allowLimiter });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /rate limiting is not configured/i);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});
