#!/usr/bin/env node
// =============================================================================
// Branding extractor engine (standalone CLI).
//
//   node extract-branding.mjs <url> <outDir>
//
// Drives a headless system Chromium (via puppeteer-core) to a URL, crawls up to
// 5 more key pages, and reverse-engineers the site's visual brand into a
// structured `branding.json` + downloadable assets (logo, favicon, og image,
// screenshots, icons, self-contained component HTML, an extracted.css dump).
//
// Every step logs a `[branding] <message>` line to stdout so the backend can
// stream progress to the client. The script ALWAYS writes a branding.json -
// even on a fatal error - so a partial run still yields something usable.
// =============================================================================
import puppeteer from 'puppeteer-core'
import { promises as fs, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const [, , URL_ARG, OUT_DIR_ARG] = process.argv

const log = (msg) => console.log(`[branding] ${msg}`)
const warn = (msg) => console.log(`[branding] ! ${msg}`)

if (!URL_ARG || !OUT_DIR_ARG) {
  console.error('usage: node extract-branding.mjs <url> <outDir>')
  process.exit(2)
}

const START_URL = /^https?:\/\//i.test(URL_ARG) ? URL_ARG : `https://${URL_ARG}`
const OUT_DIR = path.resolve(OUT_DIR_ARG)
const ORIGIN = new URL(START_URL).origin

const MAX_PAGES = 6 // homepage + up to 5 crawled
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const NAV_TIMEOUT = 30000
// How long to wait for the network to go quiet (networkidle2) before reading a
// page that is still busy (chat widgets, polling, a slow host) as it is.
const IDLE_MS = 20000

// Time budget for the whole run. A small host (e.g. Render's 0.1-CPU free
// instance) renders pages many times slower than a laptop, and an unbounded
// crawl there just looks frozen. Past the budget no more pages are visited;
// at the hard limit the browser is closed and whatever was collected is saved.
const BUDGET_MS = Number(process.env.EXTRACT_BUDGET_MS) || 90000
const HARD_LIMIT_MS = BUDGET_MS + 30000
const STARTED = Date.now()
const timeLeft = () => BUDGET_MS - (Date.now() - STARTED)
const STEP_MS = 15000 // rough cost of one more page on a slow host
let stopped = false // set at the hard limit; no more navigation after that

// Third-party trackers, chat widgets and video say nothing about the brand but
// keep the network busy and the CPU pegged, which on a small host is the
// difference between a quick load and a timed-out one.
const BLOCKED_URLS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com',
  'googlesyndication.com', 'facebook.net', 'hotjar.com', 'clarity.ms', 'hs-scripts.com',
  'hs-analytics.net', 'hsadspixel.net', 'hs-banner.com', 'hsforms', 'usemessages.com',
  'intercom.io', 'intercomcdn.com', 'drift.com', 'crisp.chat', 'tawk.to', 'zdassets.com',
  'livechatinc.com', 'leadconnectorhq.com', 'msgsndr.com', 'snap.licdn.com', 'ads.linkedin.com',
  'bat.bing.com', 'ads-twitter.com', 'analytics.tiktok.com', 'segment.com', 'segment.io',
  'mixpanel.com', 'amplitude.com', 'fullstory.com', 'mouseflow.com', 'crazyegg.com',
  'analytics.ahrefs.com', 'challenges.cloudflare.com', 'youtube.com/embed', 'player.vimeo.com',
].map((h) => `*${h}*`).concat(['*.mp4*', '*.webm*', '*.m3u8*', '*.mov*'])

const PRIORITY = [
  'about', 'services', 'product', 'pricing', 'contact', 'team',
  'solutions', 'features', 'work', 'portfolio', 'blog', 'faq',
]

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// -----------------------------------------------------------------------------
// Chromium resolution: env → common paths → let puppeteer-core auto-detect.
// -----------------------------------------------------------------------------
function resolveChromium() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH
  if (env && existsSync(env)) return env
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/nix/var/nix/profiles/default/bin/chromium',
    '/root/.nix-profile/bin/chromium',
  ]
  for (const p of candidates) if (existsSync(p)) return p
  // Last resort: resolve from PATH. Nixpacks/apt installs land here under names
  // that vary by base image, so this makes the deploy robust to the exact path.
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try {
      const found = execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      if (found && existsSync(found)) return found
    } catch { /* not on PATH */ }
  }
  return undefined // puppeteer-core falls back to its own channel detection
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--window-size=1440,900',
  '--no-first-run',
  '--mute-audio',
  '--disable-extensions',
  // nothing in the background competing for a small host's CPU / memory
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
]

async function launchBrowser() {
  const executablePath = resolveChromium()
  log(`launching Chromium${executablePath ? ` (${executablePath})` : ' (auto-detect)'}`)
  return puppeteer.launch({
    headless: 'new',
    executablePath,
    // Over a pipe, Chromium exits by itself when this process dies (even on
    // SIGKILL); over a WebSocket it would be orphaned and hold its memory.
    pipe: true,
    args: LAUNCH_ARGS,
    protocolTimeout: 60000,
    defaultViewport: DESKTOP,
  })
}

// Apply stealth + realistic headers to a fresh page.
async function preparePage(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    window.chrome = { runtime: {} }
  })
  await page.setUserAgent(UA)
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    Referer: 'https://www.google.com/',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  })
  page.setDefaultNavigationTimeout(NAV_TIMEOUT)
  // Blocked through a separate DevTools session rather than request
  // interception, which would also switch off the HTTP cache the crawled pages
  // share their CSS / JS through.
  try {
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS })
  } catch (e) { warn(`tracker blocking unavailable: ${e.message}`) }
}

// -----------------------------------------------------------------------------
// Browser lifecycle with crash recovery. If Chromium dies mid-run we relaunch
// and hand back a fresh page; callers keep going with whatever's collected.
// -----------------------------------------------------------------------------
let browser = null
let page = null

