# Sourcing Desk

A small proxy + static dashboard for the "LinkedIn Sourcing Tool" n8n workflow, so your
team can run searches and watch results without opening the n8n editor.

```
public/index.html   the dashboard your team visits
server.js            tiny Express server — holds the n8n API key, talks to n8n
```

The API key never reaches the browser. The frontend only ever calls your own
`/api/...` routes; `server.js` is the only thing that talks to n8n directly.

## Before you deploy

1. **Activate the workflow.** It's currently switched off in n8n. The production
   form webhook only responds when the workflow is Active — flip the toggle in
   the n8n editor.

2. **Create an n8n API key.** In n8n: Settings → n8n API → Create an API key.
   You'll need this for `N8N_API_KEY` below (requires a plan with API access).

3. **Double-check the form webhook URL.** `server.js` posts to:
   ```
   {N8N_BASE_URL}/form/{N8N_FORM_WEBHOOK_ID}
   ```
   That `/form/<id>` pattern is what n8n's Form Trigger node uses for its
   production URL as of recent versions — but open the "Sourcing Request Form"
   node in your workflow and copy the exact **Production URL** it shows you.
   If it differs from the pattern above, update the `webhookUrl` line in
   `server.js`.

## Environment variables (set these on Render)

| Variable | Value |
|---|---|
| `N8N_BASE_URL` | `https://diwp645.app.n8n.cloud` (no trailing slash) |
| `N8N_API_KEY` | the key from step 2 above |
| `N8N_FORM_WEBHOOK_ID` | `696576aa-5fbe-4b76-849d-fd81f5f0cb2a` (default, already set) |
| `N8N_WORKFLOW_ID` | `jo9Q690CzrUwUZPv` (default, already set) |

## Deploying on Render

1. Push this folder to a git repo, connect it as a new **Web Service** on Render.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add the environment variables above under the service's Environment tab.
5. Deploy. Render gives you a URL — share that with your team; it serves the
   dashboard directly.

## How it works

- **Submit**: the browser posts the form to `/api/submit`. The server forwards
  it to n8n's public form webhook (no auth — that's the same endpoint the
  public form itself uses), then polls n8n's Executions API for a few seconds
  to find the execution that was just created, so it has an ID to track.
- **Status**: the browser polls `/api/status/:id` every 3 seconds; the server
  proxies `GET /api/v1/executions/:id` on your behalf.
- **Results**: once finished, `/api/results/:id` fetches the full execution
  data and pulls out the `Extract Enriched Email` and `Build CRM Upload
  Summary` node outputs, trimmed down to what the dashboard needs.

## One caveat worth testing

I couldn't run this against your live n8n instance, so two things are my best
inference rather than verified fact:

- The exact webhook path (`/form/<id>`) for triggering — see step 3 above.
- The shape of `resultData.runData` returned by the Executions API when a node
  (like `Extract Enriched Email`) runs multiple times inside a loop — the code
  assumes each run's `data.main[0]` holds that batch's items and flattens
  across all runs. If candidate cards come up empty after a real run, click
  "view raw response" on the dashboard, send me that JSON, and I'll adjust the
  parsing in `server.js` to match.
