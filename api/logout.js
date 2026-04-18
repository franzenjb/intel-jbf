import { clearCookie } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Set-Cookie", clearCookie());
  return res.status(200).json({ ok: true });
}
