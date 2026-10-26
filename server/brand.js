// =============================================================================
// AI brand extraction: crawl a website (sitemap + links + common paths) → pull
// colors / fonts / copy → have Claude Haiku 4.5 (over OpenRouter) infer a
// structured brand identity + voices.
// =============================================================================
import { load } from 'cheerio'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import { chatComplete, parseJsonBlock, HAIKU } from './openrouter.js'

const UA = 'Mozilla/5.0 (compatible; ContentEngineBot/1.0)'
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES) || 20
const COMMON_PATHS = [
  '/about', '/about-us', '/services', '/work', '/case-studies', '/portfolio',
  '/pricing', '/blog', '/contact', '/team', '/products', '/features',
  '/how-it-works', '/company', '/story', '/manifesto',
]

async function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } })
  } finally {
    clearTimeout(t)
  }
}

const pathKey = (u) => {
  try { return new URL(u).pathname.replace(/\/+$/, '') || '/' } catch { return u }
}

// example.com and www.example.com are the same site: sites redirect freely
// between the two, and a crawl started on one must follow links to the other.
const siteOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase() } catch { return '' }
}

// Fetch + parse one HTML page → { url, finalUrl, title, text, css, links[], cssUrls[] } or null.
async function fetchPage(url, origin) {
  let html
  let finalUrl = url
  try {
    const r = await fetchWithTimeout(url)
    if (!r.ok || !(r.headers.get('content-type') || '').includes('text/html')) return null
    finalUrl = r.url || url // after redirects
    html = await r.text()
  } catch {
    return null
  }
  const $ = load(html)
  $('script, noscript').remove()
  const inlineCss = $('style').map((_, el) => $(el).text()).get().join('\n')
  const styleAttrs = $('[style]').map((_, el) => $(el).attr('style')).get().join(';')
  $('style').remove()
  const title = $('title').first().text().trim()
  // meta tags carry real signal even on JS-only SPAs (where body text is sparse)
  const meta = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:title"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content'),
  ].filter(Boolean)
  const body = $('body').text().replace(/\s+/g, ' ').trim()
  const text = [...meta, body].join(' · ').replace(/\s+/g, ' ').trim()

  const links = []
  $('a[href]').each((_, el) => {
    try {
      const abs = new URL($(el).attr('href'), finalUrl)
      if (siteOf(abs.href) === siteOf(origin) && /^https?:$/.test(abs.protocol)) links.push(abs.href)
    } catch {}
  })
  const cssUrls = []
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) { try { cssUrls.push(new URL(href, finalUrl).href) } catch {} }
  })
  return { url, finalUrl, title, text, css: `${inlineCss}\n${styleAttrs}`, links, cssUrls }
}

// Light, single-page read of a site's homepage → title + meta + visible text,
// truncated. Used to ground other features (e.g. the trends stream) in what the
// client ACTUALLY does, straight from their own website — without the cost of a
// full multi-page crawl. Returns '' on any failure (best-effort).
export async function fetchSiteSummary(url, maxChars = 1200) {
  try {
    const domain = String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '')
    if (!domain) return ''
    const startUrl = `https://${domain}`
    const page = await fetchPage(startUrl, new URL(startUrl).origin)
    const text = `${page?.title ? page.title + ' · ' : ''}${page?.text || ''}`.trim()
    return text ? text.slice(0, maxChars) : ''
  } catch {
    return ''
  }
}

// Child sitemaps that list company pages come before blog / archive ones.
const sitemapRank = (loc) =>
  /page/i.test(loc) ? 0 : /(post|blog|news|article|faq|author|category|tag)/i.test(loc) ? 2 : 1

// Pull every URL listed in sitemap.xml / sitemap_index.xml (one level of nesting).
async function discoverFromSitemap(origin) {
  const out = new Set()
  const nested = []
  const grab = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
  for (const sm of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
    try {
      const r = await fetchWithTimeout(sm)
      if (!r.ok) continue
      for (const loc of grab(await r.text())) {
        if (/\.xml(\?|$)/i.test(loc)) nested.push(loc)
        else out.add(loc)
      }
    } catch {}
  }
  // An index lists its children in no useful order (WordPress puts the blog's
  // post-sitemap first), so read page sitemaps first and cap each child, or a
  // big blog fills the URL budget before the company pages are ever seen.
  const children = [...new Set(nested)].sort((a, b) => sitemapRank(a) - sitemapRank(b)).slice(0, 10)
  const lists = await Promise.all(children.map(async (loc) => {
    try {
      const r = await fetchWithTimeout(loc)
      return r.ok ? grab(await r.text()).slice(0, 100) : []
    } catch { return [] }
  }))
  lists.flat().forEach((u) => out.add(u))
  return [...out]
}

