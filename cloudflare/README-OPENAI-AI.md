# ANAS ERP — OpenAI AI Gateway

This Worker adds OpenAI-powered responses to the existing Anas AI chat without replacing the Firebase snapshot/backup Worker.

## Compatibility
- The existing UI stores the gateway URL under `anasErpAiGatewayUrlV1`.
- The chat sends `POST` JSON fields such as `message`, `businessData`, and `language`.
- The Excel header-analysis flow may send `prompt` or `text`.
- This Worker accepts those fields and returns `{ "ok": true, "text": "..." }`, matching the UI's existing response handling.
- It supports `GET /health` for a safe configuration check.
- It does not write to inventory, invoices, cash, customers, or other business records.

## Deploy as a separate Worker
Do not overwrite `anas-erp-firebase-snapshot` or any existing Gemini Worker. Deploy this Worker under its own name.

1. In Cloudflare, create a new Worker named `anas-erp-openai-ai`.
2. Paste the contents of `worker_openai_ai.js`, or deploy from this folder using Wrangler and `wrangler-openai.toml`.
3. In Worker Settings → Variables and Secrets, add **Secret** `OPENAI_API_KEY`. Never place this key in HTML, GitHub source, localStorage, or chat.
4. Set `ALLOWED_ORIGINS` to the exact origin(s) of the deployed ANAS ERP site, comma-separated. The default is `https://amin545677-svg.github.io`; change it if the app is hosted elsewhere.
5. Keep `OPENAI_MODEL` set to a model available to the OpenAI Platform project; the default is `gpt-4.1-mini`.
6. Deploy and open `https://YOUR-WORKER.workers.dev/health`. It should report `ok: true` and `configured: true`.
7. In ANAS ERP → Settings → AI server, paste the new Worker URL, save it, and press the connection test. Then ask a low-risk test question.

## Privacy and cost
- The browser sends the business summary only when the user presses the AI question button. Review the summary builder in `index.html` before sending real customer data.
- This Worker uses the Responses API with `store: false`, but API processing is still subject to OpenAI's applicable data policies and the account's configuration.
- Keep the API key private, restrict access to the Worker origin, and monitor API usage/budget.
- CORS is a browser-origin control, not authentication. If the app is made public, consider adding authenticated requests and rate limiting before broad use.
- This is an initial integration scaffold. Validate it in a test environment before relying on it for business decisions.