async function ensureBrowser() {
  if (stopped) throw new Error('time limit reached')
  if (browser && browser.connected && page && !page.isClosed()) return page
  warn(browser ? 'browser not healthy - relaunching' : 'starting the browser')
  try { if (browser) await browser.close() } catch {}
  browser = await launchBrowser()
  page = await browser.newPage()
  await preparePage(page)
  return page
}

// Wait for networkidle2 for a capped time. If the page is still busy after
// that, keep the load already under way and read the page as soon as its DOM
// is parsed (a slow host used to time out here and then load the whole page a
// second time). Retries once, relaunching the browser if it crashed.
async function navigate(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const p = await ensureBrowser()
      // mark the current document, so a load that has not committed yet can't
      // be mistaken for the new page
      await p.evaluate(() => { window.__brandingPrevDoc = true }).catch(() => {})
      const idle = Math.max(5000, Math.min(IDLE_MS, timeLeft() / 3))
      try {
        await p.goto(url, { waitUntil: 'networkidle2', timeout: idle })
      } catch (e) {
        if (!/timeout/i.test(e.message)) throw e
        await p.waitForFunction(() => !window.__brandingPrevDoc && document.readyState !== 'loading', { timeout: NAV_TIMEOUT })
        warn(`page still busy after ${Math.round(idle / 1000)}s - reading it as it is`)
      }
      // confirm a live, evaluable context
      await p.evaluate(() => document.readyState)
      return p
    } catch (e) {
      if (stopped) throw e
      warn(`navigation attempt ${attempt} failed: ${e.message}`)
      // force a relaunch on the next ensureBrowser()
      try { if (browser) await browser.close() } catch {}
      browser = null
      page = null
    }
  }
  throw new Error(`could not load ${url}`)
}

// Click through common cookie / consent banners so they don't poison samples.
async function dismissCookieBanner(p) {
  try {
    await p.evaluate(() => {
      const sel = [
        '#onetrust-accept-btn-handler',
        '[class*="cookie"] button',
        '[class*="consent"] button',
        '.cc-accept',
        '.cc-allow',
        '.gdpr-accept',
        '[id*="cookie"] button',
        '[aria-label*="accept" i]',
        'button[class*="accept" i]',
        'button[class*="agree" i]',
      ]
      const byText = /^(accept|accept all|got it|i agree|agree|ok|allow all|allow)$/i
      for (const s of sel) {
        const el = document.querySelector(s)
        if (el) { el.click(); return }
      }
      for (const b of document.querySelectorAll('button, a[role="button"]')) {
        if (byText.test((b.textContent || '').trim())) { b.click(); return }
      }
    })
  } catch {}
}

// =============================================================================
// In-page extraction routines. Each is passed to page.evaluate and runs in the
// browser, so they are fully self-contained (no Node-scope references).
// =============================================================================

// --- Meta + tagline ----------------------------------------------------------
function pageMeta() {
  const title = document.title || ''
  const description =
    document.querySelector('meta[name="description"]')?.content ||
    document.querySelector('meta[property="og:description"]')?.content ||
    ''
  let tagline = ''
  for (const sel of ['[class*="hero"] h1', '[class*="hero"] h2', '[class*="banner"] h1']) {
    const el = document.querySelector(sel)
    if (el && el.textContent.trim()) { tagline = el.textContent.trim(); break }
  }
  if (!tagline) tagline = document.querySelector('h1')?.textContent?.trim() || ''
  return { title, description, tagline: tagline.slice(0, 300) }
}

// --- Logo (priority selectors → SVG → home link → first header img) ----------
function findLogo() {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
  const selectors = [
    'header [class*="logo" i] img', 'header [class*="brand" i] img',
    '[role="banner"] [class*="logo" i] img', 'nav [class*="logo" i] img',
    'header img[class*="logo" i]', 'header img[alt*="logo" i]',
    'header img[id*="logo" i]', '.w-nav-brand img', '.w-nav-brand svg',
    'a.navbar-brand img', '.navbar-brand img', 'img.logo', '.logo img',
    '#logo img', 'header .site-logo img', '.custom-logo', 'img.custom-logo',
    '.et_pb_image_wrap img', '.elementor-widget-image img[src*="logo" i]',
    'header svg[class*="logo" i]', '[class*="header" i] [class*="logo" i] img',
    '[class*="navbar" i] img[src*="logo" i]', 'header a[href="/"] img',
    'header [class*="logo" i] svg', 'nav [class*="logo" i] svg',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (!el) continue
    if (el.tagName === 'IMG' && el.currentSrc) {
      return { type: 'img', src: abs(el.currentSrc || el.src), selector: sel, strategy: 'priority-selector' }
    }
    if (el.tagName === 'svg') {
      return { type: 'svg', markup: el.outerHTML, selector: sel, strategy: 'priority-selector' }
    }
  }
  // header/banner SVG with a real viewBox
  for (const svg of document.querySelectorAll('header svg, [role="banner"] svg, nav svg')) {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
    const w = vb[2] || svg.getBoundingClientRect().width
    const h = vb[3] || svg.getBoundingClientRect().height
    const labelled = svg.getAttribute('role') === 'img' || svg.getAttribute('aria-label')
    if (w >= 50 && h >= 15 && (labelled || w / Math.max(h, 1) > 1.4)) {
      return { type: 'svg', markup: svg.outerHTML, selector: 'header svg[viewBox]', strategy: 'header-svg' }
    }
  }
  // first home link image/svg in header/nav
  const homeLink = document.querySelector('header a[href="/"], nav a[href="/"], [role="banner"] a[href="/"]')
  if (homeLink) {
    const img = homeLink.querySelector('img')
    if (img) return { type: 'img', src: abs(img.currentSrc || img.src), selector: 'header a[href="/"] img', strategy: 'home-link-img' }
    const svg = homeLink.querySelector('svg')
    if (svg) return { type: 'svg', markup: svg.outerHTML, selector: 'header a[href="/"] svg', strategy: 'home-link-svg' }
  }
  // finally: the first header img
  const first = document.querySelector('header img')
  if (first) return { type: 'img', src: abs(first.currentSrc || first.src), selector: 'header img', strategy: 'first-header-img' }
  return null
}

