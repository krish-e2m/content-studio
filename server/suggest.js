// Idea suggestions from a research topic. Two paths, both OpenRouter + Claude
// Haiku 4.5 (no Groq):
//
//   • Web-grounded (preferred): Haiku 4.5 with OpenRouter's web-search plugin
//     attached, so the ideas are grounded in the LATEST news/trends/stats.
//   • Plain fallback (no web access): a single-turn Haiku call. The safety net
//     whenever the web path errors or returns nothing.
//
// Both return the same shape: 2-3 distinct content ideas for the Idea Bank.

import { chatComplete, HAIKU } from './openrouter.js'
import { fetchSiteSummary } from './brand.js'

const PLATFORM_IDS = ['linkedin', 'instagram', 'substack', 'email', 'x']

const SYS = `You are a senior content strategist for a social-media agency.
Given a research topic and rich brand context, propose 2-3 DISTINCT, ready-to-develop content ideas.
Each idea must be concrete and specific to the topic — not a generic template — and must commit to ONE story angle plus (when pillars exist) ONE content pillar.
Return STRICT JSON only, matching exactly:
{
  "ideas": [
    {
      "title": "short punchy headline (max ~90 chars)",
      "description": "1-2 sentences: the angle, story or point of view",
      "angle": "one concrete story angle / POV in a single sentence",
      "pillar": "exact name of one content pillar from the brand list, or empty string if none fit",
      "sourceUrl": "MANDATORY: Provide ONLY a valid URL string that is the source of this idea. Do not include any other text.",
      "tags": ["2-4 short topical tags"],
      "platform": "one of: linkedin, instagram, substack, email, x"
    }
  ]
}
No prose, no markdown, no commentary - just the JSON object.`

function userPrompt({ topic, brand, platforms }) {
  const lines = [
    `Research topic: "${topic}"`,
    brand.name ? `Brand: ${brand.name}` : '',
    brand.tagline ? `Tagline: ${brand.tagline}` : '',
    brand.industry ? `Industry: ${brand.industry}` : '',
    brand.mission ? `Mission: ${brand.mission}` : '',
    brand.positioning ? `Positioning: ${brand.positioning}` : '',
    brand.brandTone ? `Brand tone: ${brand.brandTone}` : '',
    brand.voiceTone ? `Voice tone: ${brand.voiceTone}` : '',
    brand.keywords?.length ? `Themes to lean into: ${brand.keywords.join(', ')}` : '',
    brand.avoidWords?.length ? `Avoid: ${brand.avoidWords.join(', ')}` : '',
    brand.pillars?.length
      ? `Content pillars (pick ONE per idea when it fits):\n${brand.pillars.map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n')}`
      : '',
    platforms.length ? `Preferred platforms: ${platforms.join(', ')}` : '',
    '',
    'Each idea needs a sharp angle that would sound like THIS brand — not interchangeable agency filler.',
  ].filter(Boolean)
  return lines.join('\n')
}

// Coerce the model's output into a clean, safe array of idea objects.
function sanitize(raw, platforms) {
  const fallbackPlatform = platforms[0] || 'linkedin'
  const arr = Array.isArray(raw?.ideas) ? raw.ideas : []
  return arr
    .map((it) => {
      const title = typeof it?.title === 'string' ? it.title.trim() : ''
      if (!title) return null
      const platform = PLATFORM_IDS.includes(it?.platform) ? it.platform : fallbackPlatform
      const tags = Array.isArray(it?.tags)
        ? it.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 4)
        : []
      let description = typeof it?.description === 'string' ? it.description.trim() : ''
      let sourceUrl = ''
      const rawSource = typeof it?.sourceUrl === 'string' ? it.sourceUrl.trim() : (typeof it?.source === 'string' ? it.source.trim() : '')
      if (rawSource) {
        const urlMatch = rawSource.match(/https?:\/\/[^\s"'<]+/)
        sourceUrl = urlMatch ? urlMatch[0] : ''
        if (!sourceUrl && !rawSource.includes(' ')) {
           sourceUrl = 'https://' + rawSource
        }
      }
      return {
        title: title.slice(0, 140),
        description,
        angle: (typeof it?.angle === 'string' ? it.angle.trim() : '') || description.slice(0, 280),
        pillar: typeof it?.pillar === 'string' ? it.pillar.trim().slice(0, 80) : '',
        sourceUrl,
        tags,
        platform,
      }
    })
    .filter(Boolean)
    .slice(0, 3)
}

// The reply may wrap the JSON in a fence or a sentence - pull out the
// outermost {...} block and parse it.
function parseJsonBlock(text) {
  const t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : t
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return {} }
}

