import { isAuthed } from "./_auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qoskpyfgimjcmmxunfji.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CACHE = new Map();
const TTL_MS = 10 * 60 * 1000;

const FIELDS = [
  "county_fips", "county_name", "state_abbr", "population",
  "pct_struggling", "poverty_pct", "pct_alice",
  "risk_score", "expected_annual_loss",
  "hurricane_risk", "wildfire_risk", "flood_risk", "coastal_flood_risk",
  "tornado_risk", "earthquake_risk", "heat_wave_risk", "winter_storm_risk",
  "drought_risk", "strong_wind_risk",
  "chapter", "chapter_code", "region", "region_code", "division", "division_code"
].join(", ");

function buildWhere(scope) {
  const esc = (s) => String(s).replace(/'/g, "''");
  if (!scope || !scope.type) return null;
  const t = scope.type.toLowerCase();
  if (t === "national") return "1=1";
  if (t === "county") {
    if (scope.code) return `county_fips = '${esc(scope.code)}'`;
    if (scope.name) return `county_name = '${esc(scope.name)}'`;
    return null;
  }
  if (!scope.name) return null;
  const col = t === "division" ? "division_code" : t === "region" ? "region_code" : "chapter_code";
  const colName = t === "division" ? "division" : t === "region" ? "region" : "chapter";
  if (scope.code) return `${col} = '${esc(scope.code)}'`;
  return `${colName} = '${esc(scope.name)}'`;
}

async function sql(query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_read_sql`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql_query: query.trim() }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "SUPABASE_ANON_KEY not configured" });

  const type = req.query.type || req.query["scope[type]"];
  const name = req.query.name || req.query["scope[name]"];
  const code = req.query.code || req.query["scope[code]"];

  const scope = { type, name, code };
  const where = buildWhere(scope);
  if (!where) return res.status(400).json({ error: "Missing scope (type + name or code)" });
  const isNational = (type || "").toLowerCase() === "national";

  const key = `${type}|${code || name}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json({ ...hit.data, cached: true });
  }

  try {
    // National: ~3200 counties. Largest division ~700. LIMIT keeps it bounded.
    const limit = isNational ? 3500 : 2000;
    const query = `SELECT ${FIELDS} FROM county_rankings WHERE ${where} ORDER BY risk_score DESC NULLS LAST LIMIT ${limit}`;
    const rows = await sql(query);

    // Also compute national percentiles for key metrics (so the UI can benchmark)
    const [percentiles] = await sql(`
      SELECT
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY pct_struggling) AS p50_struggling,
        percentile_cont(0.8)  WITHIN GROUP (ORDER BY pct_struggling) AS p80_struggling,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY risk_score)     AS p50_risk,
        percentile_cont(0.8)  WITHIN GROUP (ORDER BY risk_score)     AS p80_risk,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY expected_annual_loss) AS p50_eal,
        percentile_cont(0.8)  WITHIN GROUP (ORDER BY expected_annual_loss) AS p80_eal
      FROM county_rankings
      WHERE pct_struggling IS NOT NULL
    `);

    const data = {
      scope,
      count: rows.length,
      rows,
      national: percentiles,
    };
    CACHE.set(key, { data, at: Date.now() });
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
