import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const helperStart = html.indexOf("function anasNormalizeAiGatewayUrl(raw){");
assert.notEqual(helperStart, -1, "AI gateway URL normalizer must exist");
const helperEnd = html.indexOf("\n        function anasSaveAiGateway(){", helperStart);
assert.notEqual(helperEnd, -1, "AI gateway URL normalizer must have a stable boundary");
const helperSource = html.slice(helperStart, helperEnd) + "\nthis.normalize = anasNormalizeAiGatewayUrl;";
const sandbox = { URL };
vm.runInNewContext(helperSource, sandbox);

test("accepts only the official ANAS ERP AI Worker origin", () => {
  assert.equal(sandbox.normalize("https://anas-erp-openai-ai.amin545677.workers.dev"),
    "https://anas-erp-openai-ai.amin545677.workers.dev");
  assert.equal(sandbox.normalize("https://ANAS-ERP-OPENAI-AI.amin545677.workers.dev/"),
    "https://anas-erp-openai-ai.amin545677.workers.dev");
});

test("rejects arbitrary workers.dev hosts and the Firebase snapshot Worker", () => {
  assert.throws(() => sandbox.normalize("https://attacker.workers.dev"));
  assert.throws(() => sandbox.normalize("https://anas-erp-firebase-snapshot.amin545677.workers.dev"));
});

test("rejects insecure, path-bearing, and credential-bearing gateway URLs", () => {
  assert.throws(() => sandbox.normalize("http://anas-erp-openai-ai.amin545677.workers.dev"));
  assert.throws(() => sandbox.normalize("https://anas-erp-openai-ai.amin545677.workers.dev/chat"));
  assert.throws(() => sandbox.normalize("https://user:pass@anas-erp-openai-ai.amin545677.workers.dev"));
  assert.throws(() => sandbox.normalize("https://anas-erp-openai-ai.amin545677.workers.dev/?x=1"));
});

test("floating assistant routes through the same strict URL normalizer", () => {
  const marker = "const payload={type:'chat',message:q+";
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, "floating assistant request payload must exist");
  const region = html.slice(Math.max(0, at - 1200), at);
  assert.match(region, /anasNormalizeAiGatewayUrl\(savedUrl\)/);
  assert.doesNotMatch(region, /savedUrl\.trim\(\)\.replace/);
});
