import { isAuthed } from "./_auth.js";

const UPSTREAM = process.env.SMART_QUERY_URL || "https://explorer.jbf.com/api/smart-query";

function scopePrefix(scope) {
  if (!scope || !scope.type || !scope.name) return "";
  const kind = scope.type.toLowerCase();
  const header =
    kind === "division"
      ? `You are advising leadership of the **${scope.name}** (a Red Cross division). All answers must be scoped to counties within this division. When you run supabase_sql, always filter with \`division = '${scope.name.replace(/'/g, "''")}'\` (or \`division_code = '${scope.code || ""}'\`). Cite the division in your framing.`
      : kind === "region"
      ? `You are advising leadership of the **${scope.name}** (a Red Cross region${scope.division ? ` within the ${scope.division}` : ""}). All answers must be scoped to counties within this region. When you run supabase_sql, always filter with \`region = '${scope.name.replace(/'/g, "''")}'\` (or \`region_code = '${scope.code || ""}'\`).`
      : `You are advising leadership of the **${scope.name}** (a Red Cross chapter${scope.region ? ` in the ${scope.region}` : ""}). All answers must be scoped to counties within this chapter. When you run supabase_sql, always filter with \`chapter = '${scope.name.replace(/'/g, "''")}'\` (or \`chapter_code = '${scope.code || ""}'\`).`;
  return `${header}\n\n---\n\n`;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question, scope } = req.body || {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing 'question' string" });
  }

  const scoped = scopePrefix(scope) + question;

  try {
    const r = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: scoped }),
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }
}
