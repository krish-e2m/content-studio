// =========================================================================
// Shared link normalization. Single source of truth for the "make every stored
// link a canonical https:// URL" rule, imported by index.js and the extractor
// router so they can never drift apart. The client mirrors this exact rule in
// client/src/lib/util.js for instant on-blur feedback; this is the server-side
// authoritative pass that runs on every write regardless of what the UI did.
// =========================================================================

// Normalize a user-entered website/link to a canonical "https://…" URL:
//   "yourwebsite.com"    -> "https://yourwebsite.com"   (bare domain gets a scheme)
//   "//yourwebsite.com"  -> "https://yourwebsite.com"   (protocol-relative)
//   "http://x.com"       -> "http://x.com"        (existing scheme kept as typed)
//   "https://x.com"      -> "https://x.com"
//   "mailto:a@b.com"     -> "mailto:a@b.com"
//   ""  / null           -> ""
// It only ever *prepends* a scheme - it never rewrites or rejects what the user
// typed, so it is safe to run on every save.
export function normalizeUrl(input) {
  const s = String(input ?? '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^mailto:/i.test(s)) return s
  return `https://${s.replace(/^\/+/, '')}`
}
