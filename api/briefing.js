import { isAuthed } from "./_auth.js";

const UPSTREAM = process.env.SMART_QUERY_URL || "https://explorer.jbf.com/api/smart-query";

function buildPrompt(scope) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const t = (scope.type || "").toLowerCase();
  const filter = t === "division"
    ? `division_code = '${esc(scope.code || "")}'`
    : t === "region"
    ? `region_code = '${esc(scope.code || "")}'`
    : `chapter_code = '${esc(scope.code || "")}'`;

  return `You are briefing a new executive director of the **${scope.name}** (${t}) on their current exposure.

Use supabase_sql on county_rankings filtered by \`${filter}\` to gather:
- number of counties + total population
- top hazard by avg hazard_risk score across these counties
- top 2 counties by pct_struggling
- any single clearly-concentrated risk (e.g. "hurricane exposure is in 5 gulf coast counties")

Then use agol_query on flare_fire_incidents to check fire-response gaps (Master_Label = 'No RC Notification') in CY2024.

Write EXACTLY 2 sentences. Punchy. Lead with the single most urgent thing. Include one specific county name. No preamble, no markdown, no headers. Just 2 sentences.`;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { scope } = req.body || {};
  if (!scope || !scope.name || !scope.type) {
    return res.status(400).json({ error: "Missing scope {type, name, code}" });
  }

  try {
    const r = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: buildPrompt(scope) }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: `Upstream: ${e.message}` });
  }
}
