import { isAuthed } from "./_auth.js";

const SMART_QUERY_URL = process.env.SMART_QUERY_URL || "https://explorer.jbf.com/api/smart-query";
const LIGHTRAG_URL = process.env.LIGHTRAG_URL || "https://explorer.jbf.com/api/lightrag";

function scopePrefix(scope) {
  if (!scope || !scope.type || !scope.name) return "";
  const kind = scope.type.toLowerCase();
  if (kind === "national") {
    return `You are advising American Red Cross national leadership. Your answers should address the entire United States. When you run supabase_sql, do NOT filter by division/region/chapter — use the full county_rankings table.\n\n---\n\n`;
  }
  const header =
    kind === "state"
      ? `You are providing analysis for the state of **${scope.name}**. All answers must be scoped to counties within this state. When you run supabase_sql, always filter with \`state_abbr = '${(scope.code || scope.name).replace(/'/g, "''")}'\`.`
      : kind === "division"
      ? `You are advising leadership of the **${scope.name}** (a Red Cross division). All answers must be scoped to counties within this division. When you run supabase_sql, always filter with \`division = '${scope.name.replace(/'/g, "''")}'\` (or \`division_code = '${scope.code || ""}'\`). Cite the division in your framing.`
      : kind === "region"
      ? `You are advising leadership of the **${scope.name}** (a Red Cross region${scope.division ? ` within the ${scope.division}` : ""}). All answers must be scoped to counties within this region. When you run supabase_sql, always filter with \`region = '${scope.name.replace(/'/g, "''")}'\` (or \`region_code = '${scope.code || ""}'\`).`
      : kind === "county"
      ? `You are answering a question about **${scope.name}** (FIPS ${scope.code || ""}). This is a single county. When you run supabase_sql, filter with \`county_fips = '${(scope.code || "").replace(/'/g, "''")}'\`. Give specific data for this one county only.`
      : `You are advising leadership of the **${scope.name}** (a Red Cross chapter${scope.region ? ` in the ${scope.region}` : ""}). All answers must be scoped to counties within this chapter. When you run supabase_sql, always filter with \`chapter = '${scope.name.replace(/'/g, "''")}'\` (or \`chapter_code = '${scope.code || ""}'\`).`;
  return `${header}\n\n---\n\n`;
}

async function querySmartQuery(question) {
  const r = await fetch(SMART_QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!r.ok) throw new Error(`smart-query ${r.status}`);
  const j = await r.json();
  return j.answer || j.response || "";
}

async function queryLightRAG(question) {
  const r = await fetch(LIGHTRAG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question, mode: "hybrid" }),
  });
  if (!r.ok) return null; // non-fatal — degrade gracefully
  const j = await r.json();
  return j.response || j.answer || null;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question, scope } = req.body || {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing 'question' string" });
  }

  const scoped = scopePrefix(scope) + question;
  // For LightRAG, include scope context so it knows what area to search
  const ragQuestion = scope?.name && scope.type !== "national"
    ? `${question} (regarding ${scope.name})`
    : question;

  try {
    // Fan out: smart-query (SQL data) + LightRAG (knowledge graph) in parallel
    const [sqlAnswer, ragContext] = await Promise.all([
      querySmartQuery(scoped),
      queryLightRAG(ragQuestion).catch(() => null),
    ]);

    // Build unified answer with source indicators
    const hasSql = !!sqlAnswer;
    const hasRag = ragContext && ragContext.length > 20;
    let answer = "";
    const sourceTags = [];
    if (hasSql) sourceTags.push("SQL Data");
    if (hasRag) sourceTags.push("Knowledge Graph");
    const sourceHeader = sourceTags.length ? `**Sources:** ${sourceTags.join(" · ")}\n\n` : "";

    if (hasSql && hasRag) {
      // Both sources — present SQL answer first, then KG context clearly separated
      answer = sourceHeader + sqlAnswer + `\n\n---\n\n**Additional Context (Knowledge Graph)**\n\n${ragContext}`;
    } else if (hasSql) {
      answer = sourceHeader + sqlAnswer;
    } else if (hasRag) {
      answer = sourceHeader + ragContext;
    } else {
      answer = "No relevant data found for this question.";
    }

    return res.status(200).json({ answer, sources: { smart_query: hasSql, lightrag: hasRag } });
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }
}