// How much a page says about the BRAND rather than one article's topic; lower
// is better. About/company pages first, then what they sell, then other
// shallow pages. Blog posts, FAQs and archive listings go last.
const ABOUT_PAGE = /\b(about|company|team|leadership|story|mission|values|why)\b/i
const COMPANY_PAGE = /\b(services?|solutions?|pricing|plans?|work|case-stud\w*|portfolio|products?|features?|how-it-works|clients|partners?)\b/i
const ARTICLE_PAGE = /\/(blog|news|articles?|posts?|insights|faqs?|guides?|author|category|tag|topics?)(\/|$)|\/page\/\d+|\/\d{4}\/\d{2}\//i
const ARTICLE_PAGES = 4 // a few posts still help the voice samples
const ARTICLE_RANK = 4
function pageRank(u) {
  const path = pathKey(u)
  const shallow = path.split('/').filter(Boolean).length <= 1
  if (ARTICLE_PAGE.test(path)) return ARTICLE_RANK
  if (ABOUT_PAGE.test(path)) return 0
  if (COMPANY_PAGE.test(path)) return shallow ? 1 : 2
  return shallow ? 2 : 3
}

const isAsset = (pathname) =>
  /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|mp4|mov|css|js|xml|json|txt|woff2?)(\?|$)/i.test(pathname)

async function crawlSite(startUrl, maxPages = MAX_PAGES) {
  // 1) homepage (gives links + content; may be a sparse SPA shell)
  const home = await fetchPage(startUrl, new URL(startUrl).origin)
  // Crawl from wherever the homepage actually lives: a bare domain usually
  // redirects to www (or the reverse), and the sitemap only answers there.
  const startOrigin = new URL(home?.finalUrl || startUrl).origin

  // 2) sitemap. Sites sometimes host their real content on a sister domain
  //    (e.g. a .ca SPA whose sitemap points at the .com), so we TRUST whatever
  //    sites the sitemap declares - not just the start one.
  const sitemap = await discoverFromSitemap(startOrigin)
  const allowed = new Set([siteOf(startOrigin)])
  for (const u of sitemap) allowed.add(siteOf(u))

  const seen = new Set()
  const key = (u) => `${siteOf(u)}${pathKey(u)}`
  if (home) seen.add(key(home.finalUrl))

  // homepage links first (the site's own pick of its key pages), then the
  // sitemap (complete), then common-path guesses. pageRank reorders below;
  // this order only breaks ties.
  const candidates = []
  const pool = [...(home?.links || []), ...sitemap, ...COMMON_PATHS.map((p) => startOrigin + p)]
  for (const u of pool) {
    let abs
    try { abs = new URL(u, startUrl) } catch { continue }
    if (!allowed.has(siteOf(abs.href)) || isAsset(abs.pathname)) continue
    const k = key(abs.href)
    if (seen.has(k)) continue
    seen.add(k)
    candidates.push(abs.href)
  }

  // 3) fetch candidates concurrently in small batches until we hit maxPages.
  //    Brand pages first; a few articles are slotted in before the overscan
  //    tail so they are actually reached.
  const pages = home ? [home] : []
  const cssUrls = new Set(home?.cssUrls || [])
  const ranked = candidates.map((u, i) => ({ u, i, r: pageRank(u) })).sort((a, b) => a.r - b.r || a.i - b.i)
  const company = ranked.filter((c) => c.r < ARTICLE_RANK).map((c) => c.u)
  const articles = ranked.filter((c) => c.r === ARTICLE_RANK).slice(0, ARTICLE_PAGES).map((c) => c.u)
  const want = Math.max(1, maxPages - pages.length)
  const head = Math.max(0, want - articles.length)
  const toFetch = [...company.slice(0, head), ...articles, ...company.slice(head)].slice(0, want * 2) // overscan; some 404
  const batch = 6
  // guessed paths like /about and /about-us often redirect to the same page
  const landed = new Set(home ? [key(home.finalUrl)] : [])
  for (let i = 0; i < toFetch.length && pages.length < maxPages; i += batch) {
    const results = await Promise.all(toFetch.slice(i, i + batch).map((u) => fetchPage(u, new URL(u).origin)))
    for (const p of results) {
      if (p && pages.length < maxPages && !landed.has(key(p.finalUrl))) {
        landed.add(key(p.finalUrl))
        pages.push(p)
        p.cssUrls.forEach((c) => cssUrls.add(c))
      }
    }
  }
  if (!pages.length) throw new Error('Could not read that website')
  return { pages, cssUrls: [...cssUrls].slice(0, 8) }
}

