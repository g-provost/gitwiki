// Pure anchoring helpers (no DOM / no ProseMirror) — unit-testable in Node.
//
// An inline comment stores its anchor in a hidden marker inside the GitHub issue
// comment body:   <!-- gitwiki:{json} -->
// kind:"anchor" carries { id, quote, prefix, suffix, contentSha, status };
// kind:"reply" just references an anchor id. Anything without a marker is a page comment.
//
// Anchoring is content-independent: we persist the *visible text* quote plus a bit
// of surrounding context, never document positions (those aren't stable across reloads).
export const MARK_RE = /<!--\s*gitwiki:(\{[\s\S]*?\})\s*-->/;

export function parseMarker(body) {
  const m = body.match(MARK_RE);
  if (!m) return { meta: null, text: body };
  let meta = null;
  try { meta = JSON.parse(m[1]); } catch { /* malformed -> treat as plain text */ }
  return { meta, text: body.replace(MARK_RE, "").trim() };
}

export const buildMarker = (meta) => `<!-- gitwiki:${JSON.stringify(meta)} -->`;
export const newId = () => Math.random().toString(36).slice(2, 10);

// Locate an anchor's quote within a plain-text string. Returns {from,to} char
// indices, or null (orphan). When the quote appears more than once, the stored
// prefix/suffix context disambiguates which occurrence is meant.
export function locate(text, meta) {
  if (!meta.quote) return null;
  const occ = [];
  for (let i = text.indexOf(meta.quote); i !== -1; i = text.indexOf(meta.quote, i + 1)) occ.push(i);
  if (!occ.length) return null;
  if (occ.length === 1) return { from: occ[0], to: occ[0] + meta.quote.length };
  let best = occ[0], bestScore = -1;
  for (const o of occ) {
    const pre = text.slice(Math.max(0, o - (meta.prefix || "").length), o);
    const suf = text.slice(o + meta.quote.length, o + meta.quote.length + (meta.suffix || "").length);
    const s = (meta.prefix && pre.endsWith(meta.prefix) ? 1 : 0) + (meta.suffix && suf.startsWith(meta.suffix) ? 1 : 0);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return { from: best, to: best + meta.quote.length };
}
