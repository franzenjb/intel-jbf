import { checkPasscode, makeCookie } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { code } = req.body || {};
  if (!checkPasscode(code)) {
    return res.status(401).json({ error: "Invalid access code" });
  }
  res.setHeader("Set-Cookie", makeCookie());
  return res.status(200).json({ ok: true });
}
