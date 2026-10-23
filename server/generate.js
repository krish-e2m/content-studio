// AI post-copy generation. ONE provider (OpenRouter), ONE model (Claude Haiku
// 4.5) — no Groq anywhere.
//
//  • Text: the Claude "brand brain" engine (engine.js) — the Claude Agent SDK
//    running Haiku 4.5 over OpenRouter in a per-client workspace materialized
//    from the brand documents. High fidelity: it reads the client's markdown
//    files the same way Claude Code does.
//  • Image: a direct OpenRouter chat-completions call to Haiku 4.5 with the
//    image attached (see generatePostContentFromImage), grounded in the same
//    brand context.
// A failure surfaces to the caller (the wizard falls back to a local template).

import { isEngineEnabled, generateWithEngine, formatSpec } from './engine.js'
import { chatComplete, HAIKU } from './openrouter.js'

const PLATFORM_GUIDE = {
  linkedin: 'Professional but human. A strong point of view, short paragraphs, line breaks for readability.',
  instagram: 'Warm, punchy and scannable. A caption voice; light emoji use is fine.',
  substack: 'Longer-form and essayistic, in a personal first-person voice.',
  email: 'A direct newsletter voice. Begin the body with a subject line on its own first line, prefixed exactly with "Subject: ".',
  x: 'Concise and punchy. May be a short thread separated by line breaks.',
}

// Flatten the client's brand identity + primary voice into prompt-ready lines.
function buildBrandContext(client = {}) {
  const rd = client.ref_documents || {}
  const voices = Array.isArray(rd.voices) ? rd.voices : []
  const primary = voices.find((v) => v.kind === 'brand') || voices[0] || {}
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const parts = []
  if (client.name) parts.push(`Brand: ${client.name}`)
  if (client.tagline) parts.push(`Tagline: ${client.tagline}`)
  if (client.industry) parts.push(`Industry: ${client.industry}`)
  if (rd.mission) parts.push(`Mission: ${rd.mission}`)
  if (rd.brand_tone) parts.push(`Brand tone: ${rd.brand_tone}`)
  if (list(primary.tone_attributes).length) parts.push(`Voice tone attributes: ${primary.tone_attributes.join(', ')}`)
  if (list(primary.dos).length) parts.push(`DO: ${primary.dos.join('; ')}`)
  if (list(primary.donts).length) parts.push(`DON'T: ${primary.donts.join('; ')}`)
  if (list(rd.keywords).length) parts.push(`Keywords to weave in naturally: ${rd.keywords.join(', ')}`)
  if (list(rd.avoid_words).length) parts.push(`Words/phrases to AVOID entirely: ${rd.avoid_words.join(', ')}`)
  const pillars = list(rd.content_pillars).filter((p) => p && (p.name || p.title))
  if (pillars.length) {
    parts.push(
      'Content pillars (serve ONE):\n' +
        pillars.slice(0, 6).map((p) => {
          const name = String(p.name || p.title || '').trim()
          const desc = String(p.description || '').trim()
          return desc ? `- ${name}: ${desc}` : `- ${name}`
        }).join('\n'),
    )
  }
  const samples = list(primary.samples).length ? primary.samples : list(primary.sample_posts)
  if (samples.length) parts.push(`Sample posts written in this brand voice (match their style):\n${samples.slice(0, 3).join('\n---\n')}`)
  return parts.join('\n')
}

// Selected brand documents → a bounded reference block. Budgeted the same way
// the text engine inlines docs (per-doc + total caps) so the image path grounds
// in a comparable slice of the brand brain, not just a couple of files.
function buildDocsContext(docs = []) {
  if (!docs.length) return ''
  const PER = 3000 // per-doc char cap
  const TOTAL = 16000 // total budget across all inlined docs
  const out = []
  let used = 0
  for (const d of docs.slice(0, 8)) {
    const content = String(d?.content || '').trim()
    if (!content) continue
    const room = Math.min(PER, TOTAL - used)
    if (room <= 0) break
    const capped = content.length > room ? `${content.slice(0, room)}\n\n…[truncated to fit the prompt budget]` : content
    used += capped.length
    out.push(`### ${d.name || 'Untitled'}\n${capped}`)
  }
  return out.join('\n\n')
}

// Editorial learnings (past feedback) → bullet lines the model must always
// apply. Mirrors the text engine's "Editorial learnings" section so the image
// path honours the same accumulated corrections/preferences.
function buildLearningsContext(learnings = []) {
  const items = (Array.isArray(learnings) ? learnings : [])
    .map((l) => String(l?.content || '').trim())
    .filter(Boolean)
    .slice(0, 30)
  return items.length ? items.map((c) => `- ${c}`).join('\n') : ''
}

