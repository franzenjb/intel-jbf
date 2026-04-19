#!/usr/bin/env node
// Pre-generates the 2-sentence executive briefing for every division/region/chapter.
// Writes data/scope-briefings.json for the app to serve cached.
//
// Usage:
//   source /tmp/.anthropic-env && source /tmp/.intel-env && \
//   node scripts/generate-briefings.mjs [--only=division] [--limit=N] [--resume]
//
// Env required:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL, SUPABASE_ANON_KEY

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureDataSnapshot } from "../api/_snapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "data", "scope-briefings.json");

const PROMPT_VERSION = "v1-2026-04-19";
const MODEL = "claude-sonnet-4-5-20250929";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true])
);
const ONLY = args.only || null;            // division | region | chapter
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const RESUME = Boolean(args.resume);

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
if (!process.env.SUPABASE_ANON_KEY) { console.error("SUPABASE_ANON_KEY not set"); process.exit(1); }

function buildSynthesisPrompt(snap) {
  const s = snap;
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

function shortUsd(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

async function synthesize(snap) {
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
  const usage = data?.usage || {};
  return { text, usage };
}

async function loadScopes() {
  // Query Supabase directly for distinct scopes, same as /api/scopes.
  const SUPABASE_URL = process.env.SUPABASE_URL || "https://qoskpyfgimjcmmxunfji.supabase.co";
  const KEY = process.env.SUPABASE_ANON_KEY;
  const sql = async (q) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_read_sql`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql_query: q.trim() }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const divisions = await sql(`
    SELECT DISTINCT division AS name, division_code AS code
    FROM county_rankings
    WHERE division IS NOT NULL AND division <> 'Not Assigned'
    ORDER BY division
  `);
  const regions = await sql(`
    SELECT DISTINCT region AS name, region_code AS code, division
    FROM county_rankings
    WHERE region IS NOT NULL AND region <> 'Not Assigned'
    ORDER BY region
  `);
  const chapters = await sql(`
    SELECT DISTINCT chapter AS name, chapter_code AS code, region, division
    FROM county_rankings
    WHERE chapter IS NOT NULL AND chapter <> 'Not Assigned'
    ORDER BY chapter
  `);
  return { divisions, regions, chapters };
}

function costUsd(usage) {
  // Sonnet 4.5 pricing: $3/M in, $15/M out
  const inCost = (usage.input_tokens || 0) / 1e6 * 3;
  const outCost = (usage.output_tokens || 0) / 1e6 * 15;
  return Number((inCost + outCost).toFixed(5));
}

// ── main ─────────────────────────────────────────────────────────────────────

function log(...args) { console.log(new Date().toISOString().slice(11, 19), "|", ...args); }

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });

  let cache = { prompt_version: PROMPT_VERSION, model: MODEL, entries: {} };
  if (RESUME && existsSync(OUT)) {
    try {
      cache = JSON.parse(readFileSync(OUT, "utf8"));
      log(`Resuming with ${Object.keys(cache.entries || {}).length} existing entries`);
    } catch {}
  }
  cache.entries = cache.entries || {};
  cache.prompt_version = PROMPT_VERSION;
  cache.model = MODEL;

  log("Loading scopes...");
  const { divisions, regions, chapters } = await loadScopes();
  log(`Scopes: ${divisions.length} divisions, ${regions.length} regions, ${chapters.length} chapters`);

  const targets = [];
  if (!ONLY || ONLY === "division") targets.push(...divisions.map(d => ({ type: "division", ...d })));
  if (!ONLY || ONLY === "region") targets.push(...regions.map(r => ({ type: "region", ...r })));
  if (!ONLY || ONLY === "chapter") targets.push(...chapters.map(c => ({ type: "chapter", ...c })));

  const queue = targets.slice(0, LIMIT).filter(t => {
    const key = `${t.type}:${t.code || t.name}`;
    if (RESUME && cache.entries[key]?.prompt_version === PROMPT_VERSION) return false;
    return true;
  });

  log(`Generating ${queue.length} briefings (of ${targets.length} total)...`);

  let totalCost = 0;
  let done = 0;
  for (const scope of queue) {
    const key = `${scope.type}:${scope.code || scope.name}`;
    try {
      const snap = await captureDataSnapshot(scope);
      const { text, usage } = await synthesize(snap);
      const cost = costUsd(usage);
      totalCost += cost;
      cache.entries[key] = {
        scope: { type: scope.type, name: scope.name, code: scope.code || null },
        data_snapshot: snap,
        briefing: text,
        prompt_version: PROMPT_VERSION,
        model: MODEL,
        generated_at: new Date().toISOString(),
        cost_usd: cost,
        usage,
      };
      done++;
      log(`[${done}/${queue.length}] ${key.padEnd(40)} $${cost.toFixed(4)} — ${text.slice(0, 80).replace(/\n/g, " ")}...`);
      // Flush every 5 entries so progress isn't lost on crash
      if (done % 5 === 0) {
        cache.generated_at = new Date().toISOString();
        writeFileSync(OUT, JSON.stringify(cache, null, 2));
      }
    } catch (e) {
      log(`[ERR ] ${key}: ${e.message}`);
    }
  }

  cache.generated_at = new Date().toISOString();
  cache.total_cost_usd = Object.values(cache.entries).reduce((s, e) => s + (e.cost_usd || 0), 0);
  writeFileSync(OUT, JSON.stringify(cache, null, 2));
  log(`\nDone. Wrote ${Object.keys(cache.entries).length} entries to ${OUT}`);
  log(`This run: ${done} generations, $${totalCost.toFixed(4)}`);
  log(`Cumulative cost across cache: $${cache.total_cost_usd.toFixed(4)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
