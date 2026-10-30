import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = await readFile(resolve("cloudflare/worker_firebase_snapshot.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);
const env = { FIREBASE_API_KEY: "test-key", FIREBASE_PROJECT_ID: "anas-erb", ALLOWED_ORIGINS: "https://anas-erp-staging-a25e1.web.app,https://anas-erp-staging-a25e1.firebaseapp.com" };
const allowedOrigin = "https://anas-erp-staging-a25e1.web.app";
const attackerOrigin = "https://attacker.example";

test("health endpoint rejects an untrusted origin without reflecting it in CORS headers", async () => {
  const response = await worker.fetch(new Request("https://worker.test/health", {
    method: "GET",
    headers: { Origin: attackerOrigin }
  }), env);
  assert.equal(response.status, 403);
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), attackerOrigin);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.match((await response.json()).error, /origin is not allowed/i);
});

test("preflight rejects an untrusted origin without granting cross-origin access", async () => {
  const response = await worker.fetch(new Request("https://worker.test/snapshot", {
    method: "OPTIONS",
    headers: {
      Origin: attackerOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type"
    }
  }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), null);
});

test("health endpoint permits the configured app origin", async () => {
  const response = await worker.fetch(new Request("https://worker.test/health", {
    method: "GET",
    headers: { Origin: allowedOrigin }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
  assert.equal((await response.json()).ok, true);
});

test("health endpoint permits the isolated Firebase Hosting alternate origin", async () => {
  const alternateOrigin = "https://anas-erp-staging-a25e1.firebaseapp.com";
  const response = await worker.fetch(new Request("https://worker.test/health", {
    method: "GET", headers: { Origin: alternateOrigin }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), alternateOrigin);
});