// --- Favicon + OG image refs -------------------------------------------------
function findAssets() {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
  const icon =
    document.querySelector('link[rel="icon"]')?.href ||
    document.querySelector('link[rel="shortcut icon"]')?.href ||
    document.querySelector('link[rel="apple-touch-icon"]')?.href ||
    `${location.origin}/favicon.ico`
  const og = document.querySelector('meta[property="og:image"]')?.content || null
  return { favicon: abs(icon), ogImage: og ? abs(og) : null }
}

// --- Colors: per-page weighted samples + bg/text votes -----------------------
function samplePageColors() {
  const toHex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  const rgbToHex = (r, g, b) => `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`
  const hslToHex = (h, s, l) => {
    s /= 100; l /= 100
    const k = (n) => (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return rgbToHex(255 * f(0), 255 * f(8), 255 * f(4))
  }
  const rootStyle = getComputedStyle(document.documentElement)
  const normHex = (input) => {
    if (input == null) return null
    let s = String(input).trim().toLowerCase()
    if (!s || s === 'transparent' || s === 'none' || s === 'currentcolor' || s === 'inherit') return null
    // resolve a single var(--x) against :root
    const vm = s.match(/^var\(\s*(--[\w-]+)\s*(?:,([^)]+))?\)$/)
    if (vm) {
      const v = rootStyle.getPropertyValue(vm[1]).trim() || (vm[2] || '').trim()
      if (!v || v.includes('var(')) return null
      s = v.toLowerCase()
    }
    if (s.includes('var(')) return null
    let m = s.match(/^#([0-9a-f]{3})$/)
    if (m) return '#' + m[1].split('').map((c) => c + c).join('')
    if (/^#[0-9a-f]{6}$/.test(s)) return s
    m = s.match(/^#([0-9a-f]{8})$/)
    if (m) return parseInt(s.slice(7, 9), 16) === 0 ? null : '#' + s.slice(1, 7)
    m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
    if (m) { if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; return rgbToHex(+m[1], +m[2], +m[3]) }
    m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/)
    if (m) { if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; return hslToHex(+m[1], +m[2], +m[3]) }
    return null
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 5 || r.height <= 5) return false
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
    if (!el.offsetParent && cs.position !== 'fixed' && cs.position !== 'sticky') return false
    return true
  }

  const samples = [] // { hex, weight, painted }  painted=false only for cssvar
  const add = (hex, weight, painted) => { if (hex) samples.push({ hex, weight, painted }) }

  // 1) :root / html custom properties (declared, maybe-unpainted) → weight 0.1
  for (const sheetEl of [document.documentElement]) {
    const cs = getComputedStyle(sheetEl)
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]
      if (prop.startsWith('--')) add(normHex(cs.getPropertyValue(prop)), 0.1, false)
    }
  }

  // 2) hand-weighted key elements (sample up to 5 each)
  const weighted = [
    ['body', 1], ['header', 5], ['footer', 5], ['h1', 5], ['h2', 5], ['h3', 5],
    ['a', 3], ['button', 5], ['[class*="btn" i]', 5], ['[class*="button" i]', 5],
    ['[class*="hero" i]', 5], ['[class*="cta" i]', 5], ['[class*="primary" i]', 2],
    ['section', 4], ['nav a', 4],
  ]
  for (const [sel, weight] of weighted) {
    let n = 0
    for (const el of document.querySelectorAll(sel)) {
      if (n >= 5) break
      if (!visible(el)) continue
      n++
      const cs = getComputedStyle(el)
      add(normHex(cs.backgroundColor), weight, true)
      add(normHex(cs.color), weight, true)
      add(normHex(cs.borderColor), weight, true)
    }
  }

  // visible section backgrounds → weight 8
  {
    let n = 0
    for (const el of document.querySelectorAll('section, [class*="section" i]')) {
      if (n >= 8) break
      if (!visible(el)) continue
      const bg = normHex(getComputedStyle(el).backgroundColor)
      if (bg) { add(bg, 8, true); n++ }
    }
  }

  // 3) general scan of up to 250 visible elements → weight 1
  {
    let n = 0
    for (const el of document.querySelectorAll('div,section,header,footer,main,button,a,span')) {
      if (n >= 250) break
      if (!visible(el)) continue
      n++
      const cs = getComputedStyle(el)
      add(normHex(cs.backgroundColor), 1, true)
      add(normHex(cs.color), 1, true)
      add(normHex(cs.borderColor), 1, true)
    }
  }

  // --- authoritative background + text votes ---
  const vw = window.innerWidth, vh = window.innerHeight
  const bodyCs = getComputedStyle(document.body)
  let bgVote = normHex(bodyCs.backgroundColor) || normHex(getComputedStyle(document.documentElement).backgroundColor)
  const textVote = normHex(bodyCs.color)
  // prefer the single LARGEST painted background element over the body theme
  let best = null, bestArea = 0
  for (const el of document.querySelectorAll('div,section,main,header,footer')) {
    if (!visible(el)) continue
    const bg = normHex(getComputedStyle(el).backgroundColor)
    if (!bg) continue
    const r = el.getBoundingClientRect()
    const area = r.width * r.height
    if (r.width > vw * 0.5 && area > vw * vh * 0.4 && area > bestArea) { best = bg; bestArea = area }
  }
  if (best) bgVote = best

  return { samples, bgVote, textVote }
}

