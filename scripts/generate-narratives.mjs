#!/usr/bin/env node
// Pre-generates 100-150 word county narratives via LightRAG + Claude Haiku.
// Writes data/county-narratives.json for instant serving.
//
// Usage:
//   source /tmp/.anthropic-env && source /tmp/.intel-env && \
//   node scripts/generate-narratives.mjs [--limit=N] [--resume] [--state=TX]
//
// Env required:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL, SUPABASE_ANON_KEY

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "data", "county-narratives.json");

const LIGHTRAG_URL = process.env.LIGHTRAG_URL || "https://explorer.jbf.com/api/lightrag";
const MODEL = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "v2-2026-04-23";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://qoskpyfgimjcmmxunfji.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true])
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const RESUME = Boolean(args.resume);
const STATE_FILTER = args.state || null;
const CONCURRENCY = Number(args.concurrency) || 5;

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
if (!SUPABASE_ANON_KEY) { console.error("SUPABASE_ANON_KEY not set"); process.exit(1); }

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

async function queryLightRAG(question) {
  const r = await fetch(LIGHTRAG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question, mode: "local" }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.response || j.answer || null;
}

async function synthesize(countyName, stateAbbr, ragContext) {
  const prompt = `Write about ${countyName} County, ${stateAbbr} in exactly 3 short paragraphs (total 120-160 words):

Paragraph 1: Geography and location — where it is, terrain, key features.
Paragraph 2: Economy and people — population character, industries, ALICE/poverty if known.
Paragraph 3: Disaster profile — historical events, primary hazard exposures, community resilience factors.

Plain prose, no headers, no markdown, no bullet points.

CONTEXT FROM KNOWLEDGE GRAPH:
${(ragContext || "No additional context available.").slice(0, 3000)}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data?.content?.[0]?.text?.trim() || null;
}

async function generateOne(county, existing) {
  const fips = String(county.county_fips).padStart(5, "0");
  const key = fips;

  if (RESUME && existing.entries[key] && existing.entries[key].prompt_version === PROMPT_VERSION) {
    return { key, skipped: true };
  }

  try {
    // Query LightRAG for county context
    const ragContext = await queryLightRAG(
      `Tell me about ${county.county_name} County, ${county.state_abbr} — geography, economy, demographics, disaster history`
    );

    // Synthesize narrative via Claude Haiku
    const narrative = await synthesize(county.county_name, county.state_abbr, ragContext);

    if (!narrative || narrative.length < 30) {
      console.log(`  SKIP ${county.county_name}, ${county.state_abbr} — empty narrative`);
      return { key, skipped: true };
    }

    return {
      key,
      entry: {
        county_name: county.county_name,
        state_abbr: county.state_abbr,
        fips,
        narrative,
        prompt_version: PROMPT_VERSION,
        generated_at: new Date().toISOString(),
        model: MODEL,
      },
    };
  } catch (e) {
    console.error(`  ERROR ${county.county_name}: ${e.message}`);
    return { key, skipped: true, error: e.message };
  }
}

async function main() {
  console.log("Loading county list…");
  let where = "county_fips IS NOT NULL AND county_name IS NOT NULL";
  if (STATE_FILTER) where += ` AND state_abbr = '${STATE_FILTER}'`;
  const counties = await sql(`
    SELECT DISTINCT county_fips, county_name, state_abbr
    FROM county_rankings
    WHERE ${where}
    ORDER BY state_abbr, county_name
  `);
  console.log(`Found ${counties.length} counties${STATE_FILTER ? ` in ${STATE_FILTER}` : ""}`);

  // Load existing
  let existing = { prompt_version: PROMPT_VERSION, entries: {} };
  if (existsSync(OUT)) {
    try { existing = JSON.parse(readFileSync(OUT, "utf8")); } catch { }
  }

  const todo = counties.slice(0, LIMIT);
  let done = 0, generated = 0, skipped = 0, errors = 0;

  // Process in batches for concurrency
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(c => generateOne(c, existing)));

    for (const r of results) {
      done++;
      if (r.error) { errors++; continue; }
      if (r.skipped) { skipped++; continue; }
      if (r.entry) {
        existing.entries[r.key] = r.entry;
        generated++;
      }
    }

    // Save after each batch
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(existing, null, 2));

    const pct = ((done / todo.length) * 100).toFixed(0);
    console.log(`[${pct}%] ${done}/${todo.length} — ${generated} generated, ${skipped} skipped, ${errors} errors`);
  }

  console.log(`\nDone. ${generated} new narratives. Total in file: ${Object.keys(existing.entries).length}`);
  console.log(`Output: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
