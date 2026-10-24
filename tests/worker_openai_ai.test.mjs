import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Load the real Worker source without changing the app's package/module settings.
const source = await readFile(resolve("cloudflare/worker_openai_ai.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);

function request(path, { method = "GET", origin, body } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
}

const allowedOrigin = "https://amin545677-svg.github.io";

test("health reports service status without exposing the API key", async () => {
  const response = await worker.fetch(request("/health"), { OPENAI_API_KEY: "test-secret" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.configured, true);
  assert.equal(JSON.stringify(data).includes("test-secret"), false);
});

test("browser requests from an unapproved origin are rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", origin: "https://evil.example", body: { message: "hello" }
  }), { OPENAI_API_KEY: "test-secret" });
  assert.equal(response.status, 403);
});

test("POST without an Origin is rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", body: { message: "hello" }
  }), { OPENAI_API_KEY: "test-secret" });
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
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, body: "{bad json"
    }), { OPENAI_API_KEY: "test-secret" });
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("empty question is rejected", async () => {
  const response = await worker.fetch(request("/", {
    method: "POST", origin: allowedOrigin, body: { message: "   " }
  }), { OPENAI_API_KEY: "test-secret" });
  assert.equal(response.status, 400);
});

test("successful request returns only the expected answer contract", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.match(init.headers.Authorization, /^Bearer test-secret$/);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "تحليل تجريبي" }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin, body: { message: "حلل المبيعات", language: "ar" }
    }), { OPENAI_API_KEY: "test-secret" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
    assert.deepEqual(await response.json(), { ok: true, text: "تحليل تجريبي", model: "gpt-4.1-mini" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("oversized request body is rejected", async () => {
  const oversized = { message: "x".repeat(121 * 1024) };
  const response = await worker.fetch(request("/", {
    method: "POST", origin: allowedOrigin, body: oversized
  }), { OPENAI_API_KEY: "test-secret" });
  assert.equal(response.status, 413);
});