// --- Typography --------------------------------------------------------------
function extractTypography() {
  const firstFamily = (ff) => (ff || '').split(',')[0].replace(/["']/g, '').trim()
  const role = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color,
      family: firstFamily(cs.fontFamily),
    }
  }
  const fonts = new Set()
  for (const el of document.querySelectorAll('h1,h2,h3,h4,p,a,button,span,li,nav a')) {
    const f = firstFamily(getComputedStyle(el).fontFamily)
    if (f) fonts.add(f)
  }
  const google = []
  for (const l of document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')) {
    if (l.href) google.push(l.href)
  }
  return {
    heading: role('h1'), body: role('body'), h2: role('h2'), h3: role('h3'),
    nav: role('nav a'), button: role('button'),
    fonts_used: [...fonts].slice(0, 20),
    google_fonts: [...new Set(google)],
  }
}

// --- Design tokens (buttons / input / card / scales / navLink) ---------------
function extractTokens() {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0
  }
  const transparent = (c) => !c || c === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c)
  const tokenize = (el) => {
    const cs = getComputedStyle(el)
    return {
      selector: el.className && typeof el.className === 'string'
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).join('.')
        : el.tagName.toLowerCase(),
      backgroundColor: cs.backgroundColor, color: cs.color,
      border: cs.border, borderColor: cs.borderColor, borderWidth: cs.borderWidth,
      borderStyle: cs.borderStyle, borderRadius: cs.borderRadius, padding: cs.padding,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
      boxShadow: cs.boxShadow, transition: cs.transition, textTransform: cs.textTransform,
      width: cs.width, height: cs.height,
      outerHTML: (el.outerHTML || '').slice(0, 500),
    }
  }

  // buttons by variant
  const groups = [
    ['primary', ['[class*="btn-primary" i]', '[class*="button--primary" i]', '.btn-primary', 'button[class*="primary" i]', '[class*="cta" i] a', '[class*="cta" i] button']],
    ['secondary', ['[class*="btn-secondary" i]', '[class*="button--secondary" i]', '.btn-secondary', 'button[class*="secondary" i]']],
    ['outline', ['[class*="btn-outline" i]', '[class*="outline" i].btn', 'button[class*="outline" i]']],
    ['ghost', ['[class*="ghost" i]', 'button[class*="text" i]']],
    ['nav-link', ['header nav a', 'nav a']],
    ['default', ['button', '.btn', 'a.button', '.wp-block-button__link', '.et_pb_button', 'a.btn', '[role="button"]']],
  ]
  const buttons = []
  const seen = new Set()
  for (const [label, sels] of groups) {
    for (const sel of sels) {
      let pushed = false
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue
        const cs = getComputedStyle(el)
        if (label !== 'nav-link' && label !== 'ghost' && transparent(cs.backgroundColor)) continue
        const key = (typeof el.className === 'string' ? el.className : '') + '|' + cs.backgroundColor
        if (seen.has(key)) continue
        seen.add(key)
        buttons.push({ label, ...tokenize(el) })
        pushed = true
        break
      }
      if (pushed) break
    }
  }

  const inputEl = document.querySelector(
    'input[type="text"], input[type="email"], input[type="search"], textarea, select, [class*="input" i], [class*="form-control" i], [class*="field" i]',
  )
  let card = null
  for (const el of document.querySelectorAll('[class*="card" i], [class*="tile" i], [class*="panel" i], [class*="feature" i], [class*="pricing-card" i], article')) {
    if (el.offsetWidth > 100 && el.offsetHeight > 50) { card = el; break }
  }

  // frequency-ranked scales
  const rank = (sel, getters, limit, skip) => {
    const counts = {}
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el)
      for (const g of getters) {
        const v = (cs[g] || '').trim()
        if (!v || skip(v)) continue
        counts[v] = (counts[v] || 0) + 1
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([v]) => v)
  }
  const zero = (v) => /^0(px|%|em|rem)?$/.test(v) || v === '0px'
  const borderRadii = rank('button,[class*="btn" i],[class*="card" i],input,[class*="badge" i],img', ['borderRadius'], 6, (v) => zero(v) || v === '0px 0px 0px 0px')
  const shadows = rank('[class*="card" i],[class*="modal" i],[class*="dropdown" i],[class*="panel" i],header,nav', ['boxShadow'], 4, (v) => v === 'none')
  const spacing = rank('section,[class*="container" i],[class*="wrapper" i]', ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'], 8, (v) => zero(v))
  const transitions = rank('a,button,[class*="link" i]', ['transition'], 3, (v) => v === 'all 0s ease 0s' || v === 'none' || !/[\ds]/.test(v))

  const navLinkEl = document.querySelector('header nav a, nav a')

  return {
    buttons,
    input: inputEl ? tokenize(inputEl) : null,
    card: card ? tokenize(card) : null,
    borderRadii, shadows, spacing, transitions,
    navLink: navLinkEl ? tokenize(navLinkEl) : null,
  }
}

// --- SVG icons ---------------------------------------------------------------
function extractIcons() {
  const out = []
  const seen = new Set()
  for (const svg of document.querySelectorAll('button svg, a svg, li svg, [class*="icon" i] svg, nav svg')) {
    const html = svg.outerHTML || ''
    const k = html.slice(0, 100)
    if (seen.has(k)) continue
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
    const w = vb[2] || svg.getBoundingClientRect().width || 0
    const h = vb[3] || svg.getBoundingClientRect().height || 0
    const iconish = /icon/i.test((svg.parentElement?.className || '') + ' ' + (svg.getAttribute('class') || ''))
    const small = w > 0 && h > 0 && w <= 64 && h <= 64
    if (!small && !iconish) continue
    seen.add(k)
    const name = (svg.getAttribute('aria-label') || `icon-${out.length + 1}`)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `icon-${out.length + 1}`
    out.push({ name, markup: html, viewBox: svg.getAttribute('viewBox') || '', width: Math.round(w), height: Math.round(h) })
    if (out.length >= 30) break
  }
  return out
}

