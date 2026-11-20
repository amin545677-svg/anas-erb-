import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, createSign } from "node:crypto";

const source = await readFile(new URL("./worker_openai_ai.js", import.meta.url), "utf8");
const workerModule = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const worker = workerModule.default;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
Object.assign(jwk, { kid: "test-firebase-key", alg: "RS256", use: "sig" });

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-firebase-key" }));
  const claims = base64url(JSON.stringify({
    aud: "anas-erb", iss: "https://securetoken.google.com/anas-erb", sub: "test-user-123",
    iat: now, exp: now + 3600, auth_time: now, ...overrides
  }));
  const input = header + "." + claims;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return input + "." + signer.sign(privateKey).toString("base64url");
}

function request(token, origin = "https://amin545677-svg.github.io") {
  const headers = { Origin: origin, "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://worker.test/", { method: "POST", headers, body: JSON.stringify({ message: "اختبار" }) });
}

test("rejects missing Firebase bearer token before contacting OpenAI", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network call"); };
  try {
    const response = await worker.fetch(request(null), { OPENAI_API_KEY: "test-key" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
    assert.match((await response.json()).error, /Authentication required/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects requests from an unapproved origin", async () => {
  const response = await worker.fetch(request(makeToken(), "https://attacker.example"), { OPENAI_API_KEY: "test-key" });
  assert.equal(response.status, 403);
});

test("verifies Firebase RS256 signature and claims before proxying", async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes("securetoken@system.gserviceaccount.com"))
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    if (String(url) === "https://api.openai.com/v1/responses")
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "تم الاختبار بنجاح" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error("unexpected URL: " + url);
  };
  try {
    const response = await worker.fetch(request(makeToken()), { OPENAI_API_KEY: "test-key", FIREBASE_PROJECT_ID: "anas-erb" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.text, "تم الاختبار بنجاح");
    assert.ok(calls.some(url => url.includes("securetoken@system.gserviceaccount.com")));
    assert.ok(calls.includes("https://api.openai.com/v1/responses"));
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a correctly signed token with the wrong Firebase audience", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "max-age=300" } }); };
  try {
    const response = await worker.fetch(request(makeToken({ aud: "other-project" })), { OPENAI_API_KEY: "test-key" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});


test("rejects an expired Firebase token before contacting signing keys or OpenAI", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network must not be called for expired tokens"); };
  try {
    const response = await worker.fetch(request(makeToken({ exp: Math.floor(Date.now() / 1000) - 1 })), { OPENAI_API_KEY: "test-key" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
    assert.match((await response.json()).error, /Invalid or expired Firebase session/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a correctly signed token from a different Firebase issuer", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network must not be called for wrong issuer"); };
  try {
    const response = await worker.fetch(request(makeToken({ iss: "https://securetoken.google.com/other-project" })), { OPENAI_API_KEY: "test-key" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a token with a tampered RS256 signature before contacting OpenAI", async () => {
  const originalFetch = globalThis.fetch; let openAiCalls = 0;
  const validParts = makeToken().split(".");
  validParts[2] = base64url("tampered-signature");
  globalThis.fetch = async (url) => {
    if (String(url).includes("securetoken@system.gserviceaccount.com"))
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "max-age=300" } });
    if (String(url) === "https://api.openai.com/v1/responses") openAiCalls++;
    throw new Error("unexpected upstream request");
  };
  try {
    const response = await worker.fetch(request(validParts.join(".")), { OPENAI_API_KEY: "test-key" });
    assert.equal(response.status, 401);
    assert.equal(openAiCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});


test("explains incomplete business metrics and unavailable cash balance instead of presenting false totals", async () => {
  const originalFetch = globalThis.fetch;
  let openAiPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("securetoken@system.gserviceaccount.com"))
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    if (String(url) === "https://api.openai.com/v1/responses") {
      openAiPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "المجاميع جزئية ورصيد الصندوق غير متاح." }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected URL: " + url);
  };
  try {
    const businessData = {
      totals: { invoiceTotalsDZD: 1200, cashBalanceDZD: null },
      dataQuality: {
        hasIncompleteFinancialData: true,
        incompleteMetrics: ["cashBalanceDZD"],
        metricCoverage: { cashBalanceDZD: { validRecords: 0, invalidRecords: 1 } }
      }
    };
    const token = makeToken();
    const response = await worker.fetch(new Request("https://worker.test/", {
      method: "POST",
      headers: {
        Origin: "https://amin545677-svg.github.io",
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify({ message: "حلل البيانات المالية", businessData })
    }), { OPENAI_API_KEY: "test-key", FIREBASE_PROJECT_ID: "anas-erb" });
    assert.equal(response.status, 200);
    assert.ok(openAiPayload);
    assert.match(openAiPayload.instructions, /dataQuality\.hasIncompleteFinancialData/);
    assert.match(openAiPayload.instructions, /metricCoverage/);
    assert.match(openAiPayload.instructions, /cashBalanceDZD/);
    assert.match(openAiPayload.instructions, /لا تستبدل القيمة المفقودة بصفر/);
    assert.match(openAiPayload.input, /"hasIncompleteFinancialData":true/);
    assert.match(openAiPayload.input, /"cashBalanceDZD":null/);
    assert.equal(openAiPayload.store, false);
  } finally { globalThis.fetch = originalFetch; }
});
