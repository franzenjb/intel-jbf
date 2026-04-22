// Serves pre-generated county narratives from data/county-narratives.json
// with a live LightRAG + Haiku fallback for counties not yet cached.

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { isAuthed } from "./_auth.js";

const CACHE_PATH = resolve(process.cwd(), "data", "county-narratives.json");
const LIGHTRAG_URL = process.env.LIGHTRAG_URL || "https://explorer.jbf.com/api/lightrag";
const MODEL = "claude-haiku-4-5-20251001";

let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try {
    if (!existsSync(CACHE_PATH)) return null;
    _cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return _cache;
  } catch (e) {
    console.error("narrative: cache load failed", e);
    return null;
  }
}

async function liveSynthesize(countyName, stateAbbr) {
  // 1. Get context from LightRAG
  let ragContext = null;
  try {
    const r = await fetch(LIGHTRAG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `Tell me about ${countyName}, ${stateAbbr} — geography, economy, demographics, disaster history`,
        mode: "local",
      }),
    });
    if (r.ok) {
      const j = await r.json();
      ragContext = j.response || j.answer || null;
    }
  } catch { }

  // 2. Synthesize with Haiku (fast + cheap)
  if (!process.env.ANTHROPIC_API_KEY) {
    return ragContext ? ragContext.slice(0, 800) : null;
  }
  const prompt = `Write a 100-150 word narrative about ${countyName}, ${stateAbbr}. Cover geography, economy, demographics, and any notable disaster history or community features. Write plain prose — no bullet points, no headers, no markdown. Be specific and factual.\n\nCONTEXT:\n${(ragContext || "No additional context.").slice(0, 3000)}`;

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
  if (!r.ok) return ragContext ? ragContext.slice(0, 800) : null;
  const data = await r.json();
  return data?.content?.[0]?.text?.trim() || null;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });

  const fips = (req.query.fips || "").padStart(5, "0");
  const countyName = req.query.name || "";
  const stateAbbr = req.query.state || "";

  if (!fips || fips === "00000") {
    return res.status(400).json({ error: "Missing fips parameter" });
  }

  // 1. Check pre-generated cache
  const cache = loadCache();
  const hit = cache?.entries?.[fips];
  if (hit && hit.narrative) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).json({ source: "cache", narrative: hit.narrative, fips });
  }

  // 2. Live fallback
  if (!countyName) {
    return res.status(404).json({ error: "Not in cache and no county name provided for live synthesis" });
  }

  try {
    const narrative = await liveSynthesize(countyName, stateAbbr);
    if (narrative && narrative.length > 20) {
      return res.status(200).json({ source: "live", narrative, fips });
    }
    return res.status(404).json({ error: "Could not generate narrative" });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
