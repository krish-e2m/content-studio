// =============================================================================
// Claude "brand brain" generation engine — two modes, both via the Claude
// Agent SDK (the engine behind Claude Code):
//
//   • lean (default)  — ONE model call. The brand voice/rules + the relevant
//     platform playbook + the writing-relevant docs are assembled into a
//     compact system prompt; no Claude Code preset, no file-reading loop.
//     Cheapest + fastest, and still fully on-brand for a curated brain.
//
//   • agentic         — the full Claude Code loop: a per-client workspace of
//     CLAUDE.md + core/*.md + SKILL.md, and the model decides which files to
//     open (progressive disclosure). Highest fidelity, more tokens/latency.
//
// Pick with ENGINE_MODE=lean|agentic (default lean). This is the ONLY content
// path — no Groq, no fallback; a failure surfaces to the caller as an error.
// =============================================================================

import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordUsage } from './usage.js'
import { stripEmDashes } from './dashes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_TEMPLATES_DIR = join(__dirname, 'skills')
const WORKSPACES_ROOT = join(tmpdir(), 'content-engine', 'workspaces')

// Concrete, enforceable spec for every platform+format the UI offers (keys MUST
// match client/src/data.js exactly). The model is given the exact length + shape
// so "Single thought" and "Long-form article" can't come out the same size.
// Adding a NEW platform needs no entry here — formatSpec() falls back to a
// keyword heuristic (genericFormatSpec) when a platform/format has no entry.
const FORMAT_SPEC = {
  linkedin: {
    'Single thought': 'ONE punchy idea in 1–3 short sentences (~150–400 characters). No hook/body/close scaffolding and no lists — just the single thought, sharply put.',
    'Short-form post': 'A hook line, then 2–4 short paragraphs (1–3 lines each) and a one-line close. ~500–900 characters total.',
    'Long-form article': 'A strong hook, a multi-paragraph body developing ONE idea across clear sections (a short list is fine), and a grounded close. ~1,300–2,200 characters; never exceed ~2,600.',
  },
  instagram: {
    'Single caption': 'One caption, ~125–300 characters — warm, punchy, scannable. 0–2 emoji, only if the brand voice uses them.',
    'Carousel': 'A slide-by-slide breakdown labelled "Slide 1:" … "Slide N:" (5–8 slides, each 1–2 short lines; slide 1 is the hook, the last is the takeaway/CTA), then a short caption on its own line prefixed "Caption:".',
    'Reel script': 'A short spoken script (~15–30 seconds of voiceover). Start with a "Hook: " line, then the spoken lines written as plain sentences the creator reads aloud — one idea per line. You MAY add at most 2 light "[on-screen: …]" cues where a visual matters. Do NOT include timestamps (no "0–2s", "8–15s"), do NOT label lines with HOOK / VOICEOVER / SCENE, and do NOT write stage directions — just the hook line, the spoken lines, and up to two on-screen cues.',
  },
  substack: {
    'Short note': '1–3 short conversational paragraphs, ~400–800 characters. No title.',
    'Long-form essay': 'A titled first-person essay with several short sections, ~600–1,200 words. Put the title on its own first line prefixed "Title: ".',
  },
  email: {
    'Newsletter': 'Begin with the subject line on its own first line, prefixed exactly "Subject: ". Then a 200–500 word body in a direct newsletter voice, broken into short sections.',
    'Short broadcast': 'Begin with the subject line on its own first line, prefixed exactly "Subject: ". Then a single focused message of ~80–150 words.',
  },
  x: {
    'Single post': 'ONE post, at most 280 characters. One idea, no thread.',
    'Thread': 'A thread of 3–7 posts, each at most 280 characters, separated by a blank line. Post 1 is the hook; the last lands the takeaway. Do not number them.',
  },
}