const normalizeHex = (h) => {
  const s = h.toLowerCase()
  return /^#[0-9a-f]{3}$/.test(s) ? '#' + s.slice(1).split('').map((c) => c + c).join('') : s
}
const toHex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
const rgbToHex = (r, g, b) => `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`
const hslToHex = (h, s, l) => {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return rgbToHex(255 * f(0), 255 * f(8), 255 * f(4))
}

// WordPress puts its default editor palette (vivid cyan blue, luminous orange,
// ...), its gradient presets and its block-button greys into every page's CSS.
// Those are the CMS's colours, not the brand's, so drop them before counting.
// A block theme's own palette uses its own slugs and is kept.
const WP_CORE_PALETTE = 'black|cyan-bluish-gray|white|pale-pink|vivid-red|luminous-vivid-orange|luminous-vivid-amber|light-green-cyan|vivid-green-cyan|pale-cyan-blue|vivid-cyan-blue|vivid-purple'
const WP_CORE_COLOR_VAR = new RegExp(`--wp--preset--color--(?:${WP_CORE_PALETTE})\\s*:[^;}]*;?`, 'gi')
function stripCmsDefaults(css) {
  return String(css || '')
    .replace(WP_CORE_COLOR_VAR, '')
    .replace(/--wp--preset--gradient--[\w-]+\s*:[^;}]*;?/gi, '')
    .replace(/--wp-(?!-)[\w-]+\s*:[^;}]*;?/gi, '') // editor internals, e.g. --wp-block-synced-color
    .replace(/[^{}]*(?:\.has-[\w-]+-gradient-background|\.wp-(?:block|element))[^{}]*\{[^{}]*\}/gi, '')
}

// Pull brand colors from CSS in ANY common format (hex, rgb/rgba, hsl/hsla),
// normalize to hex, and rank by frequency.
function extractColors(css) {
  const counts = {}
  const add = (hex) => { counts[hex] = (counts[hex] || 0) + 1 }
  ;(css.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || []).forEach((h) => add(normalizeHex(h)))
  ;[...css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)/gi)].forEach((m) => {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return // skip fully transparent
    add(rgbToHex(+m[1], +m[2], +m[3]))
  })
  ;[...css.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)/gi)].forEach((m) => {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return
    add(hslToHex(+m[1], +m[2], +m[3]))
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([hex, count]) => ({ hex, count }))
}