// --- OpenRouter + web-search plugin path --------------------------------------
// Claude Haiku 4.5 with live search results attached does the 2-3 idea cards.
// Override the model with SUGGEST_MODEL (any OpenRouter id) if ever needed —
// e.g. SUGGEST_MODEL=openai/gpt-4o-mini for a cheaper stream/idea run.
const SUGGEST_MODEL = () => process.env.SUGGEST_MODEL || HAIKU()
// Hard cap on stream topics kept / returned per client (1–5).
export const STREAM_MAX = () => Math.max(1, Math.min(5, Number(process.env.STREAM_MAX) || 5))
// How many live web results the stream pulls. Each result adds Exa cost + input
// tokens, so lowering this is the simplest cost knob. Bounded 1..5, default 3.
const STREAM_WEB_RESULTS = () => Math.max(1, Math.min(5, Number(process.env.STREAM_WEB_RESULTS) || 3))

// Rotating search angles: each refresh prioritises a couple of DIFFERENT facets
// of the client's field so the query (and the sites it hits) changes, instead of
// returning the same top headlines every time.
const STREAM_ANGLES = [
  'breaking news and recent announcements',
  'new tools, products, features, and launches',
  'company moves — funding, partnerships, acquisitions, leadership',
  'regulation, policy, ethics, and industry standards',
  'shifts in customer behaviour, adoption, and audience expectations',
  'expert opinions, debates, and contrarian takes',
  'new research, data, benchmarks, and studies',
  'practical how-tos, playbooks, and case studies',
]
// Pick n distinct angles at random (server-side, so Math.random is fine here).
const pickAngles = (n = 2) => {
  const pool = [...STREAM_ANGLES]
  const out = []
  for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  return out
}

async function suggestWithWeb({ topic, brand, platforms }) {
  const today = new Date().toISOString().slice(0, 10)
  const sys = `${SYS}

Today is ${today}. Live web-search results on the topic are attached to the message.
Ground the ideas in the LATEST relevant findings (prefer the last few months) - a fresh angle,
development or number makes an idea stronger - but NEVER invent stats or events the results
don't support.`

  const { text, cost } = await chatComplete({
    model: SUGGEST_MODEL(),
    temperature: 0.7,
    maxTokens: 1200,
    timeoutMs: 60000,
    // web plugin: OpenRouter searches the topic and attaches the results. Exa
    // engine + a low max_results cap keeps the search cost down.
    plugins: [{ id: 'web', engine: 'exa', max_results: 3 }],
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userPrompt({ topic, brand, platforms }) },
    ],
  })
  console.log(`[suggest] web-grounded via ${SUGGEST_MODEL()}${typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}`)
  return parseJsonBlock(text)
}

// --- Plain fallback (no web access, still OpenRouter + Haiku) ------------------
async function suggestPlain({ topic, brand, platforms }) {
  const { text } = await chatComplete({
    model: HAIKU(),
    temperature: 0.7, // a bit more creative than the brand extractor
    maxTokens: 1000,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: userPrompt({ topic, brand, platforms }) },
    ],
  })
  return parseJsonBlock(text)
}

// topic: string. client: the clients-table row (name/tagline/industry/socials/ref_documents).
export async function suggestIdeasForTopic(topic, client = {}) {
  const socials = Array.isArray(client.social_media_accounts) ? client.social_media_accounts : []
  const platforms = [...new Set(socials.map((s) => s?.platform).filter((p) => PLATFORM_IDS.includes(p)))]
  const rd = client.ref_documents && typeof client.ref_documents === 'object' ? client.ref_documents : {}
  const voices = Array.isArray(rd.voices) ? rd.voices : []
  const primary = voices.find((v) => v.kind === 'brand') || voices[0] || {}
  const pillars = (Array.isArray(rd.content_pillars) ? rd.content_pillars : [])
    .map((p) => ({ name: String(p?.name || p?.title || '').trim(), description: String(p?.description || '').trim() }))
    .filter((p) => p.name)
    .slice(0, 6)
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const brand = {
    name: client.name,
    tagline: client.tagline,
    industry: client.industry,
    mission: rd.mission || '',
    positioning: rd.identity?.positioning?.statement || '',
    brandTone: rd.brand_tone || '',
    voiceTone: list(primary.tone_attributes).join(', '),
    keywords: list(rd.keywords),
    avoidWords: list(rd.avoid_words),
    pillars,
  }
  const input = { topic, brand, platforms }

  // Prefer the web-grounded path; any failure falls back to a plain Haiku call
  // so the suggestions button never breaks.
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    try {
      const ideas = sanitize(await suggestWithWeb(input), platforms)
      if (ideas.length) return ideas
      console.warn('[suggest] web path returned no usable ideas - falling back to a plain Haiku call')
    } catch (e) {
      console.warn(`[suggest] web path failed (${e.message}) - falling back to a plain Haiku call`)
    }
  }
  return sanitize(await suggestPlain(input), platforms)
}