// Keyword heuristic used when a platform+format has no explicit FORMAT_SPEC
// entry (e.g. a newly added platform). Infers length/shape from the format
// label so the length rule is still enforced without a hand-written entry.
function genericFormatSpec(format) {
  const f = String(format || '').toLowerCase()
  if (!f) return null
  if (/(thread|carousel|series)/.test(f)) return 'A multi-part piece: 3–7 short self-contained parts (part 1 is the hook, the last lands the takeaway), separated by blank lines.'
  if (/(reel|video|script)/.test(f)) return 'A short spoken script (~15–30 seconds of voiceover): a "Hook: " line, then plain spoken sentences the creator reads aloud (one idea per line), plus at most 2 light "[on-screen: …]" cues. No timestamps, no HOOK / VOICEOVER / SCENE labels, no stage directions.'
  if (/(long|article|essay|deep|guide|newsletter|blog)/.test(f)) return 'Long-form: a strong hook, a multi-paragraph body developing ONE idea across clear sections, and a grounded close (~250–500 words).'
  if (/(short|note|broadcast|snippet|quick|brief)/.test(f)) return 'Short: a hook and 2–4 short paragraphs, ~500–900 characters total.'
  if (/(single|thought|caption|tweet|post|update)/.test(f)) return 'One tight idea in 1–3 short sentences (~150–400 characters). No sectioning, no lists.'
  return null
}

// Look up the enforceable spec for a platform+format. Prefers an explicit
// FORMAT_SPEC entry; otherwise falls back to the keyword heuristic so any new
// platform/format still gets a length rule. null only if the label is empty.
export function formatSpec(platform, format) {
  return (FORMAT_SPEC[platform] || {})[format] || genericFormatSpec(format)
}

// The engine is on when we can reach an Anthropic-shaped API: a first-party
// ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN (+ optional ANTHROPIC_BASE_URL,
// e.g. https://openrouter.ai/api). This is the only content path — no fallback.
export function isEngineEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

// --- tunable config (env-driven, no code change needed) ----------------------
const DEFAULT_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'
// Stronger model for opt-in polish / long-form. Override with ANTHROPIC_POLISH_MODEL.
const POLISH_MODEL = () => process.env.ANTHROPIC_POLISH_MODEL || 'claude-sonnet-4-5'
// Formats that auto-use the polish model (still opt-in via polish:true or these labels).
const LONG_FORM_RE = /(long-form|long form|article|essay|newsletter)/i
export function resolveModel({ polish, format } = {}) {
  if (polish === true) return POLISH_MODEL()
  if (polish === false) return DEFAULT_MODEL()
  // Auto-bump only clearly long formats when polish is undefined and env allows it.
  if (process.env.ENGINE_AUTO_POLISH_LONGFORM === '1' && LONG_FORM_RE.test(String(format || ''))) {
    return POLISH_MODEL()
  }
  return DEFAULT_MODEL()
}
// Attempts before giving up. There is NO Groq fallback for content generation,
// so a couple of retries keep reliability up when a call is transiently flaky
// or returns empty/negligible output.
const MAX_ATTEMPTS = () => Math.max(1, Number(process.env.ENGINE_MAX_ATTEMPTS) || 2)
const ENGINE_MODE = () => (process.env.ENGINE_MODE || 'lean').toLowerCase()
const EFFORT = () => (process.env.ANTHROPIC_EFFORT || 'medium').toLowerCase() // low|medium|high|xhigh|max
const MAX_TURNS = () => Number(process.env.ANTHROPIC_MAX_TURNS) || 8
// Per-document character cap for inlined brand files (lean mode). This bounds
// the single biggest, most variable cost driver: without it, one large doc
// (e.g. a project-plan skill) inflates every prompt. ~4000 chars ≈ ~1k tokens.
const DOC_CHAR_CAP = () => Number(process.env.ENGINE_DOC_CHAR_CAP) || 4000
// Total character budget across ALL inlined docs (lean mode) — a second guard
// so a client with many docs can't balloon the prompt even when each doc is
// under the per-doc cap. Least-relevant docs (see docRank) are trimmed/dropped
// first; voice + rules always make the cut.
const DOC_TOTAL_CAP = () => Number(process.env.ENGINE_DOC_TOTAL_CAP) || 16000

