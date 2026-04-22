// Serves pre-generated scope briefings from data/scope-briefings.json with
// a live-synthesis fallback for scopes that aren't in the cache yet.
//
// Cache hit:   ~30ms (disk read)
// Cache miss:  ~5-8s (data snapshot + single Anthropic call, no tool-use loop)
//
// The cache is versioned by prompt_version. When the prompt changes, bump
// PROMPT_VERSION in scripts/generate-briefings.mjs and re-run; old entries
// will be ignored here and will fall through to live synthesis until
// re-generated offline.

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { isAuthed } from "./_auth.js";
import { captureDataSnapshot } from "./_snapshot.js";

// Vercel serverless functions run with cwd = deployment root (/var/task).
// The data file is included via vercel.json `functions.includeFiles`.
const CACHE_PATH = resolve(process.cwd(), "data", "scope-briefings.json");

const MODEL = "claude-sonnet-4-5-20250929";
const PROMPT_VERSION = "v2-2026-04-22";

let _cache = null;
let _cacheLoadedAt = 0;

function loadCache() {
  // Re-read if file mtime changed (cheap: Vercel serves from immutable FS per deploy
  // but in dev / local it's helpful). For simplicity, read once per cold start.
  if (_cache) return _cache;
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, "utf8");
    _cache = JSON.parse(raw);
    _cacheLoadedAt = Date.now();
    return _cache;
  } catch (e) {
    console.error("briefing: cache load failed", e);
    return null;
  }
}

function cacheLookup(scope) {
  const c = loadCache();
  if (!c || !c.entries) return null;
  const key = `${scope.type}:${scope.code || scope.name}`;
  const hit = c.entries[key];
  if (!hit) return null;
  if (hit.prompt_version !== (c.prompt_version || PROMPT_VERSION)) return null;
  return hit;
}

function shortUsd(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function buildNationalPrompt(s) {
  const divLines = (s.division_summaries || []).map(d =>
    `  ${d.division}: ${Number(d.counties)} counties, pop ${Number(d.population).toLocaleString()}, avg risk ${Number(d.avg_risk).toFixed(0)}, ${Number(d.avg_struggling).toFixed(1)}% struggling, $${shortUsd(Number(d.total_eal))} annual loss`
  ).join("\n");
  const fireGapLine = s.fire_gaps_cy2024 != null
    ? `${s.fire_gaps_cy2024} structure fires in CY2024 with no Red Cross notification`
    : "fire-response coverage data unavailable";
  return `You are briefing the American Red Cross CEO and national leadership team. Write EXACTLY 3 punchy sentences about the national risk landscape. Focus on DIVISIONS — which face the greatest exposure, where economic fragility compounds disaster risk, and where the biggest operational dollar exposure sits. Do NOT name individual counties. No preamble. No markdown. No headers. Just 3 sentences that a national executive would act on.

NATIONAL FACTS
- Total counties: ${s.counties}
- Total population: ${s.population.toLocaleString()}
- Avg overall risk: ${s.avg_risk}
- Avg % struggling (ALICE+poverty): ${s.avg_pct_struggling}%
- Total expected annual loss: $${shortUsd(s.total_expected_annual_loss)}
- Top hazard nationally: ${s.top_hazard?.label || "n/a"} (avg ${s.top_hazard?.avg || "n/a"}/100)
- Fire-response gap: ${fireGapLine}

DIVISION BREAKDOWN
${divLines || "  (unavailable)"}

Identify which 2-3 divisions carry the most risk or fragility and why. End with the single most actionable national pattern.`;
}

function buildScopePrompt(s) {
  const leaders = (s.top_hazard_leaders || []).map(h => `${h.name}, ${h.state} (${h.score})`).join("; ");
  const struggling = (s.top_struggling || []).map(h => `${h.name}, ${h.state} (${h.pct}%)`).join("; ");
  const topRisk = (s.top_risk || []).slice(0, 2).map(r => `${r.name}, ${r.state} (risk ${r.risk})`).join("; ");
  const fireGapLine = s.fire_gaps_cy2024 != null
    ? `${s.fire_gaps_cy2024} structure fires in CY2024 with no Red Cross notification`
    : "fire-response coverage data unavailable";
  const p50Risk = s.national?.p50_risk;
  const p50Strug = s.national?.p50_struggling;
  const riskDelta = p50Risk != null ? `${s.avg_risk > p50Risk ? "+" : ""}${Math.round(s.avg_risk - p50Risk)} vs US median` : "";
  const strugDelta = p50Strug != null ? `${s.avg_pct_struggling > p50Strug ? "+" : ""}${(s.avg_pct_struggling - p50Strug).toFixed(1)}pp vs US median` : "";

  return `You are briefing a newly appointed executive director of the **${s.scope.name}** (Red Cross ${s.scope.type}). Below is everything you know about their territory. Write EXACTLY 2 punchy sentences naming the single most urgent exposure and one specific county. No preamble. No markdown. No headers. Just 2 sentences, second sentence can add a concentration or economic angle.

SCOPE FACTS
- Counties: ${s.counties}
- Population: ${s.population.toLocaleString()}
- Avg overall risk: ${s.avg_risk} (${riskDelta})
- Avg % struggling (ALICE+poverty): ${s.avg_pct_struggling}% (${strugDelta})
- Total expected annual loss: $${shortUsd(s.total_expected_annual_loss)}
- Top hazard across scope: ${s.top_hazard?.label || "n/a"} (avg ${s.top_hazard?.avg || "n/a"}/100)
- Worst-hit counties on top hazard: ${leaders || "n/a"}
- Highest overall-risk counties: ${topRisk || "n/a"}
- Most economically fragile counties: ${struggling || "n/a"}
- Fire-response service gap: ${fireGapLine}

Lead with the hazard or fragility angle that's most off-the-charts vs the US median. Name at least one specific county.`;
}

function buildSynthesisPrompt(snap) {
  return snap.scope.type === "national" ? buildNationalPrompt(snap) : buildScopePrompt(snap);
}

async function liveSynthesize(scope) {
  // Gather snapshot + single Anthropic call (no tool-use loop).
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const snap = await captureDataSnapshot(scope);
  const prompt = buildSynthesisPrompt(snap);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 320,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) {
    throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data?.content?.[0]?.text?.trim();
  if (!text) throw new Error("No text in Anthropic response");
  return {
    briefing: text,
    data_snapshot: snap,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    generated_at: new Date().toISOString(),
    usage: data.usage || {},
  };
}

export default async function handler(req, res) {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { scope } = req.body || {};
    if (!scope || !scope.name || !scope.type) {
      return res.status(400).json({ error: "Missing scope {type, name, code}" });
    }

    // 1. Try the pre-generated cache first.
    const hit = cacheLookup(scope);
    if (hit) {
      return res.status(200).json({
        source: "cache",
        briefing: hit.briefing,
        data_snapshot: hit.data_snapshot,
        prompt_version: hit.prompt_version,
        generated_at: hit.generated_at,
        model: hit.model,
      });
    }

    // 2. Fall back to live synthesis.
    try {
      const result = await liveSynthesize(scope);
      return res.status(200).json({ source: "live", ...result });
    } catch (e) {
      console.error("briefing live synth failed:", e?.stack || e);
      return res.status(502).json({ error: `Synthesis failed: ${e.message}` });
    }
  } catch (e) {
    console.error("briefing handler crashed:", e?.stack || e);
    return res.status(500).json({ error: `Internal error: ${e.message}` });
  }
}
