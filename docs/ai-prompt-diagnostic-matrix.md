# ANAS ERP AI Prompt DOM Diagnostic Matrix

Status: INVESTIGATION IN PROGRESS — do not merge or deploy.

Target branch: `debug/ai-prompt-dom-tracing`
Draft PR: #228

## Evidence rules

- Static CI results are not proof of mobile runtime behavior.
- Record only diagnostic event names, booleans, and error classes/messages needed to identify the DOM lifecycle. Never capture business records, prompt contents, authentication material, API keys, or tokens.
- The harness uses a fresh disposable browser context with no user profile or saved user data. It records storage operation labels only (never keys or values) and IndexedDB operation labels only; external requests and service workers are blocked.
- For opt-in isolated preview, open `index.html?anasDiagIsolated=1` on a fresh local origin. This mode skips Firebase Auth initialization, blocks cross-origin `fetch`, and skips service-worker registration. Use only a fresh disposable browser profile/origin; never open this mode against a host that shares production storage.
- The visible on-screen trace panel is gated by `?anasDiagIsolated=1`; it reports render entry/completion, whether `anasAiQuestion` exists/is connected, prompt insertion length, and focus state. It must never display prompt text, business records, storage keys/values, credentials, or request bodies.
- CSP blocks external resource origins in isolated mode, and the test harness independently blocks external browser requests. A CSP meta policy is not a substitute for verifying the browser storage overrides; field testing must be on a fresh disposable origin/profile.
- Do not run the production GitHub Pages deploy workflow.
- Keep PR #228 in Draft until isolated browser evidence and live phone evidence have both been reviewed.

## Root-cause matching table

| ID | Required observed evidence | Interpretation | Status |
|---|---|---|---|
| D0 | No `renderAiHub entered` event after opening AI Center | AI Center navigation/entry path did not call the renderer, or diagnostic instrumentation did not load | Isolated browser: not indicated; phone: pending |
| D1 | `renderAiHub entered`, but no `renderAiHub completed` | Renderer exited early or threw before completion; inspect the first JavaScript exception | Isolated browser: not indicated; phone: pending |
| D2 | Renderer completed; click event recorded; `anasAiQuestion` lookup is null | Input is not present when the action runs, likely because the relevant view/tab has not rendered or uses a different DOM id | Not indicated in isolated browser; phone: pending |
| D3 | Input exists but `isConnected === false` | The action holds/queries a detached element or a later render replaced the DOM subtree | Not indicated in isolated browser; phone: pending |
| D4 | Input is connected, but assignment/verification fails | Prompt assignment or element behavior is the failure point; inspect value setter and immediate value | Not indicated in isolated browser; phone: pending |
| D5 | Prompt inserted and focus attempted, but focus is not retained | Focus may be blocked by timing, hidden view, or mobile browser behavior; distinguish focus failure from prompt insertion | Not indicated in isolated browser; phone: pending |
| D6 | Prompt inserted and input connected; no expected follow-up UI behavior | The helper succeeded; trace the next action separately (submit/event binding/AI request path) | Prompt insertion/focus succeeded in isolated browser; phone follow-up pending |
| D7 | Isolated browser succeeds but live phone fails | Investigate mobile-specific timing, cache/service worker, viewport, or navigation lifecycle; do not assume the same root cause | Cannot classify until phone evidence exists |

## Evidence log

| Run | Environment / commit | Events captured | Result | Decision |
|---|---|---|---|---|
| Static CI | `343a89c7f736e1502e3858e132c08976134ed61c` | HTML regression, safety, Firebase snapshot worker | All three passed; static checks only | Continue to runtime evidence |
| Isolated browser (baseline) | GitHub Actions run #621, run ID `40609350995`, artifact `ai-prompt-dom-trace`; code at `86aa70a6257edf9847df21865071f779e5edca9b` | `renderAiHub` traces; input found and connected; helper called; prompt inserted; focus true | PASS in ephemeral Chromium; external requests blocked | Baseline works in isolated browser; phone behavior still unknown |
| Isolated browser (storage-write-blocked experiment) | GitHub Actions run #625, run ID `40609699422`, artifact ID `12782034277`, code at `97e95a6113a78c66a0d17780791569203d0d1444` | Three `localStorage.setItem` attempts were blocked; one `SecurityError`; prompt inserted and focused | Jobs passed, but the deliberately restrictive storage override changed startup behavior | Retained as a harness experiment only; not representative startup evidence |
| Isolated browser (disposable storage telemetry) | HTML Regression run #629, run ID `40610206799`, artifact ID `12781334332`, head `cd8873cd16cb9827ea1c138f7a1b527d358f921a` | Document complete; AI hub and input found/connected; helper called; prompt inserted; focus true; no `page_error` event | PASS in fresh ephemeral context; no keys, values, prompt text, business data, or secrets captured | Isolated Chromium path works; Android root cause remains unconfirmed |
| Isolated browser (opt-in guards and visible overlay) | HTML Regression run #639, run ID `40612441128`, head `a71df33588b6c9a32eb1f30f1767747969d68774`, artifact ID `12782679670` | `diagnosticMode=true`; Firebase not initialized; no service-worker controller; mock storage round-trip true; IndexedDB blocked; AI hub/input found and connected; prompt inserted; focus true; external script requests blocked | `static-regression` SUCCESS and `isolated-browser-trace` SUCCESS; artifact JSON inspected directly. Artifact records no business data or secrets. | Confirms tested interaction path in isolated Chromium only. External scripts were blocked as intended. Android remains pending; no root cause/fix authorized |
| Live Android phone | Not run | — | Pending | Do not close or merge |

Artifact: [GitHub Actions run #639](https://github.com/amin545677-svg/anas-erb-/actions/runs/40612441128)

## Acceptance gates

1. Isolated browser execution records the render lifecycle, element presence/connection, and fixed prompt assignment without accessing business storage or sending external requests.
2. The actual diagnostic branch is tested in a non-production preview on the phone.
3. Captured evidence maps to one row above, with the relevant events and any JavaScript exception.
4. A fix is proposed only after the observed evidence identifies the failing stage.
5. PR remains Draft and production remains untouched until review explicitly authorizes the next step.

## Local phone procedure

1. Serve this diagnostic branch from a fresh local origin using a disposable browser profile and synthetic/empty app data only.
2. Confirm the on-screen trace panel says it is in diagnostic mode; confirm Firebase Auth is not initialized, external requests are blocked, and the app service worker is not registered.
3. Open AI Center, then tap **📦 مراجعة المخزون**. Record only the visible event labels and booleans; do not enter real business data.
4. Match the sequence to D0–D7. Do not infer a phone result from CI or desktop Chromium.
5. A local server running in a separate computer/container is not automatically reachable from the phone; the phone and server must be on the same trusted network and the server must bind to an appropriate LAN interface. No live handset session or LAN server is currently available in this environment, so phone evidence must come from an actual device run.
