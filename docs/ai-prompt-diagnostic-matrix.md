# ANAS ERP AI Prompt DOM Diagnostic Matrix

Status: INVESTIGATION IN PROGRESS — do not merge or deploy.

Target branch: `debug/ai-prompt-dom-tracing`
Draft PR: #228

## Evidence rules

- Static CI results are not proof of mobile runtime behavior.
- Record only diagnostic event names, booleans, and error classes/messages needed to identify the DOM lifecycle. Never capture business records, prompt contents, authentication material, API keys, or tokens.
- The harness uses a fresh disposable browser context with no user profile or saved user data. It allows normal app startup writes only inside that temporary context and records API labels only (never keys or values); external requests and service workers are blocked.
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
| Isolated browser (storage-write-blocked experiment) | GitHub Actions run #625, run ID `40609699422`, artifact ID `12782034277`, code at `97e95a6113a78c66a0d17780791569203d0d1444` | Three `localStorage.setItem` attempts were blocked; one `SecurityError`; prompt inserted and focused | Jobs passed, but the deliberately restrictive storage override changed startup behavior. | Retained as a harness experiment only; not representative startup evidence |
| Isolated browser (disposable storage telemetry) | HTML Regression run #629, run ID `40610206799`, artifact ID `12781334332`, head `cd8873cd16cb9827ea1c138f7a1b527d358f921a` | Document complete; exactly 3 `storage.setItem` API labels; AI hub and input found/connected; helper called; prompt inserted; focus true; no `page_error` event recorded | Static regression and isolated browser-trace jobs passed. Artifact JSON inspected directly; external scripts blocked, service workers blocked, fresh ephemeral context; no keys, values, prompt text, business data, or secrets captured. | Latest isolated run confirms this path works in Chromium; Android root cause remains unconfirmed |
| Live Android phone | Not run | — | Pending | Do not close or merge |

Artifact: [GitHub Actions run #621](https://github.com/amin545677-svg/anas-erb-/actions/runs/40609350995)

## Acceptance gates

1. Isolated browser execution records the render lifecycle, element presence/connection, and fixed prompt assignment without accessing business storage or sending external requests.
2. The actual diagnostic branch is tested in a non-production preview on the phone.
3. Captured evidence maps to one row above, with the relevant events and any JavaScript exception.
4. A fix is proposed only after the observed evidence identifies the failing stage.
5. PR remains Draft and production remains untouched until review explicitly authorizes the next step.
