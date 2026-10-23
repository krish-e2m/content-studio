import { useEffect, useState } from 'react'

/* ---------------- localStorage-backed state ---------------- */
export function usePersisted(key, initial) {
  const [val, setVal] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val))
    } catch {
      /* quota - fine for a prototype */
    }
  }, [key, val])
  return [val, setVal]
}

/* ---------------- date helpers ---------------- */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const addDays = (d, n) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
export const prettyDate = (isoStr) => {
  const [, m, dd] = isoStr.split('-').map(Number)
  return { d: dd, m: MONTHS[m - 1].slice(0, 3) }
}

export const uid = (() => {
  let n = 0
  return (p) => `${p}-${Date.now().toString(36)}-${n++}`
})()

/* ---------------- URL + email validation ---------------- */
// Normalize a website/link input to a canonical "https://…" URL. A bare domain
// like "yourwebsite.com" becomes "https://yourwebsite.com"; a value that already carries a
// scheme (http://, https://, mailto:) is left untouched. Empty stays empty. We
// only ever *prepend* a scheme - we never rewrite or reject what the user typed,
// so this can run on blur without fighting the user. The server applies the same
// rule authoritatively (see normalizeUrl in server/index.js).
export function normalizeUrl(input) {
  const s = String(input ?? '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^mailto:/i.test(s)) return s
  return `https://${s.replace(/^\/+/, '')}`
}

// Loose, format-only email check. Used for a soft inline hint - we never block
// submission on it (there are no required email fields today).
export function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim())
}

export function seedScheduled() {
  const today = new Date()
  return [
    { id: uid('sch'), title: 'Why your AI output sounds generic', platform: 'linkedin', format: 'Single thought', date: iso(addDays(today, 1)), body: '', hashtags: '' },
    { id: uid('sch'), title: 'A week of content in one session', platform: 'instagram', format: 'Carousel', date: iso(addDays(today, 3)), body: '', hashtags: '' },
    { id: uid('sch'), title: 'Better feedback, better decisions', platform: 'substack', format: 'Long-form essay', date: iso(addDays(today, 6)), body: '', hashtags: '' },
  ]
}

export function dotColor(cls) {
  return { 'p-linkedin': '#2f6f9f', 'p-instagram': '#c1558b', 'p-email': '#c98a3a', 'p-substack': '#cf6b4a', 'p-x': '#2b2b2b', 'p-tiktok': '#fe2c55' }[cls] || '#ebb7c2'
}

/* ---------------- dynamic web fonts ---------------- */
// Inject a Google Fonts <link> for each brand font family so previews render in
// the real typeface. Families not on Google Fonts simply fail to load and fall
// back - harmless. Links are de-duped and left in <head> (browser-cached).
export function useGoogleFonts(families) {
  const key = [...new Set((families || []).map((f) => (f || '').trim()).filter(Boolean))].sort().join('|')
  useEffect(() => {
    if (!key) return
    key.split('|').forEach((fam) => {
      const id = `gf-${fam.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      if (document.getElementById(id)) return
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      // bare family (regular) → succeeds for virtually any Google Font; adding
      // unavailable weight/ital axes would 400 the whole request and load nothing.
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}&display=swap`
      document.head.appendChild(link)
    })
  }, [key])
}
