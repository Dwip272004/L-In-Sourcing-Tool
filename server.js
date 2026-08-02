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
  SHEET_ID = "1Jss-cmGXu_8jMzplRZYJgYxPCkOncP0vTbbDwYEci7w", // the Candidates sourcing Google Sheet
  SEARCH_REQUESTS_TAB = "Search Requests",
  CANDIDATES_TAB = "Candidates",
  PORT = 3000
} = process.env;

if (!N8N_BASE_URL || !N8N_API_KEY) {
  console.warn("[sourcing-desk] Missing N8N_BASE_URL or N8N_API_KEY env vars — set these on Render.");
}

function n8nHeaders() {
  return { "X-N8N-API-KEY": N8N_API_KEY, accept: "application/json" };
}

// TEMP DEBUG endpoint: confirms whether the browser's fetch to our own
// server is arriving with complete field data.
app.post("/api/debug-echo", (req, res) => {
  res.json({ receivedBody: req.body });
});

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

    // Hard requirement check before we even talk to n8n — an empty submit
    // here previously slipped through silently and produced a workflow
    // error deep inside the LinkedIn search call instead of a clear message.
    if (!fields.booleanSearchString || !fields.locationRegion) {
      return res.status(400).json({ error: "Boolean search string and location are required." });
    }

    // n8n's Form Trigger does NOT use the field's real name (booleanSearchString,
    // locationRegion, etc.) as the multipart field name — it uses positional
    // keys matching the field's order in the form definition: field-0, field-1,
    // ... This was confirmed by capturing the real form page's own submit
    // request via browser devtools. This ordering must match the "Sourcing
    // Request Form" node's formFields.values array exactly.
    const FIELD_ORDER = [
      "booleanSearchString", // field-0
      "locationRegion",      // field-1
      "roleContext",         // field-2
      "roleKeywords",        // field-3
      "skillsKeywords",      // field-4
      "minYearsExperience",  // field-5
      "seniorityLevel",      // field-6
      "networkDistance",     // field-7
      "spotlights",          // field-8
      "recruitCrmJob"        // field-9
    ];

    const form = new FormData();
    FIELD_ORDER.forEach((key, i) => {
      const value = fields[key];
      form.append(`field-${i}`, value !== undefined && value !== null ? String(value) : "");
    });

    // TEMP DEBUG: log exactly what's being sent to n8n. Check this in your
    // Render service logs after a test submit.
    console.log("[submit] forwarding positional fields to n8n:", Object.fromEntries(form.entries()));

    const webhookUrl = `https://diwp645.app.n8n.cloud/form/696576aa-5fbe-4b76-849d-fd81f5f0cb2a`;
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

    // Sanity check: confirm the fields actually landed in n8n before we
    // spend the next several minutes polling a run that's doomed to fail.
    // Small delay so the "Sourcing Request Form" node has definitely run.
    await new Promise((r) => setTimeout(r, 800));
    try {
      const checkUrl = `${N8N_BASE_URL}/api/v1/executions/${executionId}?includeData=true`;
      const checkRes = await fetch(checkUrl, { headers: n8nHeaders() });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const runData = checkData?.data?.resultData?.runData || {};
        const formRun = runData["Sourcing Request Form"];
        const formJson = formRun?.[0]?.data?.main?.[0]?.[0]?.json;
        if (formJson && !formJson.booleanSearchString) {
          return res.status(502).json({
            error:
              "The workflow started, but n8n received an empty submission (fields came through as null). If you've edited the form fields in n8n since this was written, the FIELD_ORDER array in server.js needs to match the new field order exactly.",
            executionId
          });
        }
      }
    } catch (checkErr) {
      // Non-fatal — if this check itself fails, fall through and let normal
      // polling / error reporting handle it.
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

/**
 * Read a tab from the public Google Sheet via the gviz endpoint. This works
 * without any credentials as long as the sheet is shared as "Anyone with
 * the link can view" — the same mechanism Google uses for embedded charts.
 * If the sheet is later locked down, this will need a service account and
 * the official Sheets API instead.
 */
async function fetchSheetRows(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheet fetch failed for "${sheetName}" (${r.status}). Is it shared as "Anyone with the link"?`);
  const text = await r.text();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Unexpected response reading "${sheetName}" tab.`);
  const data = JSON.parse(text.slice(start, end + 1));
  const cols = data.table.cols.map((c) => c.label || c.id);
  return (data.table.rows || []).map((row) => {
    const obj = {};
    (row.c || []).forEach((cell, i) => {
      obj[cols[i]] = cell ? (cell.f !== undefined && cell.f !== null ? cell.f : cell.v) : null;
    });
    return obj;
  });
}

