import { isAuthed } from "./_auth.js";

// OpenFEMA DisasterDeclarationsSummaries — ground-truth presidential declarations.
// Each row is one (disaster × county), so we dedupe by disasterNumber to count events.
// See https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries

const CACHE = new Map();
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const LOOKBACK_YEARS = 10;
const BASE = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });

  const states = String(req.query.states || "")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z]{2}$/.test(s));

  if (!states.length) {
    return res.status(400).json({ error: "states param required, e.g. ?states=AZ,NM" });
  }

  const key = [...states].sort().join(",");
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json({ ...hit.data, cached: true });
  }

  const sinceYear = new Date().getFullYear() - LOOKBACK_YEARS;
  const sinceISO = `${sinceYear}-01-01T00:00:00.000z`;
  const stateFilter = states.map(s => `state eq '${s}'`).join(" or ");
  const filter = `declarationDate ge '${sinceISO}' and (${stateFilter})`;
  const select = "disasterNumber,state,incidentType,declarationDate,declarationTitle,declarationType";
  const url =
    `${BASE}?$filter=${encodeURIComponent(filter)}` +
    `&$select=${encodeURIComponent(select)}` +
    `&$orderby=declarationDate desc` +
    `&$top=10000`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": "intel.jbf.com (Red Cross)" } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      return res.status(502).json({ error: `FEMA ${r.status}`, detail: body });
    }
    const j = await r.json();
    const rows = j.DisasterDeclarationsSummaries || [];

    // One declaration spans many counties → dedupe by (disasterNumber, state)
    // so a multi-state event still counts once per state.
    const seen = new Map();
    for (const d of rows) {
      const k = `${d.disasterNumber}|${d.state}`;
      if (!seen.has(k)) seen.set(k, d);
    }
    const unique = [...seen.values()];

    const counts = new Map();
    for (const d of unique) {
      const t = (d.incidentType || "Other").trim();
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const ranked = [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    const recent = unique.slice(0, 5).map(d => ({
      type: d.incidentType,
      state: d.state,
      date: d.declarationDate,
      title: d.declarationTitle,
      disasterNumber: d.disasterNumber,
    }));

    const data = {
      states,
      sinceYear,
      lookbackYears: LOOKBACK_YEARS,
      totalDeclarations: unique.length,
      ranked,
      recent,
      sourceUrl: "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries",
    };
    CACHE.set(key, { at: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=21600");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
