import { isAuthed } from "./_auth.js";

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthenticated" });
  return res.status(200).json({ ok: true });
}