export async function generatePostContent({ topic, note, platform, format, docs = [], client = {}, learnings = [], pillar, angle, polish }) {
  // The Claude brand-brain engine (Haiku 4.5 over OpenRouter) is the only text
  // path. A failure surfaces as an error (the engine already retries internally).
  if (!isEngineEnabled()) {
    throw new Error('Claude content engine is not configured — set ANTHROPIC_AUTH_TOKEN (OpenRouter) or ANTHROPIC_API_KEY.')
  }
  return generateWithEngine({ topic, note, platform, format, client, learnings, pillar, angle, polish })
}

// Image-grounded generation. Given an uploaded image (as a data-URL) plus the
// idea/topic + brand context, Claude Haiku 4.5 (over OpenRouter) writes ONE
// on-brand post that actually describes/references what the image shows,
// grounded in the same brand voice/rules + core brand documents as the text
// path. Throws on failure (the caller decides whether to fall back to a template).
export async function generatePostContentFromImage({ topic, note, platform, format, imageDataUrl, docs = [], client = {}, learnings = [] }) {
  if (!imageDataUrl) throw new Error('an image is required for image-based generation')

  const brand = buildBrandContext(client)
  const docsCtx = buildDocsContext(docs)
  const learnCtx = buildLearningsContext(learnings)
  const spec = formatSpec(platform, format)

  const instructions = `You are an expert social media copywriter for a content agency.
The attached image is the SUBJECT of this post. Study it carefully, then write ONE ${platform} post whose content is genuinely ABOUT what the image shows.
Rules:
- The post's subject and substance MUST come from the image: describe, lead with, or react to what is actually visible — the scene, product, people, on-image text, brand, numbers or claims. Never invent details that aren't in the image.
- The "Angle" below is an OPTIONAL steer, NOT the subject. Use it only if it genuinely fits what the image shows; if it is about something unrelated to the image, IGNORE it completely and write about the image.
- Use the brand voice, rules, documents and learnings ONLY for tone, style, terminology and guardrails — they define HOW to write, never WHAT the post is about.
- Match the brand voice, tone and point of view EXACTLY. Honour every DO and DON'T, never use the AVOID words, and weave brand keywords in naturally.
- Apply the editorial learnings below without exception.
${spec ? `- Format rules (follow EXACTLY — the length range is a hard requirement): ${spec}` : ''}
Your reply must be ONLY the finished post copy — no preamble, no commentary, no markdown fences, no hashtags, no surrounding quotes.`

  const context = [
    `Platform: ${platform}${PLATFORM_GUIDE[platform] ? ` — ${PLATFORM_GUIDE[platform]}` : ''}`,
    `Format: ${format || 'default'}`,
    topic ? `Angle (optional — ignore if unrelated to what the image shows): ${topic}` : '',
    note ? `Extra note: ${note}` : '',
    brand ? `\n--- BRAND VOICE & RULES (how to write — NOT the subject) ---\n${brand}` : '\n(No brand context configured - use a clear, professional voice.)',
    docsCtx ? `\n--- BRAND REFERENCE (voice & terminology only — NOT the subject) ---\n${docsCtx}` : '',
    learnCtx ? `\n--- EDITORIAL LEARNINGS (from past feedback — always apply) ---\n${learnCtx}` : '',
  ].filter(Boolean).join('\n')

  // One multimodal user message. Image FIRST (Anthropic's recommended ordering
  // for best grounding), then the instructions + brand context.
  const { text, usage, cost } = await chatComplete({
    model: HAIKU(),
    temperature: 0.7,
    maxTokens: 1200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: `${instructions}\n\n${context}` },
        ],
      },
    ],
  })

  const body = cleanCopy(text)
  // Prefer OpenRouter's reported cost; fall back to Haiku rate table from token usage.
  let costUsd = typeof cost === 'number' ? cost : undefined
  if (costUsd == null && usage) {
    const inTok = usage.prompt_tokens || usage.input_tokens || 0
    const outTok = usage.completion_tokens || usage.output_tokens || 0
    // anthropic/claude-haiku-4.5 ≈ $1 / $5 per 1M in/out
    costUsd = (inTok * 1 + outTok * 5) / 1e6
  }
  console.log(`[content] vision · ${HAIKU()}${costUsd != null ? ` · $${costUsd.toFixed(4)}` : ' · cost unknown'} · ${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out tok · grounded in ${docs.length} doc(s), ${learnings.length} learning(s)`)
  return { body, engine: 'openrouter', model: HAIKU(), costUsd, usage }
}

// The model is told to reply with ONLY the post copy; strip a stray
// <post></post> wrapper, code fence, or JSON {"body":…} envelope just in case.
function cleanCopy(text) {
  let t = String(text || '').trim()
  const tagged = t.match(/<post>\s*([\s\S]*?)\s*<\/post>/)
  if (tagged) t = tagged[1].trim()
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/)
  if (fence) t = fence[1].trim()
  if (/^\{[\s\S]*"body"\s*:/.test(t)) {
    try { const p = JSON.parse(t); if (typeof p.body === 'string') t = p.body.trim() } catch { /* leave as-is */ }
  }
  return t
}
