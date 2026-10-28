# ANAS ERP AI Prompt DOM Diagnostic Matrix

Status: INVESTIGATION IN PROGRESS — do not merge or deploy.

Target branch: `debug/ai-prompt-dom-tracing`
Draft PR: #228
Current diagnostic head before this document: `343a89c7f736e1502e3858e132c08976134ed61c`

## Evidence rules

- Static CI results are not proof of mobile runtime behavior.
- Record only diagnostic event names, booleans, and error classes/messages needed to identify the DOM lifecycle. Never capture business records, prompt contents beyond the fixed test prompt, authentication material, API keys, or tokens.
- No writes to localStorage, IndexedDB, AppData, or business records for diagnosis.
- Do not run the production GitHub Pages deploy workflow.
- Keep PR #228 in Draft until isolated browser evidence and live phone evidence have both been reviewed.

## Root-cause matching table

| ID | Required observed evidence | Interpretation | Status |
|---|---|---|---|
| D0 | No `renderAiHub entered` event after opening AI Center | AI Center navigation/entry path did not call the renderer, or diagnostic instrumentation did not load | Not observed yet |
| D1 | `renderAiHub entered`, but no `renderAiHub completed` | Renderer exited early or threw before completion; inspect the first JavaScript exception | Not observed yet |
| D2 | Renderer completed; click event recorded; `anasAiQuestion` lookup is null | Input is not present when the action runs, likely because the relevant view/tab has not rendered or uses a different DOM id | Not observed yet |
| D3 | Input exists but `isConnected === false` | The action holds/queries a detached element or a later render replaced the DOM subtree | Not observed yet |
| D4 | Input is connected, but assignment/verification fails | Prompt assignment or element behavior is the failure point; inspect value setter and immediate value | Not observed yet |
| D5 | Prompt inserted and focus attempted, but focus is not retained | Focus may be blocked by timing, hidden view, or mobile browser behavior; distinguish focus failure from prompt insertion | Not observed yet |
| D6 | Prompt inserted and input connected; no expected follow-up UI behavior | The helper succeeded; trace the next action separately (submit/event binding/AI request path) | Not observed yet |
| D7 | Isolated browser succeeds but live phone fails | Investigate mobile-specific timing, cache/service worker, viewport, or navigation lifecycle; do not assume the same root cause | Not observed yet |

## Evidence log

| Run | Environment / commit | Events captured | Result | Decision |
|---|---|---|---|---|
| CI static checks | `343a89c7f736e1502e3858e132c08976134ed61c` | HTML regression, safety, Firebase snapshot worker | All three checks passed; no DOM runtime evidence | Continue to isolated browser test |
| Isolated browser | Not run | — | Pending | Do not close |
| Live Android phone | Not run | — | Pending | Do not close |

## Acceptance gates

1. Isolated browser execution records the render lifecycle, element presence/connection, and fixed prompt assignment without accessing business storage or sending network requests.
2. The actual diagnostic branch is tested in a non-production preview on the phone.
3. Captured evidence maps to one row above, with the relevant events and any JavaScript exception.
4. A fix is proposed only after the observed evidence identifies the failing stage.
5. PR remains Draft and production remains untouched until review explicitly authorizes the next step.