// --- Stream Generator --------------------------------------------------------

const STREAM_SYS = `You are a trends analyst for a brand's social media content.
You are given a profile of ONE specific client — built from their OWN website — and live web-search results, each with a real source URL.
Surface exactly up to 5 recent (roughly the last 30 days) news items, shifts, or trends in THIS client's industry/field that they could post about. Prefer quality over quantity — 3–5 solid items is fine.

HOW TO IDENTIFY THE CLIENT (this matters most):
- The client is defined by the profile below — their website, what they do, their themes — NOT by their brand name alone.
- Many companies share similar names. If a search result is about a DIFFERENT company that merely shares the client's name, IGNORE it entirely. Only keep news that fits the industry and description in the profile.

STRICT RULES — follow exactly:
- Base every headline ONLY on the attached web-search results. NEVER invent, estimate, or infer numbers, revenue, funding, percentages, dates, or names that are not explicitly stated in the source.
- These are INDUSTRY trends the client could post about — not news about the client itself.
- "url" MUST be copied EXACTLY from the attached result you used. Do not shorten it, guess it, or replace it with a homepage. If you are not certain of the exact URL, set "url" to an empty string.
- Prefer specific article/news URLs. Never use the client's own website as a source.

Return STRICT JSON only, matching exactly:
{
  "topics": [
    { "headline": "One-line factual headline", "url": "https://exact-source-url-from-the-results" }
  ]
}
No prose, no markdown, no commentary — just the JSON object.`

// The web plugin attaches the REAL source URLs it used as citation annotations.
// Those are our ground truth: a topic's link is only trusted if it matches one.
function citationUrlsFromRaw(raw) {
  const urls = new Set()
  const anns = raw?.choices?.[0]?.message?.annotations
  if (Array.isArray(anns)) {
    for (const a of anns) {
      const u = a?.url_citation?.url || a?.url
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u)
    }
  }
  return urls
}

async function suggestStreamWithWeb({ profileText, searchFocus, angles = [], excludeTitles = [] }) {
  const today = new Date().toISOString().slice(0, 10)
  const sys = `${STREAM_SYS}\n\nToday is ${today}. Live web-search results are attached.`
  const excludeBlock = excludeTitles.length
    ? `ALREADY SHOWN — do NOT repeat these or close variants; find genuinely DIFFERENT stories:\n${excludeTitles.slice(0, STREAM_MAX()).map((t) => `- ${t}`).join('\n')}`
    : ''
  const { text, raw, cost } = await chatComplete({
    model: SUGGEST_MODEL(),
    temperature: 0.5, // enough variety across refreshes; still grounded in results
    maxTokens: 700, // ~5 short headlines + urls — keep completion cheap
    timeoutMs: 60000,
    plugins: [{ id: 'web', engine: 'exa', max_results: STREAM_WEB_RESULTS() }],
    messages: [
      { role: 'system', content: sys },
      // Lead with the search intent (industry/themes + this round's angles, NOT
      // the brand name) so the web plugin's auto-query targets the client's field
      // and varies each refresh — then the website-derived profile as context.
      { role: 'user', content: [
        `Search the web for the latest (last ~30 days) news, shifts, and trends about: ${searchFocus}.`,
        angles.length ? `This round, prioritise these angles: ${angles.join('; ')}.` : '',
        '',
        profileText,
        excludeBlock ? `\n${excludeBlock}` : '',
        '',
        `Return at most ${STREAM_MAX()} DISTINCT stories from DIFFERENT sources — no two headlines about the same article or event. Only surface news that fits the client profile above. Do NOT search by the client's brand name, and ignore any company that merely shares that name.`,
      ].filter(Boolean).join('\n') }
    ]
  })
  const parsed = parseJsonBlock(text)
  const citationUrls = citationUrlsFromRaw(raw)
  console.log(`[stream] web-grounded via ${SUGGEST_MODEL()}${typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''} · focus "${searchFocus}"${angles.length ? ` · angles: ${angles.join(' / ')}` : ''} · ${citationUrls.size} source link(s)`)
  return { topics: Array.isArray(parsed?.topics) ? parsed.topics : [], citationUrls }
}

