import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../cloudflare/worker_firebase_snapshot.js", import.meta.url), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64");
const { default: worker } = await import(moduleUrl);
const origin = "https://amin545677-svg.github.io";

async function health(env) {
  const response = await worker.fetch(
    new Request("https://snapshot-worker.example/health", { headers: { Origin: origin } }),
    env
  );
  assert.equal(response.status, 200, "health endpoint should return HTTP 200");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  return response.json();
}

const staging = await health({
  FIREBASE_API_KEY: "test-only-not-a-real-key",
  FIREBASE_PROJECT_ID: "anas-erp-staging-a25e1",
  WORKER_SERVICE_NAME: "anas-erp-firebase-snapshot-staging",
  ALLOWED_ORIGINS: origin
});
assert.deepEqual(staging, {
  ok: true,
  service: "anas-erp-firebase-snapshot-staging",
  configured: true
}, "staging health must identify the staging Worker");

const productionFallback = await health({
  FIREBASE_API_KEY: "test-only-not-a-real-key",
  FIREBASE_PROJECT_ID: "anas-erb",
  ALLOWED_ORIGINS: origin
});
assert.equal(productionFallback.service, "anas-erp-firebase-snapshot",
  "production keeps its existing default service identity");
assert.equal(productionFallback.configured, true);

const missingConfig = await health({
  FIREBASE_PROJECT_ID: "anas-erp-staging-a25e1",
  WORKER_SERVICE_NAME: "anas-erp-firebase-snapshot-staging",
  ALLOWED_ORIGINS: origin
});
assert.equal(missingConfig.configured, false,
  "health must not report a missing Firebase API key as configured");

console.log("Firebase Snapshot Worker health identity tests passed (staging, production fallback, missing config).");