// --- real cost accounting ----------------------------------------------------
// The Claude Agent SDK reports `total_cost_usd` using ANTHROPIC's price table.
// That is correct for native Claude models but WRONG when we route a non-Anthropic
// model (e.g. openai/gpt-4o-mini) through OpenRouter's Anthropic-compatible
// endpoint — it can over-report by ~30x. So we price the call ourselves from the
// real token usage against the table below (USD per 1M tokens, in/out). Override
// for any model with ENGINE_PRICE_IN / ENGINE_PRICE_OUT (USD per 1M tokens).
const PRICES = {
  'openai/gpt-4o-mini': { in: 0.15, out: 0.60 },
  'openai/gpt-4o': { in: 2.5, out: 10 },
  'anthropic/claude-haiku-4.5': { in: 1, out: 5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic/claude-sonnet-4.5': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'anthropic/claude-opus-4.1': { in: 15, out: 75 },
  'google/gemini-2.5-flash': { in: 0.30, out: 2.5 },
}

function priceFor(model) {
  const envIn = Number(process.env.ENGINE_PRICE_IN)
  const envOut = Number(process.env.ENGINE_PRICE_OUT)
  if (envIn > 0 || envOut > 0) return { in: envIn || 0, out: envOut || 0 }
  const key = String(model || '')
  return PRICES[key] || PRICES[key.toLowerCase()] || null
}

// Real USD cost from token usage. Returns null when we have no rate for the model
// (the caller then falls back to the SDK's figure). Cache tokens are priced at
// the input rate — a small conservative overestimate only when caching is active.
function computeCostUsd(model, usage) {
  const p = priceFor(model)
  if (!p || !usage) return null
  const input = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
  const output = usage.output_tokens || 0
  return (input * (p.in || 0) + output * (p.out || 0)) / 1e6
}

// Write this generation to the per-client spend ledger.
//
// The Agent SDK offers no way to set OpenRouter's `user` field, so these calls
// land in OpenRouter's own books UNTAGGED — which is why the ledger, not their
// analytics API, is the source the Users & access spend column reads. This is
// also the app's main text path, so skipping it would under-report most of what
// a client actually costs.
//
// provider is read from the base URL rather than assumed: the same code bills
// OpenRouter credits when ANTHROPIC_BASE_URL points there and Anthropic
// directly when it doesn't.
function recordEngineSpend({ model, usage, computed, sdkCost }) {
  const viaOpenRouter = /openrouter\.ai/i.test(process.env.ANTHROPIC_BASE_URL || '')
  recordUsage({
    provider: viaOpenRouter ? 'openrouter' : 'anthropic',
    model,
    costUsd: computed ?? sdkCost,
    // computed wins over the SDK's figure (see computeCostUsd above), so name
    // whichever one actually produced the number.
    costSource: computed != null ? 'estimate.tokens' : sdkCost != null ? 'agent-sdk.total_cost_usd' : null,
    usage: usage || {},
  })
}

// --- path helpers ------------------------------------------------------------
const slugify = (s) =>
  String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// A doc's folder tag → a safe relative dir ("Core Files" → "core-files"; empty → docs/).
const tagToDir = (tag) => {
  const parts = String(tag || '').split('/').map(slugify).filter(Boolean)
  return parts.length ? parts.join('/') : 'docs'
}

// Resolve a platform's built-in skill folder by CONVENTION — no hand-maintained
// map. Tries skills/<platform>-post then skills/<platform>. Returns the folder
// name (used as both the template source and the workspace subdir) or null. A
// new platform "just works" the moment you drop a skills/<platform>-post/ dir —
// and still works with no folder at all (generic playbook below).
function resolveSkillDir(platform) {
  const id = slugify(platform)
  if (!id) return null
  for (const cand of [`${id}-post`, id]) {
    if (existsSync(join(SKILL_TEMPLATES_DIR, cand, 'SKILL.md'))) return cand
  }
  return null
}

// Generic playbook used when a platform has no SKILL.md yet. Keeps a newly
// added platform fully working (brand voice + format rules still apply) until
// you optionally add a bespoke skills/<platform>-post/SKILL.md for higher fidelity.
function genericPlaybook(platform) {
  const name = String(platform || 'this platform')
  return [
    `# ${name} post playbook (generic)`,
    '',
    `Write for ${name} in the brand voice. Open with a hook that earns attention on its own first line, keep to ONE idea, use short paragraphs and line breaks, and close with a grounded takeaway.`,
    'Follow the Format rules in the brief for exact length and shape. No hashtags in the body. Never invent facts, names, stats or links — ground every claim in the brand material.',
  ].join('\n')
}

// Writing-relevance rank for an inlined doc (lower = more important). Used to
// spend the total prompt budget on voice/rules first and trim reference docs
// (business info, brand design, big project-plan skills) first.
// Folder path is part of `rel` (e.g. skills/foo.md, audience/buyer.md), so
// custom folders the client adds still rank sensibly.
const docRank = (rel) => {
  const s = String(rel || '').toLowerCase()
  // Architecture / project-plan dumps (often dropped into skills/) — last in line
  if (/\b(project[-_]?plan|architecture|mermaid|system[-_]?arch|roadmap|tech[-_]?spec)\b/.test(s)) return 9
  if (/(^|\/)assets(\/|$)/.test(s)) return 8
  if (/voice|tone/.test(s)) return 0
  if (/founder/.test(s)) return 1
  if (/persona|audience/.test(s)) return 2
  if (/content-rule|rules|guardrail|do-?nt|playbook/.test(s)) return 3
  if (/offer|pricing|product|promo|proof|testimonial|case[-_]?stud/.test(s)) return 4
  if (/(^|\/)skills?(\/|$)/.test(s)) return 4 // writing playbooks in skills/
  if (/business-info|brand-design|mission|positioning/.test(s)) return 5
  if (/research|competitor|market|inspiration/.test(s)) return 6
  // Any custom folder the client creates — still inlinable, mid priority
  return 5
}

const isClaudeMdDoc = (doc) => /^claude(\.md)?$/i.test(String(doc?.name || '').trim())
const isSkillTag = (tag) => /^skills?$/i.test(String(tag || '').trim())
const hasFrontmatter = (content) => /^---\n/.test(String(content || ''))
const stripFrontmatter = (s) => String(s || '').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

// first meaningful line of a doc → a one-line hint / description
function docHint(content) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s`]+/, '').trim())
    .find(Boolean) || ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

// --- brand manual (shared by both modes) -------------------------------------
// The identity / voice / hard-rules / learnings sections, built from the
// client's structured guideline. Used verbatim in CLAUDE.md (agentic) and in
// the lean system prompt.
function brandManualSections(client, learnings = []) {
  const rd = client.ref_documents || {}
  const voices = list(rd.voices)
  const L = []

  const facts = []
  if (client.tagline) facts.push(`- **Tagline:** ${client.tagline}`)
  if (client.industry) facts.push(`- **Industry:** ${client.industry}`)
  if (rd.mission) facts.push(`- **Mission:** ${rd.mission}`)
  if (rd.identity?.positioning?.statement) facts.push(`- **Positioning:** ${rd.identity.positioning.statement}`)
  if (facts.length) L.push('## The brand', '', ...facts, '')

  // Content pillars (3–6 themes the brand always returns to). Prefer these when
  // picking a story angle so drafts aren't generic "thought leadership."
  const pillars = list(rd.content_pillars).filter((p) => p && (p.name || p.title))
  if (pillars.length) {
    L.push('## Content pillars', '')
    L.push('Every piece should clearly serve ONE of these pillars (name it in your thinking; do not label it in the post unless natural):', '')
    for (const p of pillars.slice(0, 6)) {
      const name = String(p.name || p.title || '').trim()
      const desc = String(p.description || p.desc || '').trim()
      L.push(desc ? `- **${name}:** ${desc}` : `- **${name}**`)
    }
    L.push('')
  }

  if (rd.brand_tone || voices.length) {
    L.push('## Voice', '')
    if (rd.brand_tone) L.push(rd.brand_tone, '')
    for (const v of voices) {
      const name = v.name || (v.kind === 'founder' ? 'Founder voice' : 'Brand voice')
      L.push(`### ${name} (${v.kind || 'brand'} · ${v.pov === 'first_person' ? 'first person' : 'brand "we"'})`)
      if (list(v.tone_attributes).length) L.push(`- Tone: ${v.tone_attributes.join(', ')}`)
      if (list(v.dos).length) L.push(`- DO: ${v.dos.join('; ')}`)
      if (list(v.donts).length) L.push(`- DON'T: ${v.donts.join('; ')}`)
      const samples = list(v.samples).length ? v.samples : list(v.sample_posts)
      // Few-shot: up to 3 samples beats a model upgrade for voice match.
      if (samples.length) {
        L.push('', 'Samples in this voice (match their rhythm and diction):', '')
        for (const s of samples.slice(0, 3)) {
          L.push('> ' + String(s).replace(/\n/g, '\n> '), '')
        }
      }
      L.push('')
    }
  }

  const rules = [
    "Match the brand voice EXACTLY — honour every DO and DON'T above and in content-rules.",
    'Ground every factual claim in the provided material. NEVER invent facts, stats, names, offers or links.',
    'NO hashtags anywhere in the copy — they are managed separately.',
    'NO em dashes (\u2014) anywhere in the copy, and no spaced en dash (\u2013) in their place. Use a comma, colon, full stop or parentheses, or split the sentence.',
    "Write in the brand's language, never generic marketing filler.",
    'Commit to ONE concrete story angle or point of view — not a vague theme summary.',
    'BANNED filler (never use): "In today\'s fast-paced…", "Let\'s dive in", "game-changer", "unlock", "elevate your", "leverage", "synergy", "in a world where", "It\'s not just X, it\'s Y", "At the end of the day", "Here\'s the thing:", empty rhetorical questions as openers.',
  ]
  if (list(rd.keywords).length) rules.push(`Weave these themes in naturally (never stuff them): ${rd.keywords.join(', ')}.`)
  if (list(rd.avoid_words).length) rules.push(`NEVER use these words/phrases: ${rd.avoid_words.join(', ')}.`)
  L.push('## Hard rules', '', ...rules.map((r) => `- ${r}`), '')

  if (learnings.length) {
    L.push('## Editorial learnings (from past feedback — always apply)', '')
    for (const it of learnings) L.push(`- ${String(it.content || '').trim()}`)
    L.push('')
  }
  return L
}

