// Shared data-capture for scope briefings.
// Pulls all the numbers the briefing prompt needs, in one shot, without any LLM.
// Used by both the offline generator and the live-fallback on /api/briefing.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qoskpyfgimjcmmxunfji.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FLARE_URL =
  "https://services1.arcgis.com/4yjifSiIG17X0gW4/arcgis/rest/services/flare_fire_incidents/FeatureServer/0/query";

const HAZARD_KEYS = [
  "hurricane_risk", "wildfire_risk", "flood_risk", "coastal_flood_risk",
  "tornado_risk", "earthquake_risk", "heat_wave_risk", "winter_storm_risk",
  "drought_risk", "strong_wind_risk",
];

const HAZARD_LABEL = {
  hurricane_risk: "hurricane",
  wildfire_risk: "wildfire",
  flood_risk: "riverine flooding",
  coastal_flood_risk: "coastal flooding",
  tornado_risk: "tornado",
  earthquake_risk: "earthquake",
  heat_wave_risk: "heat wave",
  winter_storm_risk: "winter storm",
  drought_risk: "drought",
  strong_wind_risk: "strong wind",
};

function esc(s) { return String(s).replace(/'/g, "''"); }

function filterFor(scope) {
  const t = (scope.type || "").toLowerCase();
  if (scope.code) {
    const col = t === "division" ? "division_code" : t === "region" ? "region_code" : "chapter_code";
    return `${col} = '${esc(scope.code)}'`;
  }
  const col = t === "division" ? "division" : t === "region" ? "region" : "chapter";
  return `${col} = '${esc(scope.name)}'`;
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

async function countyFipsForScope(scope) {
  const where = filterFor(scope);
  const rows = await sql(`SELECT county_fips FROM county_rankings WHERE ${where} AND county_fips IS NOT NULL`);
  return rows.map(r => String(r.county_fips).padStart(5, "0"));
}

async function fireGapsCY2024(fipsList) {
  if (!fipsList.length) return null;
  // FLARE FIPS may be stored as integer or string; try string IN first.
  const chunks = [];
  const size = 250; // keep URL sane
  for (let i = 0; i < fipsList.length; i += size) chunks.push(fipsList.slice(i, i + size));
  let total = 0;
  for (const chunk of chunks) {
    const inList = chunk.map(f => `'${f}'`).join(",");
    const where = `Master_Label = 'Fire without RC Notification' AND CY = 2024 AND county_fips IN (${inList})`;
    const params = new URLSearchParams({
      where,
      returnCountOnly: "true",
      f: "json",
    });
    const r = await fetch(`${FLARE_URL}?${params}`, { method: "GET" });
    if (!r.ok) { return null; }
    const j = await r.json();
    if (typeof j.count !== "number") return null;
    total += j.count;
  }
  return total;
}

export async function captureDataSnapshot(scope) {
  if (!SUPABASE_ANON_KEY) throw new Error("SUPABASE_ANON_KEY not configured");
  const where = filterFor(scope);

  const hazardCols = HAZARD_KEYS.map(k => `AVG(NULLIF(${k}, 0)) AS ${k}`).join(", ");

  const [agg] = await sql(`
    SELECT
      COUNT(*) AS counties,
      SUM(population) AS population,
      AVG(pct_struggling) AS avg_pct_struggling,
      AVG(risk_score) AS avg_risk,
      SUM(expected_annual_loss) AS total_eal,
      ${hazardCols}
    FROM county_rankings
    WHERE ${where}
  `);

  // Top hazard by avg risk across scope
  let topHazard = null;
  for (const k of HAZARD_KEYS) {
    const v = Number(agg[k]);
    if (!Number.isFinite(v)) continue;
    if (!topHazard || v > topHazard.avg) topHazard = { key: k, label: HAZARD_LABEL[k], avg: Math.round(v) };
  }

  const topRiskRows = await sql(`
    SELECT county_fips, county_name, state_abbr, risk_score, pct_struggling, population
    FROM county_rankings
    WHERE ${where} AND risk_score IS NOT NULL
    ORDER BY risk_score DESC NULLS LAST
    LIMIT 3
  `);

  const topStrugglingRows = await sql(`
    SELECT county_fips, county_name, state_abbr, pct_struggling, population
    FROM county_rankings
    WHERE ${where} AND pct_struggling IS NOT NULL
    ORDER BY pct_struggling DESC NULLS LAST
    LIMIT 3
  `);

  // For concentration: which county leads on the top hazard, and how concentrated is that hazard?
  let hazardLeaderRows = [];
  if (topHazard) {
    hazardLeaderRows = await sql(`
      SELECT county_fips, county_name, state_abbr, ${topHazard.key} AS hazard_score
      FROM county_rankings
      WHERE ${where} AND ${topHazard.key} IS NOT NULL
      ORDER BY ${topHazard.key} DESC NULLS LAST
      LIMIT 3
    `);
  }

  // Fire gaps from FLARE AGOL
  let fireGaps = null;
  try {
    const fips = topRiskRows.map(r => String(r.county_fips).padStart(5, "0"));
    const allFips = await countyFipsForScope(scope);
    fireGaps = await fireGapsCY2024(allFips);
  } catch (e) {
    fireGaps = null;
  }

  // National benchmarks
  const [nat] = await sql(`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY pct_struggling) AS p50_struggling,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY risk_score)     AS p50_risk
    FROM county_rankings
    WHERE pct_struggling IS NOT NULL
  `);

  return {
    scope: { type: scope.type, name: scope.name, code: scope.code || null },
    counties: Number(agg.counties) || 0,
    population: Number(agg.population) || 0,
    avg_pct_struggling: round1(agg.avg_pct_struggling),
    avg_risk: round1(agg.avg_risk),
    total_expected_annual_loss: Number(agg.total_eal) || 0,
    hazard_averages: Object.fromEntries(
      HAZARD_KEYS.map(k => [k, round1(agg[k])]).filter(([, v]) => v != null)
    ),
    top_hazard: topHazard,
    top_hazard_leaders: hazardLeaderRows.map(r => ({
      name: r.county_name, state: r.state_abbr, fips: r.county_fips, score: round1(r.hazard_score),
    })),
    top_risk: topRiskRows.map(r => ({
      name: r.county_name, state: r.state_abbr, fips: r.county_fips,
      risk: round1(r.risk_score), pct_struggling: round1(r.pct_struggling), population: r.population,
    })),
    top_struggling: topStrugglingRows.map(r => ({
      name: r.county_name, state: r.state_abbr, fips: r.county_fips,
      pct: round1(r.pct_struggling), population: r.population,
    })),
    fire_gaps_cy2024: fireGaps,
    national: {
      p50_struggling: round1(nat?.p50_struggling),
      p50_risk: round1(nat?.p50_risk),
    },
    captured_at: new Date().toISOString(),
  };
}

function round1(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}