// --- CSS dump ----------------------------------------------------------------
function extractCss() {
  const out = []
  // :root / html custom properties
  const rootCs = getComputedStyle(document.documentElement)
  const vars = []
  for (let i = 0; i < rootCs.length; i++) {
    const p = rootCs[i]
    if (p.startsWith('--')) vars.push(`  ${p}: ${rootCs.getPropertyValue(p).trim()};`)
  }
  if (vars.length) out.push(`:root {\n${vars.join('\n')}\n}`)
  // @font-face + @import rules (best-effort; cross-origin sheets throw)
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    if (!rules) continue
    for (const r of rules) {
      if (r.constructor.name === 'CSSFontFaceRule') out.push(r.cssText)
      if (r.constructor.name === 'CSSImportRule' && /fonts\.googleapis\.com/.test(r.href || '')) out.push(r.cssText)
    }
  }
  // computed styles of key elements
  const keys = ['body', 'header', 'footer', 'h1', 'h2', 'h3', 'p', 'a', 'button', 'input', '.card']
  const props = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border-radius', 'padding', 'box-shadow']
  for (const sel of keys) {
    const el = document.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    const decls = props.map((p) => `  ${p}: ${cs.getPropertyValue(p)};`).join('\n')
    out.push(`${sel} {\n${decls}\n}`)
  }
  return out.join('\n\n')
}

