import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  N8N_BASE_URL,                                        // e.g. https://diwp645.app.n8n.cloud  (no trailing slash)
  N8N_API_KEY,                                          // n8n Settings > API > create an API key
  N8N_FORM_WEBHOOK_ID = "696576aa-5fbe-4b76-849d-fd81f5f0cb2a", // "Sourcing Request Form" node's webhookId
  N8N_WORKFLOW_ID = "jo9Q690CzrUwUZPv",
  PORT = 3000
} = process.env;

if (!N8N_BASE_URL || !N8N_API_KEY) {
  console.warn("[sourcing-desk] Missing N8N_BASE_URL or N8N_API_KEY env vars — set these on Render.");
}

function n8nHeaders() {
  return { "X-N8N-API-KEY": N8N_API_KEY, accept: "application/json" };
}

/**
 * Trigger the workflow by posting to its production Form Trigger webhook
 * (this is the same URL the public form page itself submits to — no n8n
 * auth needed here), then correlate the run with an execution record via
 * the n8n REST API so we have an id to poll.
 *
 * NOTE: the workflow must be ACTIVE in n8n for the production webhook to
 * respond. If it's still toggled off, activate it first.
 */
app.post("/api/submit", async (req, res) => {
  try {
    const fields = req.body || {};
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== "") {
        form.append(key, String(value));
      }
    }

    const webhookUrl = `${N8N_BASE_URL}/form/${N8N_FORM_WEBHOOK_ID}`;
    const submitRes = await fetch(webhookUrl, { method: "POST", body: form });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      return res.status(502).json({
        error: `Webhook submit failed (${submitRes.status}). Is the workflow active? ${text.slice(0, 300)}`
      });
    }

    // Give n8n a moment to create the execution record, then look it up.
    // The form webhook itself doesn't return an execution id, so we find
    // the newest execution for this workflow right after triggering it.
    let executionId = null;
    for (let attempt = 0; attempt < 6 && !executionId; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      const listUrl = `${N8N_BASE_URL}/api/v1/executions?workflowId=${N8N_WORKFLOW_ID}&limit=5`;
      const listRes = await fetch(listUrl, { headers: n8nHeaders() });
      if (listRes.ok) {
        const data = await listRes.json();
        const executions = data.data || [];
        if (executions.length) {
          executions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
          executionId = executions[0].id;
        }
      }
    }

    if (!executionId) {
      return res.status(202).json({
        warning:
          "Workflow triggered, but the execution couldn't be confirmed yet. Check the Candidates sheet or RecruitCRM directly."
      });
    }
    res.json({ executionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status/:id", async (req, res) => {
  try {
    const url = `${N8N_BASE_URL}/api/v1/executions/${req.params.id}?includeData=false`;
    const r = await fetch(url, { headers: n8nHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: `Status check failed (${r.status})` });
    const data = await r.json();
    res.json({ status: data.status, finished: data.finished });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/results/:id", async (req, res) => {
  try {
    const url = `${N8N_BASE_URL}/api/v1/executions/${req.params.id}?includeData=true`;
    const r = await fetch(url, { headers: n8nHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: `Results fetch failed (${r.status})` });
    const data = await r.json();

    const runData = (data && data.data && data.data.resultData && data.data.resultData.runData) || {};

    function nodeItems(nodeName) {
      const runs = runData[nodeName] || [];
      const items = [];
      for (const run of runs) {
        const mainOut = (run && run.data && run.data.main && run.data.main[0]) || [];
        for (const it of mainOut) if (it && it.json) items.push(it.json);
      }
      return items;
    }

    const candidates = nodeItems("Extract Enriched Email");
    const summaryItems = nodeItems("Build CRM Upload Summary");
    const summary = summaryItems[0] || null;

    res.json({ candidates, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Sourcing desk proxy listening on port ${PORT}`));