// Combines the Search Requests + Candidates tabs into a reusable search
// history: each past boolean search string, how many candidates it pooled,
// how many cleared the fit-score bar, and average fit score.
app.get("/api/sheet-overview", async (req, res) => {
  try {
    const [requests, candidates] = await Promise.all([
      fetchSheetRows(SEARCH_REQUESTS_TAB).catch(() => []), // best-effort only, see below
      fetchSheetRows(CANDIDATES_TAB)
    ]);

    // Build history straight from the Candidates tab, grouped by the unique
    // search keyword strings actually used. This is the reliable source —
    // the Search Requests tab was found to silently return nothing (wrong
    // headers/tab name/never written), which made totals populate but the
    // history list stay empty. Candidates data alone is enough to answer
    // "what searches have we run and how many candidates did each pool."
    const bySearch = {};
    for (const c of candidates) {
      const key = c["Search Keywords"] || "(unknown search)";
      if (!bySearch[key]) {
        bySearch[key] = { count: 0, qualified: 0, scoreSum: 0, scoreCount: 0, lastSourced: null, sampleLocation: "" };
      }
      const bucket = bySearch[key];
      bucket.count += 1;
      const score = parseFloat(c["Fit Score"]);
      if (!isNaN(score)) {
        bucket.scoreSum += score;
        bucket.scoreCount += 1;
        if (score > 60) bucket.qualified += 1;
      }
      const sourcedAt = c["Sourced At"];
      if (sourcedAt && (!bucket.lastSourced || sourcedAt > bucket.lastSourced)) bucket.lastSourced = sourcedAt;
    }

    // Best-effort enrichment: if the Search Requests tab does have usable
    // rows, borrow the original target location/role context per search
    // string. If it doesn't, history still works fine without this.
    const requestMeta = new Map();
    for (const r of requests) {
      const key = r["Boolean Search String"];
      if (!key) continue;
      const existing = requestMeta.get(key);
      if (existing && new Date(existing.submittedAt || 0) >= new Date(r["Submitted At"] || 0)) continue;
      requestMeta.set(key, {
        location: r["Location/Region"] || "",
        roleContext: r["Role Context"] || "",
        submittedAt: r["Submitted At"] || null
      });
    }

    const history = Object.entries(bySearch)
      .map(([searchString, stats]) => {
        const meta = requestMeta.get(searchString) || {};
        return {
          searchString,
          location: meta.location || "",
          roleContext: meta.roleContext || "",
          submittedAt: meta.submittedAt || stats.lastSourced,
          candidatesPooled: stats.count,
          qualifiedCount: stats.qualified,
          avgFitScore: stats.scoreCount ? Math.round(stats.scoreSum / stats.scoreCount) : null,
          lastSourcedAt: stats.lastSourced
        };
      })
      .sort((a, b) => new Date(b.lastSourcedAt || 0) - new Date(a.lastSourcedAt || 0));

    const totals = {
      totalSearches: history.length,
      totalCandidatesPooled: candidates.length,
      totalQualified: candidates.filter((c) => parseFloat(c["Fit Score"]) > 60).length
    };

    res.json({ history, totals });
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
