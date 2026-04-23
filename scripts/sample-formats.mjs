#!/usr/bin/env node
// Generates sample briefings in 3 formats for each scope level + county narrative samples.
// Usage: source /tmp/.anthropic-env && source /tmp/.intel-env && node scripts/sample-formats.mjs

import { captureDataSnapshot } from "../api/_snapshot.js";

const MODEL_BRIEF = "claude-sonnet-4-5-20250929";
const MODEL_NARR = "claude-haiku-4-5-20251001";
const LIGHTRAG_URL = process.env.LIGHTRAG_URL || "https://explorer.jbf.com/api/lightrag";

function shortUsd(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function fmtNum(v) { return v == null ? "—" : Math.round(v).toLocaleString(); }

function buildFacts(s) {
  const leaders = (s.top_hazard_leaders || []).map(h => `${h.name}, ${h.state} (${h.score})`).join("; ");
  const struggling = (s.top_struggling || []).map(h => `${h.name}, ${h.state} (${h.pct}%)`).join("; ");
  const topRisk = (s.top_risk || []).slice(0, 3).map(r => `${r.name}, ${r.state} (risk ${r.risk})`).join("; ");
  const fireGapLine = s.fire_gaps_cy2024 != null
    ? `${s.fire_gaps_cy2024} structure fires in CY2024 with no Red Cross notification`
    : "fire-response coverage data unavailable";
  const p50Risk = s.national?.p50_risk;
  const p50Strug = s.national?.p50_struggling;
  const riskDelta = p50Risk != null ? `${s.avg_risk > p50Risk ? "+" : ""}${Math.round(s.avg_risk - p50Risk)} vs US median` : "";
  const strugDelta = p50Strug != null ? `${s.avg_pct_struggling > p50Strug ? "+" : ""}${(s.avg_pct_struggling - p50Strug).toFixed(1)}pp vs US median` : "";
  const divLines = (s.division_summaries || []).map(d =>
    `  ${d.division}: ${fmtNum(d.population)} pop, avg risk ${Math.round(d.avg_risk || 0)}, ${Math.round(d.avg_struggling || 0)}% struggling, $${shortUsd(d.total_eal)} annual loss`
  ).join("\n");

  return `SCOPE: ${s.scope.type.toUpperCase()} — ${s.scope.name}
- Counties: ${s.counties}
- Population: ${fmtNum(s.population)}
- Avg overall risk: ${s.avg_risk}${riskDelta ? ` (${riskDelta})` : ""}
- Avg % struggling (ALICE+poverty): ${s.avg_pct_struggling}%${strugDelta ? ` (${strugDelta})` : ""}
- Struggling people: ~${fmtNum(Math.round(s.population * s.avg_pct_struggling / 100))}
- Total expected annual loss: $${shortUsd(s.total_expected_annual_loss)}
- Top hazard: ${s.top_hazard?.label || "n/a"} (avg ${s.top_hazard?.avg || "n/a"}/100)
- Worst-hit on top hazard: ${leaders || "n/a"}
- Highest risk counties: ${topRisk || "n/a"}
- Most fragile counties: ${struggling || "n/a"}
- Fire-response gap: ${fireGapLine}
${divLines ? `\nDIVISION BREAKDOWN:\n${divLines}` : ""}`;
}

const PROMPTS = {
  A: (facts, scopeType, scopeName) => `You are briefing a Red Cross executive for ${scopeName} (${scopeType} level). Write EXACTLY 2 punchy sentences. First sentence names the single biggest risk exposure. Second sentence adds a concentration or economic angle with one specific county. No preamble, no markdown, no headers.\n\n${facts}`,

  B: (facts, scopeType, scopeName) => `You are briefing a Red Cross executive for ${scopeName} (${scopeType} level). Write 3-4 sentences covering: (1) the dominant hazard threat, (2) the most at-risk county and why, (3) economic fragility (ALICE/poverty), and (4) one actionable takeaway. Be specific with numbers. No preamble, no markdown, no headers. Plain prose.\n\n${facts}`,

  C: (facts, scopeType, scopeName) => `You are briefing a Red Cross executive for ${scopeName} (${scopeType} level). Write a structured briefing in this exact format:

LEAD: One sentence naming the #1 threat and most exposed county.
RISK: One sentence on overall risk posture vs national median.
FRAGILITY: One sentence on economic vulnerability (ALICE + poverty numbers).
ACTION: One sentence on the single most important preparedness priority.

Use plain text, no markdown. Be specific with numbers and county names.\n\n${facts}`,
};

const NARR_PROMPTS = {
  A: (name, state, rag) => `Write a 100-150 word narrative about ${name}, ${state}. Cover geography, economy, demographics, and any notable disaster history or community features. Write plain prose — no bullet points, no headers, no markdown. Be specific and factual.\n\nCONTEXT:\n${(rag || "No additional context.").slice(0, 3000)}`,

  B: (name, state, rag) => `Write a 60-80 word overview of ${name}, ${state} for a Red Cross disaster preparedness dashboard. Focus on: location, population character, primary economic drivers, and the single most important hazard exposure. One tight paragraph. No bullet points, no markdown.\n\nCONTEXT:\n${(rag || "No additional context.").slice(0, 3000)}`,

  C: (name, state, rag) => `Write about ${name}, ${state} in exactly 3 short paragraphs (total 120-160 words):

Paragraph 1: Geography and location — where it is, terrain, key features.
Paragraph 2: Economy and people — population character, industries, ALICE/poverty if known.
Paragraph 3: Disaster profile — historical events, primary hazard exposures, community resilience factors.

Plain prose, no headers, no markdown, no bullet points.\n\nCONTEXT:\n${(rag || "No additional context.").slice(0, 3000)}`,
};

async function callClaude(model, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data?.content?.[0]?.text?.trim() || "(empty)";
}

async function queryLightRAG(question) {
  try {
    const r = await fetch(LIGHTRAG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: question, mode: "local" }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.response || j.answer || null;
  } catch { return null; }
}

const SAMPLES = [
  { type: "national", name: "United States", code: null },
  { type: "state", name: "Florida", code: "FL" },
  { type: "division", name: "Southeast & Caribbean Division", code: "SE" },
  { type: "region", name: "Florida Region", code: null },
  { type: "chapter", name: "Central Florida Region Chapter", code: null },
];
const COUNTY_SAMPLE = { name: "Pinellas", state: "FL" };

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
  if (!process.env.SUPABASE_ANON_KEY) { console.error("SUPABASE_ANON_KEY not set"); process.exit(1); }

  console.log("=" .repeat(80));
  console.log("BRIEFING SAMPLES — 3 formats × 5 scope levels");
  console.log("=".repeat(80));

  for (const scope of SAMPLES) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`SCOPE: ${scope.type.toUpperCase()} — ${scope.name}`);
    console.log("─".repeat(80));

    let snap;
    try {
      snap = await captureDataSnapshot(scope);
    } catch (e) {
      console.error(`  Failed to capture snapshot: ${e.message}`);
      continue;
    }
    const facts = buildFacts(snap);

    for (const [ver, promptFn] of Object.entries(PROMPTS)) {
      const prompt = promptFn(facts, scope.type, scope.name);
      const text = await callClaude(MODEL_BRIEF, prompt);
      console.log(`\n  FORMAT ${ver}:`);
      console.log(`  ${text.replace(/\n/g, "\n  ")}`);
    }
  }

  // County narrative samples
  console.log(`\n${"=".repeat(80)}`);
  console.log(`COUNTY NARRATIVE SAMPLES — ${COUNTY_SAMPLE.name} County, ${COUNTY_SAMPLE.state}`);
  console.log("=".repeat(80));

  console.log("\n  Querying LightRAG for context...");
  const rag = await queryLightRAG(`Tell me about ${COUNTY_SAMPLE.name} County, ${COUNTY_SAMPLE.state} — geography, economy, demographics, disaster history`);
  console.log(`  LightRAG returned ${rag ? rag.length : 0} chars`);

  for (const [ver, promptFn] of Object.entries(NARR_PROMPTS)) {
    const prompt = promptFn(COUNTY_SAMPLE.name, COUNTY_SAMPLE.state, rag);
    const text = await callClaude(MODEL_NARR, prompt);
    console.log(`\n  FORMAT ${ver}:`);
    console.log(`  ${text.replace(/\n/g, "\n  ")}`);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("Done. Pick your preferred format for briefings (A/B/C) and narratives (A/B/C).");
}

main().catch(e => { console.error(e); process.exit(1); });