// --- Self-contained component HTML ------------------------------------------
function extractComponents() {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
  const defs = [
    ['header', ['header', '[role="banner"]', '.site-header', '.header', '.w-nav', '.et-l--header', '.elementor-location-header']],
    ['footer', ['footer', '[role="contentinfo"]', '.site-footer', '.footer', '.et-l--footer', '.elementor-location-footer']],
    ['navigation', ['nav', '[role="navigation"]', '.navbar', '.w-nav', '.menu', '.et_pb_menu']],
    ['hero', ['[class*="hero" i]', 'section:first-of-type', '.elementor-section:first-of-type', '.et_pb_section:first-of-type']],
    ['cta', ['[class*="cta" i]', '[class*="call-to-action" i]']],
    ['testimonials', ['[class*="testimonial" i]', '[class*="review" i]']],
    ['features', ['[class*="feature" i]', '[class*="benefits" i]']],
    ['pricing', ['[class*="pricing" i]', '[class*="plans" i]']],
    ['cards', ['[class*="card" i]', '[class*="tile" i]']],
  ]
  // shared <head> material so snippets render standalone
  const styles = [...document.querySelectorAll('style')].map((s) => s.outerHTML).join('\n')
  const fontLinks = [...document.querySelectorAll('link[href*="fonts.googleapis.com"], link[rel="stylesheet"][href*="font" i]')]
    .map((l) => `<link rel="stylesheet" href="${abs(l.href)}">`).join('\n')
  const rootCs = getComputedStyle(document.documentElement)
  const vars = []
  for (let i = 0; i < rootCs.length; i++) { const p = rootCs[i]; if (p.startsWith('--')) vars.push(`${p}:${rootCs.getPropertyValue(p).trim()};`) }
  const fontFaces = []
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    if (!rules) continue
    for (const r of rules) if (r.constructor.name === 'CSSFontFaceRule') fontFaces.push(r.cssText)
  }
  const head =
    `<base href="${location.origin}/">\n` +
    `<style>:root{${vars.join('')}}</style>\n` +
    (fontFaces.length ? `<style>${fontFaces.join('\n')}</style>\n` : '') +
    fontLinks + '\n' + styles

  const found = []
  const used = new Set()
  for (const [name, sels] of defs) {
    let el = null, usedSel = ''
    for (const s of sels) { el = document.querySelector(s); if (el) { usedSel = s; break } }
    if (!el || used.has(el)) continue
    used.add(el)
    const snippet = el.outerHTML
    const full = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${head}\n</head>\n<body>\n${snippet}\n</body>\n</html>`
    found.push({ name, selector: usedSel, tag: el.tagName.toLowerCase(), snippet, full })
  }
  return found
}

// --- Cleaned page HTML -------------------------------------------------------
function cleanPageHtml() {
  const clone = document.documentElement.cloneNode(true)
  clone.querySelectorAll('script').forEach((s) => {
    if ((s.getAttribute('type') || '').includes('ld+json')) return
    s.remove()
  })
  clone.querySelectorAll(
    'iframe[src*="analytics" i], iframe[src*="doubleclick" i], iframe[src*="googletag" i], img[src*="pixel" i], img[width="1"][height="1"], [class*="cookie" i], [class*="consent" i], [class*="gdpr" i], #onetrust-banner-sdk',
  ).forEach((n) => n.remove())
  return '<!doctype html>\n' + clone.outerHTML
}

// --- Crawl candidate links ---------------------------------------------------
function crawlLinks() {
  const origin = location.origin
  const out = []
  const seen = new Set()
  const scopes = document.querySelectorAll('header a[href], nav a[href], [role="navigation"] a[href], [class*="menu" i] a[href]')
  for (const a of scopes) {
    let u
    try { u = new URL(a.getAttribute('href'), location.href) } catch { continue }
    if (u.origin !== origin) continue
    if (/^(#|javascript:|mailto:|tel:)/i.test(a.getAttribute('href') || '')) continue
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mov|css|js|xml|json)(\?|$)/i.test(u.pathname)) continue
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length > 2) continue
    const path = u.pathname.replace(/\/+$/, '') || '/'
    if (path === '/' || seen.has(path)) continue
    seen.add(path)
    out.push({ path, href: u.origin + path })
  }
  return out
}

// =============================================================================
// Color aggregation + role classification (Node side).
// =============================================================================
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
function dist(a, b) {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000
}
function saturation(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

function aggregateColors(perPage) {
  // sum weights per hex, track painted flag + page provenance
  const acc = {} // hex → { weight, painted, pages:Set }
  const bgTally = {}, textTally = {}
  for (const { name, samples, bgVote, textVote } of perPage) {
    for (const { hex, weight, painted } of samples) {
      if (!acc[hex]) acc[hex] = { weight: 0, painted: false, pages: new Set() }
      acc[hex].weight += weight
      if (painted) acc[hex].painted = true
      acc[hex].pages.add(name)
    }
    if (bgVote) bgTally[bgVote] = (bgTally[bgVote] || 0) + 1
    if (textVote) textTally[textVote] = (textTally[textVote] || 0) + 1
  }
  // keep only colors actually painted (not :root-var only)
  let entries = Object.entries(acc)
    .filter(([, v]) => v.painted)
    .map(([hex, v]) => ({ hex, weight: v.weight, pages: [...v.pages] }))
    .sort((a, b) => b.weight - a.weight)

  // de-dup visually similar (RGB distance < 15), merging into the heavier one
  const deduped = []
  for (const c of entries) {
    const near = deduped.find((d) => dist(d.hex, c.hex) < 15)
    if (near) { near.weight += c.weight; near.pages = [...new Set([...near.pages, ...c.pages])] }
    else deduped.push({ ...c })
  }
  deduped.sort((a, b) => b.weight - a.weight)
  const top = deduped.slice(0, 30)

  // classify roles
  const isLight = (h) => luminance(h) > 200
  const isDark = (h) => luminance(h) < 50
  const isGrey = (h) => saturation(h) < 0.1
  const accents = top.filter((c) => !isLight(c.hex) && !isDark(c.hex) && !isGrey(c.hex)).map((c) => c.hex)
  const greys = top.filter((c) => isGrey(c.hex)).map((c) => c.hex)
  const lights = top.filter((c) => isLight(c.hex)).map((c) => c.hex)
  const darks = top.filter((c) => isDark(c.hex)).map((c) => c.hex)

  const topVote = (tally) => Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || null

  const primary = accents[0] || top[0]?.hex || null
  const secondary = accents[1] || greys[0] || top[1]?.hex || null
  const accent = accents[2] || accents[1] || accents[0] || null
  const background = topVote(bgTally) || lights[0] || top[0]?.hex || null
  const text = topVote(textTally) || darks[0] || top[top.length - 1]?.hex || null

  return {
    primary, secondary, accent, background, text,
    all: top.map((c) => c.hex),
    all_with_sources: top.map((c) => ({ hex: c.hex, pages: c.pages })),
  }
}

// =============================================================================
// Asset download (handles data: URIs and remote URLs).
// =============================================================================
async function download(url, destAbs) {
  try {
    if (!url) return false
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
      if (!m) return false
      const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
      if (!buf.length) return false
      await fs.writeFile(destAbs, buf)
      return true
    }
    const r = await fetch(url, { headers: { 'user-agent': UA, Referer: ORIGIN }, redirect: 'follow', signal: AbortSignal.timeout(10000) })
    if (!r.ok) return false
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return false
    await fs.writeFile(destAbs, buf)
    return true
  } catch (e) {
    warn(`download failed (${url?.slice(0, 80)}): ${e.message}`)
    return false
  }
}

// =============================================================================
// QA / self-healing pass.
// =============================================================================
function buildQa(checks) {
  const total = checks.length
  const passed = checks.filter((c) => c.status === 'pass' || c.status === 'retried').length
  const score = Math.round((passed / total) * 100)
  return { score, total, passed, checks, timestamp: new Date().toISOString() }
}

async function runQa(branding) {
  const checks = []
  const add = (name, status, message) => checks.push({ name, status, message })
  // Reloading the homepage only pays off when there is something to retry,
  // and only when the time budget still allows a page load.
  const needsRetry = !branding.logo || !branding.typography.fonts_used.length || branding.design_tokens.buttons.length < 2
  let p
  try {
    if (!needsRetry) throw new Error('nothing to retry')
    if (timeLeft() < STEP_MS) throw new Error('no time left to retry')
    p = await navigate(START_URL)
    await dismissCookieBanner(p)
  } catch {
    // offline QA from collected data only
    add('Logo', branding.logo ? 'pass' : 'fail', branding.logo ? 'logo captured' : 'no logo')
    add('Colors', (branding.colors.all.length >= 5 && branding.colors.primary) ? 'pass' : 'warn', `${branding.colors.all.length} colors`)
    add('Typography', branding.typography.fonts_used.length ? 'pass' : 'warn', `${branding.typography.fonts_used.length} fonts`)
    add('Buttons', branding.design_tokens.buttons.length >= 2 ? 'pass' : 'warn', `${branding.design_tokens.buttons.length} buttons`)
    add('Components', branding.html.components.length >= 2 ? 'pass' : 'warn', `${branding.html.components.length} components`)
    add('Screenshots', branding.screenshots.desktop.length ? 'pass' : 'fail', `${branding.screenshots.desktop.length} desktop`)
    add('Icons', branding.icons.length ? 'pass' : 'warn', `${branding.icons.length} icons`)
    add('Design tokens', branding.design_tokens.borderRadii.length ? 'pass' : 'warn', 'token scales')
    return buildQa(checks)
  }

  // Logo
  if (branding.logo) add('Logo', 'pass', `logo via ${branding.logo.strategy}`)
  else {
    const retried = await p.evaluate(() => {
      const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
      const bySrc = [...document.querySelectorAll('img')].find((i) => /logo|brand/i.test(i.src))
      if (bySrc) return { src: abs(bySrc.src), strategy: 'img-src-logo' }
      const topImg = [...document.querySelectorAll('img')].find((i) => i.getBoundingClientRect().top < 200)
      if (topImg) return { src: abs(topImg.src), strategy: 'top-200-img' }
      const topSvg = [...document.querySelectorAll('svg')].find((s) => s.getBoundingClientRect().top < 200)
      if (topSvg) return { markup: topSvg.outerHTML, strategy: 'top-200-svg' }
      const og = document.querySelector('meta[property="og:image"]')?.content
      if (og) return { src: abs(og), strategy: 'og-image-fallback' }
      return null
    })
    if (retried?.src && await download(retried.src, path.join(OUT_DIR, 'logo.png'))) {
      branding.logo = { file: 'logo.png', src_url: retried.src, type: null, strategy: retried.strategy }
      add('Logo', 'retried', `recovered via ${retried.strategy}`)
    } else if (retried?.markup) {
      await fs.writeFile(path.join(OUT_DIR, 'logo.svg'), retried.markup)
      branding.logo = { file: 'logo.svg', src_url: null, type: 'svg', strategy: retried.strategy }
      add('Logo', 'retried', `recovered via ${retried.strategy}`)
    } else add('Logo', 'fail', 'no logo found after retries')
  }

  // Colors
  if (branding.colors.all.length >= 5 && branding.colors.primary) add('Colors', 'pass', `${branding.colors.all.length} colors + primary`)
  else add('Colors', branding.colors.all.length ? 'warn' : 'fail', `${branding.colors.all.length} colors, primary=${branding.colors.primary}`)

  // Typography
  if (branding.typography.fonts_used.length) add('Typography', 'pass', `${branding.typography.fonts_used.length} families`)
  else {
    const fonts = await p.evaluate(() => {
      const s = new Set()
      for (const el of document.querySelectorAll('h1,h2,h3,p,a,span')) s.add(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim())
      return [...s].filter(Boolean)
    })
    if (fonts.length) { branding.typography.fonts_used = fonts.slice(0, 20); add('Typography', 'retried', `re-scanned ${fonts.length}`) }
    else add('Typography', 'warn', 'no font families detected')
  }

  // Buttons
  if (branding.design_tokens.buttons.length >= 2) add('Buttons', 'pass', `${branding.design_tokens.buttons.length} buttons`)
  else {
    const more = await p.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('a,button,[role="button"],[class*="btn" i]')) {
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        if (!bg || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg) || bg === 'transparent') continue
        out.push({ label: 'default', selector: el.tagName.toLowerCase(), backgroundColor: bg, color: cs.color, borderRadius: cs.borderRadius, padding: cs.padding, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, boxShadow: cs.boxShadow, transition: cs.transition, textTransform: cs.textTransform, outerHTML: (el.outerHTML || '').slice(0, 500) })
        if (out.length >= 4) break
      }
      return out
    })
    if (branding.design_tokens.buttons.length + more.length >= 2) {
      branding.design_tokens.buttons.push(...more)
      add('Buttons', 'retried', `recovered ${more.length} more`)
    } else add('Buttons', 'warn', `only ${branding.design_tokens.buttons.length} buttons`)
  }

  // Components (header + footer present)
  const names = new Set(branding.html.components.map((c) => c.name))
  if (names.has('header') && names.has('footer')) add('Components', 'pass', 'header + footer present')
  else add('Components', branding.html.components.length ? 'warn' : 'fail', `${branding.html.components.length} components`)

  add('Screenshots', branding.screenshots.desktop.length ? 'pass' : 'fail', `${branding.screenshots.desktop.length} desktop / ${branding.screenshots.mobile.length} mobile`)
  add('Icons', branding.icons.length ? 'pass' : 'warn', `${branding.icons.length} icons`)
  add('Design tokens', branding.design_tokens.borderRadii.length || branding.design_tokens.buttons.length ? 'pass' : 'warn', 'token scales captured')

  return buildQa(checks)
}

// =============================================================================
// Main flow.
// =============================================================================
async function main() {
  // directory layout
  for (const d of ['', 'screenshots', 'screenshots/mobile', 'assets', 'icons', 'html', 'html/pages', 'html/components', 'html/styles']) {
    await fs.mkdir(path.join(OUT_DIR, d), { recursive: true })
  }

  const branding = {
    url: START_URL, version: 2, extracted_at: new Date().toISOString(),
    logo: null, favicon: null,
    colors: { primary: null, secondary: null, accent: null, background: null, text: null, all: [], all_with_sources: [] },
    typography: { heading: null, body: null, h2: null, h3: null, nav: null, button: null, fonts_used: [], google_fonts: [] },
    design_tokens: { buttons: [], input: null, card: null, borderRadii: [], shadows: [], spacing: [], transitions: [], navLink: null },
    meta: { title: '', description: '', tagline: '' },
    screenshots: { desktop: [], mobile: [] },
    pages_crawled: [],
    icons: [],
    html: { pages: [], components: [], styles: 'html/styles/extracted.css' },
    qa: null,
  }

  const perPageColors = []

  // capture screenshots (desktop + mobile) + cleaned HTML for one page
  async function capturePage(p, name, relPath) {
    try {
      await p.setViewport(DESKTOP)
      await p.screenshot({ path: path.join(OUT_DIR, 'screenshots', `${name}.png`), fullPage: false })
      branding.screenshots.desktop.push(`screenshots/${name}.png`)
    } catch (e) { warn(`desktop screenshot ${name}: ${e.message}`) }
    try {
      await p.setViewport(MOBILE)
      await p.screenshot({ path: path.join(OUT_DIR, 'screenshots', 'mobile', `${name}.png`), fullPage: false })
      branding.screenshots.mobile.push(`screenshots/mobile/${name}.png`)
      await p.setViewport(DESKTOP)
    } catch (e) { warn(`mobile screenshot ${name}: ${e.message}`) }
    try {
      const html = await p.evaluate(cleanPageHtml)
      await fs.writeFile(path.join(OUT_DIR, 'html', 'pages', `${name}.html`), html)
      branding.html.pages.push({ name, file: `html/pages/${name}.html`, url: relPath })
    } catch (e) { warn(`clean html ${name}: ${e.message}`) }
  }

  // Hard stop: closing the browser makes every pending page call fail, so the
  // run falls through to `finally` and still writes what it has.
  const hardStop = setTimeout(() => {
    stopped = true
    warn(`time limit (${Math.round(HARD_LIMIT_MS / 1000)}s) reached - saving what was collected`)
    browser?.close().catch(() => {})
  }, HARD_LIMIT_MS)
  // The server sends SIGTERM when it gives up on the job. Puppeteer closes the
  // browser on that signal but leaves this process running, which used to
  // relaunch Chromium; mark the run stopped so it finishes instead.
  process.once('SIGTERM', () => {
    stopped = true
    warn('stop requested - saving what was collected')
    browser?.close().catch(() => {})
  })

  try {
    log(`extracting branding for ${START_URL}`)
    let p = await navigate(START_URL)
    await dismissCookieBanner(p)

    log('reading page meta + tagline')
    branding.meta = await p.evaluate(pageMeta)

    log('locating logo')
    const logo = await p.evaluate(findLogo)
    if (logo?.type === 'svg') {
      await fs.writeFile(path.join(OUT_DIR, 'logo.svg'), logo.markup)
      branding.logo = { file: 'logo.svg', src_url: null, type: 'svg', strategy: logo.strategy }
    } else if (logo?.type === 'img') {
      const ok = await download(logo.src, path.join(OUT_DIR, 'logo.png'))
      branding.logo = ok ? { file: 'logo.png', src_url: logo.src, type: null, strategy: logo.strategy } : null
    }

    log('fetching favicon + og image')
    const assets = await p.evaluate(findAssets)
    if (assets.favicon && await download(assets.favicon, path.join(OUT_DIR, 'favicon.png'))) {
      branding.favicon = { file: 'favicon.png', src_url: assets.favicon }
    }
    // OG image is saved to assets/ as a raw file (not referenced in the schema).
    if (assets.ogImage) await download(assets.ogImage, path.join(OUT_DIR, 'assets', 'og-image.png'))

    log('sampling homepage colors')
    perPageColors.push({ name: 'homepage', ...(await p.evaluate(samplePageColors)) })

    log('extracting typography')
    branding.typography = await p.evaluate(extractTypography)

    log('extracting design tokens')
    branding.design_tokens = await p.evaluate(extractTokens)

    log('extracting svg icons')
    const icons = await p.evaluate(extractIcons)
    for (const ic of icons) {
      const file = `icons/${ic.name}.svg`
      try {
        await fs.writeFile(path.join(OUT_DIR, file), ic.markup)
        branding.icons.push({ name: ic.name, file, viewBox: ic.viewBox, width: ic.width, height: ic.height })
      } catch {}
    }

    log('extracting self-contained components')
    const comps = await p.evaluate(extractComponents)
    for (const c of comps) {
      const file = `html/components/${c.name}.html`
      const snippetFile = `html/components/${c.name}.snippet.html`
      try {
        await fs.writeFile(path.join(OUT_DIR, file), c.full)
        await fs.writeFile(path.join(OUT_DIR, snippetFile), c.snippet)
        branding.html.components.push({ name: c.name, file, snippet: snippetFile, selector: c.selector, tag: c.tag })
      } catch {}
    }

    log('dumping extracted.css')
    try {
      const css = await p.evaluate(extractCss)
      await fs.writeFile(path.join(OUT_DIR, 'html', 'styles', 'extracted.css'), css)
    } catch (e) { warn(`css dump: ${e.message}`) }

    log('capturing homepage screenshots + cleaned html')
    const usedNames = new Set(['homepage'])
    const uniqueName = (base) => {
      let name = base || 'page'
      let i = 2
      while (usedNames.has(name)) name = `${base || 'page'}-${i++}`
      usedNames.add(name)
      return name
    }
    await capturePage(p, 'homepage', '/')
    branding.pages_crawled.push('/')

    log('discovering crawl candidates')
    let candidates = []
    try { candidates = await p.evaluate(crawlLinks) } catch {}
    // score against the priority list, then visit the top 5
    const scored = candidates
      .map((c) => {
        const seg = c.path.toLowerCase()
        let score = 0
        PRIORITY.forEach((kw, i) => { if (seg.includes(kw)) score = Math.max(score, PRIORITY.length - i) })
        return { ...c, score }
      })
      .sort((a, b) => b.score - a.score)
    const toVisit = scored.slice(0, MAX_PAGES - 1)
    log(`crawling ${toVisit.length} more page(s): ${toVisit.map((c) => c.path).join(', ') || '(none)'}`)

    for (const [i, cand] of toVisit.entries()) {
      if (timeLeft() < STEP_MS) {
        warn(`time budget reached - skipping the remaining ${toVisit.length - i} page(s)`)
        break
      }
      const slug = cand.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
      const name = uniqueName(slug)
      try {
        log(`crawling ${cand.path}`)
        const cp = await navigate(cand.href)
        await dismissCookieBanner(cp)
        perPageColors.push({ name, ...(await cp.evaluate(samplePageColors)) })
        // screenshots + HTML are extras (the app reads colors / fonts / meta);
        // drop them first when time is short
        if (timeLeft() > STEP_MS * 2) await capturePage(cp, name, cand.path)
        branding.pages_crawled.push(cand.path)
      } catch (e) {
        warn(`page ${cand.path} failed (continuing): ${e.message}`)
      }
    }

    log('aggregating colors across all crawled pages')
    branding.colors = aggregateColors(perPageColors)

    log('running QA + self-healing pass')
    branding.qa = await runQa(branding)
  } catch (e) {
    warn(`fatal: ${e.message}`)
    // still aggregate whatever colors we managed to sample
    if (perPageColors.length && !branding.colors.all.length) {
      try { branding.colors = aggregateColors(perPageColors) } catch {}
    }
    if (!branding.qa) {
      try { branding.qa = await runQa(branding) } catch { branding.qa = buildQa([{ name: 'Run', status: 'fail', message: e.message }]) }
    }
  } finally {
    clearTimeout(hardStop)
    try { if (browser) await browser.close() } catch {}
    await fs.writeFile(path.join(OUT_DIR, 'branding.json'), JSON.stringify(branding, null, 2))
    log(`wrote branding.json (qa score ${branding.qa?.score ?? 'n/a'})`)
    log('done')
  }
}

main().catch(async (e) => {
  warn(`unhandled: ${e.message}`)
  try { await fs.writeFile(path.join(OUT_DIR, 'branding.json'), JSON.stringify({ url: START_URL, version: 2, error: e.message }, null, 2)) } catch {}
  process.exit(1)
})
