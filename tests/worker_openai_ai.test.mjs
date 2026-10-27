import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

test("streaming requests forward text deltas as server-sent events", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
  };
  try {
    const response = await worker.fetch(request("/", {
      method: "POST", origin: allowedOrigin,
      body: { message: "اختبار بث", stream: true }
    }), { OPENAI_API_KEY: "test-secret" });
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
  }), { OPENAI_API_KEY: "test-secret" });
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
  });
  try {
    const response = await worker.fetch(new Request("https://worker.test/", {
      method: "POST",
      headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
      body,
      duplex: "half"
    }), { OPENAI_API_KEY: "test-secret" });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/i);
    assert.equal(cancelled, true, "request body stream must be cancelled at the limit");
    assert.equal(pulled, 1, "the worker must stop reading once the limit is crossed");
  } finally {
    globalThis.fetch = oldFetch;
  }
});