// Describe a source URL → { host, isDeep }. isDeep = has a real path (not just a
// homepage); used to reject bare-domain links when there are no citations to
// validate against.
function describeUrl(url) {
  try {
    const u = new URL(url)
    return { host: u.hostname.replace(/^www\./, ''), isDeep: u.pathname.replace(/\/+$/, '').length > 0 }
  } catch { return null }
}

// Build a compact "who is this client" profile from their OWN website: the
// stored brand identity (extracted from the site at onboarding) plus a fresh
// homepage read. This is what disambiguates the client from any same-named
// company when we search the web. Returns { profileText, searchFocus } — the
// searchFocus drives the query off industry + themes, NOT the brand name.
function buildClientProfile(client, rd, siteText) {
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const keywords = list(rd.keywords)
  const positioning = rd.identity?.positioning?.statement || rd.positioning || ''
  const profileText = [
    'ABOUT THE CLIENT (built from their own website — identify them by THIS, not their name alone):',
    client.name ? `- Name: ${client.name}` : '',
    client.website_url ? `- Website: ${client.website_url}` : '',
    client.industry ? `- Industry: ${client.industry}` : '',
    client.tagline ? `- Tagline: ${client.tagline}` : '',
    rd.mission ? `- Mission: ${rd.mission}` : '',
    positioning ? `- Positioning: ${positioning}` : '',
    keywords.length ? `- Key themes: ${keywords.join(', ')}` : '',
    siteText ? `- From their website: ${siteText}` : '',
  ].filter(Boolean).join('\n')
  const focusParts = [client.industry, ...keywords].filter(Boolean)
  const searchFocus = focusParts.length ? focusParts.join(', ') : (client.industry || "the client's industry")
  return { profileText, searchFocus }
}

// Normalise a headline for de-duplication: drop any trailing "[domain](url)"
// markdown link, lowercase, and collapse to alphanumeric words. `sig` is the
// first few words — a loose signature that catches lightly-reworded repeats.
export const stripLink = (s) => String(s || '').replace(/\s*\[[^\]]*\]\([^)]*\)\s*/g, ' ').trim()
const normHeadline = (s) => stripLink(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
export const headlineSig = (s) => normHeadline(s).split(' ').slice(0, 6).join(' ')

export async function suggestStreamTopics(client = {}, { excludeTitles = [] } = {}) {
  if (!process.env.OPENROUTER_API_KEY) return [] // Require OpenRouter for web search
  const max = STREAM_MAX()
  try {
    const rd = client.ref_documents || {}
    // Compact homepage snippet for disambiguation only (shorter = cheaper).
    const siteText = client.website_url ? await fetchSiteSummary(client.website_url, 400) : ''
    const { profileText, searchFocus } = buildClientProfile(client, rd, siteText)
    const angles = pickAngles(1)
    // Human-readable already-shown titles steer the model away from repeats.
    const excludeClean = excludeTitles.map(stripLink).filter(Boolean)
    const { topics, citationUrls } = await suggestStreamWithWeb({ profileText, searchFocus, angles, excludeTitles: excludeClean })

    const norm = (u) => String(u || '').replace(/\/+$/, '')
    const cites = new Set([...citationUrls].map(norm))
    // Seed the de-dupe sets with what's already on screen, so a refresh never
    // re-adds a story (or a same-source article) the user is already looking at.
    const seenSig = new Set(excludeTitles.map(headlineSig).filter(Boolean))
    const seenUrl = new Set()
    const out = []
    for (const t of topics) {
      const headline = String(t?.headline ?? t?.text ?? (typeof t === 'string' ? t : '')).trim()
      if (!headline) continue
      const url = String(t?.url || '').trim()
      const info = url ? describeUrl(url) : null

      // De-dupe: skip a lightly-reworded repeat, or a second headline citing the
      // same source URL (the usual cause of the "same story twice" rows).
      const sig = headlineSig(headline)
      const urlKey = url ? norm(url) : ''
      if (!sig || seenSig.has(sig)) continue
      if (urlKey && seenUrl.has(urlKey)) continue

      // Attach a link ONLY when we can trust it's real: it matches a returned
      // citation, or (when no citations came back) it's at least a specific
      // article URL rather than a bare homepage. Otherwise keep the headline
      // alone — no fabricated links.
      let realUrl = null
      if (info) {
        if (cites.has(norm(url))) realUrl = url
        else if (cites.size === 0 && info.isDeep) realUrl = url
      }
      seenSig.add(sig)
      if (urlKey) seenUrl.add(urlKey)
      out.push(realUrl ? `${headline} [${info.host}](${realUrl})` : headline)
      if (out.length >= max) break
    }
    return out
  } catch (e) {
    console.warn(`[suggest] stream generation failed (${e.message})`)
    return []
  }
}