function extractFonts(css) {
  const generic = /^(sans-serif|serif|monospace|system-ui|ui-monospace|ui-serif|ui-sans-serif|inherit|initial|unset|-apple-system|blinkmacsystemfont|arial|helvetica|times|courier|georgia|verdana|tahoma|segoe ui)$/i
  const counts = {}
  // Themes often write `font-family: var(--body-fonts)`; resolve those custom
  // properties to the real family names instead of counting "var(--body-fonts)".
  const vars = {}
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) vars[m[1]] ??= m[2]
  const resolve = (v, depth = 0) => depth > 3 ? v
    : v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => (vars[name] ? resolve(vars[name], depth + 1) : fallback || ''))
  ;(css.match(/font-family\s*:\s*([^;}{]+)/gi) || []).forEach((decl) => {
    resolve(decl.slice(decl.indexOf(':') + 1)).split(',').forEach((name) => {
      const n = name.replace(/["']/g, '').replace(/!important/i, '').trim()
      if (n && !generic.test(n) && !/^var\(/i.test(n) && n.length < 40) counts[n] = (counts[n] || 0) + 1
    })
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => f)
}

const SYS =
  'You are a senior brand strategist. From a website\'s content plus detected colors and fonts, infer a structured brand identity AND the brand voices. Be faithful to the evidence; if something is not determinable, use an empty string or empty array. Return ONLY a JSON object.'

function userPrompt({ domain, corpus, colors, fonts }) {
  return `Website: ${domain}

DETECTED COLORS (hex by frequency - this is GROUND TRUTH; use these exact hex values, never invent colors):
${JSON.stringify(colors)}

DETECTED FONT FAMILIES (by frequency):
${JSON.stringify(fonts)}

PAGE CONTENT (multiple crawled pages, truncated):
${corpus}

Capture WHAT THE BRAND DOES in positioning.statement and mission.
Also propose 3-5 content_pillars: named themes the brand can repeatedly create content around
(name + one-sentence description), inferred from what they actually talk about — not generic
marketing buckets.
For "voices": derive a Brand voice (pov "brand_we") and, if a founder or named person is
evident, a Founder voice (pov "first_person"). For each voice give 3-5 tone_attributes, a few
dos and donts, and 1-3 short sample_posts WRITTEN IN THAT VOICE using the brand's real themes
and wording. If no founder is evident, return only the brand voice.
COLORS: map the DETECTED COLORS into the palette - do NOT invent hex values and do NOT return
just one or two. Put the 2-4 dominant brand colors in "primary" (each with a role like
ink/paper/accent and a rough weight % if discernible). Put EVERY other meaningful colour
(surfaces, backgrounds, borders/hairlines, muted text, secondary accents) in "supporting" -
typically 4-8 of them. Only drop near-duplicates and obvious one-off utility shades.
List each distinct font family with its role (headings, body, labels…).
WORDMARK: derive usage guidance from the brand name, logo and typography. Set "rules" to 1-2
sentences on how the name / wordmark should be set (case, weight, style, lockup, clearspace) and
give 2-4 "donts" (e.g. don't stretch, recolor, outline, add effects, or tilt it). Infer this from
the evidence - only leave them "" / [] if there is genuinely nothing to go on.

Return JSON with EXACTLY this shape (keep arrays short and meaningful):
{
  "brand_tone": "1-2 sentences on how they sound",
  "mission": "what the brand does / its purpose",
  "keywords": ["themes to lean into"],
  "avoid_words": ["themes/words to avoid, inferred from tone"],
  "content_pillars": [
    { "name": "short pillar name", "description": "1 sentence on the stories/angles this pillar covers" }
  ],
  "positioning": { "tagline": "", "statement": "one paragraph on what they do" },
  "voices": [
    { "kind": "brand",   "name": "", "pov": "brand_we",     "tone_attributes": [], "dos": [], "donts": [], "sample_posts": [] },
    { "kind": "founder", "name": "", "pov": "first_person", "tone_attributes": [], "dos": [], "donts": [], "sample_posts": [] }
  ],
  "colors": {
    "primary": [ { "name": "", "hex": "#000000", "role": "ink|paper|accent|primary|secondary", "weight": "" } ],
    "supporting": [ { "name": "", "hex": "#000000" } ],
    "rule": ""
  },
  "typography": { "fonts": [ { "family": "", "role": "" } ] },
  "wordmark": { "rules": "", "donts": [] }
}`
}

async function extractStructuredBrand(input) {
  const { text } = await chatComplete({
    model: HAIKU(),
    temperature: 0.2, // low: this is extraction, not creative writing
    maxTokens: 4000,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: userPrompt(input) },
    ],
  })
  const data = parseJsonBlock(text)
  if (!data || !Object.keys(data).length) throw new Error('The model returned no usable brand data')
  return data
}

export async function extractBrandFromSite(url) {
  const domain = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  const { pages, cssUrls } = await crawlSite(`https://${domain}`)
  if (!pages.length) throw new Error('Could not read that website')

  // fetch external stylesheets in parallel (sequential was a latency trap)
  const cssTexts = await Promise.all(
    cssUrls.map(async (u) => {
      try { const r = await fetchWithTimeout(u, 5000); return r.ok ? await r.text() : '' } catch { return '' }
    }),
  )
  const css = [pages.map((p) => p.css).join('\n'), ...cssTexts].join('\n')

  const colors = extractColors(stripCmsDefaults(css))
  const fonts = extractFonts(css)
  const corpus = pages.map((p) => `## ${p.title} (${p.url})\n${p.text.slice(0, 2200)}`).join('\n\n').slice(0, 16000)

  const data = await extractStructuredBrand({ domain, corpus, colors, fonts })
  return { data, meta: { domain, pages: pages.map((p) => p.url), colors, fonts } }
}

// Parse an uploaded brand-guide PDF → text → Haiku 4.5 → structured brand
// identity. (Brand guides spell out hex codes + font names in the text, so the
// LLM reads them directly; no CSS to scrape.)
export async function extractBrandFromPdf(buffer, label = 'uploaded PDF') {
  let parsed
  try {
    parsed = await pdfParse(buffer)
  } catch {
    throw new Error('Could not read that PDF')
  }
  const text = (parsed.text || '').replace(/\s+/g, ' ').trim()
  if (text.length < 30) throw new Error('That PDF has no extractable text (it may be scanned images)')
  const colors = extractColors(text)
  const corpus = text.slice(0, 16000)
  const data = await extractStructuredBrand({ domain: label, corpus, colors, fonts: [] })
  return { data, meta: { source: 'pdf', label, chars: text.length, colors } }
}