// Human-readable token line for logs — makes it obvious WHY a call was cheap or
// dear (big input prompt vs long output vs cache hits).
function fmtUsage(u) {
  if (!u) return ''
  const i = u.input_tokens || 0
  const o = u.output_tokens || 0
  const cr = u.cache_read_input_tokens || 0
  const cc = u.cache_creation_input_tokens || 0
  const extra = [cr ? `${cr} cache-read` : '', cc ? `${cc} cache-write` : ''].filter(Boolean).join(', ')
  return ` · ${i} in / ${o} out${extra ? ` / ${extra}` : ''} tok`
}

// --- shared query runner -----------------------------------------------------
// Runs one query() and returns the final text plus any files the agent Read.
async function runQuery(prompt, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000) // hard stop at 4 min
  let result = ''
  let lastAssistantText = ''
  let costUsd = null
  let usage = null
  const reads = []
  try {
    for await (const message of query({ prompt, options: { ...options, abortController: controller } })) {
      if (message.type === 'assistant') {
        const parts = message.message?.content
        if (Array.isArray(parts)) {
          const text = parts.filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text.trim()) lastAssistantText = text
          for (const b of parts) {
            if (b.type === 'tool_use' && ['Read', 'Glob', 'Grep'].includes(b.name)) {
              const p = b.input?.file_path || b.input?.path || b.input?.pattern || ''
              if (p) reads.push(String(p))
            }
          }
        }
      } else if (message.type === 'result') {
        if (message.usage) usage = message.usage
        if (typeof message.total_cost_usd === 'number') costUsd = message.total_cost_usd
        if (message.subtype === 'success' && typeof message.result === 'string') result = message.result
        else if (message.is_error) throw new Error(message.result || `generation ended: ${message.subtype}`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { text: result || lastAssistantText, reads, costUsd, usage }
}

// Strip a wrapping <post></post> (preferred) or ``` fence from the reply, then
// scrub any em dashes the model used despite the hard rule.
function cleanBody(text) {
  let t = String(text || '').trim()
  const tagged = t.match(/<post>\s*([\s\S]*?)\s*<\/post>/)
  if (tagged) return stripEmDashes(tagged[1].trim())
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/)
  if (fence) t = fence[1].trim()
  return stripEmDashes(t)
}

// The task instruction shared by both modes.
function taskPrompt({ platform, format, topic, note, pillar, angle }, closing) {
  const spec = format ? formatSpec(platform, format) : null
  const angleLine = angle || note
  return [
    `Write ONE ${platform} post for this brand.`,
    format ? `Format: ${format}` : '',
    spec ? `Format rules — follow EXACTLY; the length range is a hard requirement, not a suggestion: ${spec}` : '',
    `Topic: ${topic}`,
    pillar ? `Content pillar to serve: ${pillar}` : '',
    angleLine
      ? `Story angle / POV (commit to this): ${angleLine}`
      : 'Story angle / POV: choose ONE sharp, concrete angle for this topic (not a vague overview). Prefer a named content pillar when pillars are listed above.',
    '',
    closing,
    'Before you finish, verify the draft matches the Format rules above (length and shape) and that it has a clear POV — not generic agency filler. Your final reply must wrap the finished post body in <post></post> tags — inside them ONLY the post copy: no preamble, no commentary, no surrounding quotes, no markdown fences, no hashtags.',
  ].filter(Boolean).join('\n')
}

// =============================================================================
// LEAN mode — one call, everything inlined, no tools/loop/preset.
// =============================================================================
function buildLeanSystem(client, learnings, { inline, skipped, skillText, platform }) {
  const L = []
  L.push(`# ${client.name || 'Brand'} — Brand Brain`, '')
  L.push(`You are writing client-facing content for this brand. Everything you need is in this prompt — the brand voice, the hard rules, the ${platform} playbook, and the reference documents below. They are the source of truth.`, '')
  L.push(...brandManualSections(client, learnings))
  if (skillText) L.push(`## ${platform} playbook`, '', stripFrontmatter(skillText), '')
  if (inline.length) {
    L.push('## Reference documents (source of truth — do not contradict these)', '')
    for (const f of inline) L.push(`### ${f.rel}`, '', f.content.trim(), '')
  }
  if (skipped.length) L.push(`_Other brand files exist but aren't needed for writing: ${skipped.join(', ')}._`, '')
  L.push('## How to write', '')
  L.push('- Apply the voice and hard rules exactly. Ground every claim in the material above — never invent facts, names, stats, or links.')
  L.push('- Lead with a specific angle. Sound like this brand — not a generic LLM content mill.')
  L.push('- Do not ask questions or narrate your process. Just write the post.')
  return L.join('\n')
}

async function generateLean({ topic, note, platform, format, client, learnings = [], pillar, angle, polish }) {
  const model = resolveModel({ polish, format })
  const docs = Array.isArray(client.documents) ? client.documents : []
  const perCap = DOC_CHAR_CAP()
  const totalCap = DOC_TOTAL_CAP()
  const inline = [] // writing-relevant docs, inlined within the prompt budget
  const skipped = [] // everything else, mentioned by name only

  // Every brand-doc folder is a candidate (core, skills, audience, offers,
  // proof, research, assets, AND any custom folder the client adds). Budget +
  // docRank decide what actually fits — huge project plans get truncated or
  // name-only so they don't crowd out voice/rules.
  const candidates = []
  for (const d of docs) {
    const content = String(d?.content || '')
    if (!content.trim() || isClaudeMdDoc(d)) continue
    const rel = `${tagToDir(d.tag)}/${slugify(d.name) || 'untitled'}.md`
    candidates.push({ rel, content })
  }
  candidates.sort((a, b) => docRank(a.rel) - docRank(b.rel))

  let used = 0
  for (const c of candidates) {
    const room = Math.min(perCap, totalCap - used)
    if (room <= 0) { skipped.push(c.rel); continue } // budget spent — name only
    const capped = c.content.length > room
      ? `${c.content.slice(0, room)}\n\n…[truncated to fit the prompt budget]`
      : c.content
    used += capped.length
    inline.push({ rel: c.rel, content: capped })
  }

  let skillText = ''
  const skillName = resolveSkillDir(platform)
  if (skillName) {
    try { skillText = await readFile(join(SKILL_TEMPLATES_DIR, skillName, 'SKILL.md'), 'utf8') } catch { /* optional */ }
  }
  if (!skillText.trim()) skillText = genericPlaybook(platform) // new platform w/o a SKILL.md still gets structure

  const system = buildLeanSystem(client, learnings, { inline, skipped, skillText, platform })
  const prompt = taskPrompt({ platform, format, topic, note, pillar, angle }, 'Everything you need is in the system prompt above.')

  const { text, costUsd, usage } = await runQuery(prompt, {
    model,
    systemPrompt: system, // plain string → NO claude_code preset
    settingSources: [], // don't load anything from disk
    allowedTools: [],
    disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Skill'],
    maxTurns: 1,
    // short social posts don't need extended reasoning — disabling thinking cuts
    // the biggest cost (thinking is billed as output tokens). The whole brand
    // brain is already in the prompt, so the model just writes.
    thinking: { type: 'disabled' },
  })

  // Prefer the cost we compute from real token usage (accurate for the model
  // actually billed); fall back to the SDK's figure only when we have no rate.
  const computed = computeCostUsd(model, usage)
  const realCost = computed ?? costUsd
  recordEngineSpend({ model, usage, computed, sdkCost: costUsd })
  const filesRead = inline.map((f) => f.rel)
  console.log(`[engine] lean via ${model}${realCost != null ? ` · $${realCost.toFixed(4)}` : ' · cost unknown'}${fmtUsage(usage)} · used ${filesRead.length} brand file(s): ${filesRead.join(', ') || '(guideline only)'}`)
  const body = cleanBody(text)
  if (!body || body.trim().length < 20) throw new Error('The engine returned no/negligible content')
  return { body, engine: 'claude', model, mode: 'lean', filesRead, costUsd: realCost, usage }
}

// =============================================================================
// AGENTIC mode — full Claude Code loop over a materialized workspace.
// =============================================================================
function buildClaudeMd(client, files, learnings = []) {
  const L = []
  L.push(`# ${client.name || 'Brand'} — Brand Brain`, '')
  L.push('You are writing client-facing content for this brand. This file is the always-on manual; the reference files listed below are the source of truth — read the relevant ones before writing.', '')
  L.push(...brandManualSections(client, learnings))
  if (files.length) {
    L.push('## Reference files (read the relevant ones before writing)', '')
    for (const f of files) L.push(`- \`${f.path}\`${f.hint ? ` — ${f.hint}` : ''}`)
    L.push('')
  }
  L.push('## Workflow', '')
  L.push('1. Read the reference files relevant to the brief (voice + persona at minimum).')
  L.push('2. If a platform skill playbook exists in `.claude/skills/`, follow it for structure and format; otherwise follow the Format rules in the brief.')
  L.push("3. Draft, then re-check against the Hard rules and the voice DON'Ts before answering.")
  return L.join('\n')
}

// Write the client's brand brain to a FRESH per-run directory. Seeds ONLY the
// platform-relevant built-in skill (fewer files → cheaper/faster); client-
// authored skills (docs tagged "skills") are written during the docs loop and
// are never overwritten.
export async function materializeWorkspace(client, learnings = [], platform) {
  const dir = join(WORKSPACES_ROOT, String(client.id), randomBytes(6).toString('hex'))
  await mkdir(dir, { recursive: true })

  const docs = Array.isArray(client.documents) ? client.documents : []
  const files = []
  let claudeMdOverride = null

  for (const doc of docs) {
    const content = String(doc?.content || '')
    if (!content.trim()) continue
    if (isClaudeMdDoc(doc)) { claudeMdOverride = content; continue }
    if (isSkillTag(doc.tag)) {
      const slug = slugify(doc.name) || 'skill'
      // Project plans / architecture dumps often land in skills/ — treat them as
      // reference markdown, not Claude skills (those are for writing playbooks).
      const looksLikePlan = /\b(project[-_]?plan|architecture|mermaid|system|roadmap|tech[-_]?spec)\b/i.test(String(doc.name || ''))
        || /\b(project plan|system architecture)\b/i.test(content.slice(0, 240))
      if (looksLikePlan) {
        const rel = `skills/${slug}.md`
        const abs = join(dir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content, 'utf8')
        files.push({ path: rel, hint: docHint(content) })
        continue
      }
      const body = hasFrontmatter(content)
        ? content
        : `---\nname: ${slug}\ndescription: ${docHint(content) || doc.name}\n---\n\n${content}`
      const skillDir = join(dir, '.claude', 'skills', slug)
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8')
      continue
    }
    const rel = `${tagToDir(doc.tag)}/${slugify(doc.name) || 'untitled'}.md`
    const abs = join(dir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    files.push({ path: rel, hint: docHint(content) })
  }

  // seed ONLY the relevant platform playbook, and only if the client didn't
  // author a skill with the same folder name.
  const skillName = resolveSkillDir(platform)
  if (skillName) {
    const target = join(dir, '.claude', 'skills', skillName)
    if (!existsSync(join(target, 'SKILL.md'))) {
      try {
        await mkdir(target, { recursive: true })
        await copyFile(join(SKILL_TEMPLATES_DIR, skillName, 'SKILL.md'), join(target, 'SKILL.md'))
      } catch { /* template missing — skip */ }
    }
  }

  await writeFile(
    join(dir, 'CLAUDE.md'),
    claudeMdOverride || buildClaudeMd(client, files, learnings),
    'utf8',
  )
  return dir
}

async function generateAgentic({ topic, note, platform, format, client, learnings = [], pillar, angle, polish }) {
  const model = resolveModel({ polish, format })
  const cwd = await materializeWorkspace(client, learnings, platform)
  try {
    const skill = resolveSkillDir(platform)
    const prompt = taskPrompt(
      { platform, format, topic, note, pillar, angle },
      skill
        ? `Use the "${skill}" skill playbook (.claude/skills/${skill}/SKILL.md). Read the reference files listed in CLAUDE.md that are relevant to this brief before writing.`
        : 'Read the reference files listed in CLAUDE.md that are relevant to this brief before writing.',
    )

    const { text, reads, costUsd, usage } = await runQuery(prompt, {
      cwd,
      model,
      systemPrompt: { type: 'preset', preset: 'claude_code' }, // loads CLAUDE.md as project context
      settingSources: ['project'], // workspace-local only; never the host's ~/.claude
      allowedTools: ['Read', 'Glob', 'Grep', 'Skill'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
      maxTurns: MAX_TURNS(),
      effort: EFFORT(),
    })

    // report only files that actually exist and were opened, as clean paths
    const base = realpathSync(cwd)
    const filesRead = [...new Set(reads)]
      .map((p) => { try { return relative(base, realpathSync(p)) } catch { return null } })
      .filter((rel) => rel && !rel.startsWith('..') && rel !== 'CLAUDE.md')
    const computed = computeCostUsd(model, usage)
    const realCost = computed ?? costUsd
    recordEngineSpend({ model, usage, computed, sdkCost: costUsd })
    console.log(`[engine] agentic via ${model} (effort=${EFFORT()}, maxTurns=${MAX_TURNS()})${realCost != null ? ` · $${realCost.toFixed(4)}` : ' · cost unknown'}${fmtUsage(usage)} · read ${filesRead.length} file(s): ${filesRead.join(', ') || '(CLAUDE.md only)'}`)

    const body = cleanBody(text)
    if (!body || body.trim().length < 20) throw new Error('The engine returned no/negligible content')
    return { body, engine: 'claude', model, mode: 'agentic', filesRead, costUsd: realCost, usage }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

// --- entry point (generate.js calls this) ------------------------------------
// Runs the configured mode with retries (no Groq fallback). A failed or
// negligible-output attempt is retried up to MAX_ATTEMPTS before throwing.
export async function generateWithEngine(args) {
  const run = () => (ENGINE_MODE() === 'agentic' ? generateAgentic(args) : generateLean(args))
  const attempts = MAX_ATTEMPTS()
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await run()
    } catch (e) {
      lastErr = e
      if (i < attempts) console.warn(`[engine] attempt ${i}/${attempts} failed (${e.message}); retrying`)
    }
  }
  throw lastErr
}
