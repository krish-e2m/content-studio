// =========================================================================
// OpenRouter chat-completions client (OpenAI-compatible). ONE provider, ONE
// default model — Claude Haiku 4.5 — for every AI task in the app. There is no
// Groq path anywhere; a failure surfaces to the caller.
//
// Auth + base URL reuse the same env the Claude engine uses:
//   ANTHROPIC_BASE_URL   e.g. https://openrouter.ai/api
//   OPENROUTER_API_KEY   (or ANTHROPIC_AUTH_TOKEN) — an sk-or-… key
// Model override: OPENROUTER_MODEL (defaults to anthropic/claude-haiku-4.5).
// =========================================================================
import './load-env.js'
import { recordUsage, usageTag } from './usage.js'

const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'

// The single content model, in OpenRouter slug form. Callers pass this (or nothing).
export const HAIKU = () => process.env.OPENROUTER_MODEL || DEFAULT_MODEL

function endpoint() {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://openrouter.ai/api').replace(/\/+$/, '')
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

function apiKey() {
  const k = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  if (!k) throw new Error('OpenRouter is not configured — set OPENROUTER_API_KEY (or ANTHROPIC_AUTH_TOKEN) in server/.env')
  return k
}

// Run one chat-completions call. Returns { text, usage, cost, raw }. `tools`
// carries OpenRouter server tools (e.g. openrouter:web_search), which run on
// OpenRouter's side and come back as url_citation annotations on the message.
//
// Every call is tagged with the OpenRouter `user` field for the client it was
// made for and its billed cost is written to the ai_usage ledger — see
// server/usage.js. Both come from the request-scoped context, so callers pass
// nothing; `feature` is only for the rare call made outside a request scope.
export async function chatComplete({ model, messages, temperature = 0.7, maxTokens = 1200, responseFormat, tools, timeoutMs = 90000, feature } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tag = usageTag()
  let r
  try {
    r = await fetch(endpoint(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey()}`,
        'content-type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://contentstudio.local',
        'X-Title': 'Content Studio',
      },
      body: JSON.stringify({
        model: model || HAIKU(),
        temperature,
        max_tokens: maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        // Always ask OpenRouter for usage/cost so we can log $ on every call.
        usage: { include: true },
        // Whose spend this is (client_<uuid>). OpenRouter reports it back as the
        // `user` dimension of its analytics API, which is how per-client spend
        // is answerable from their side and not only from our own ledger.
        ...(tag ? { user: tag } : {}),
        ...(tools ? { tools } : {}),
        messages,
      }),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 300)}`)
  }
  const json = await r.json()
  const msg = json.choices?.[0]?.message?.content
  const text = Array.isArray(msg)
    ? msg.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
    : String(msg || '')
  recordUsage({
    feature,
    model: json.model || model || HAIKU(),
    costUsd: json.usage?.cost,
    usage: json.usage || {},
    generationId: json.id,
  })
  return { text, usage: json.usage || {}, cost: json.usage?.cost, raw: json }
}

// Pull the outermost {...} JSON block out of a reply (handles code fences and
// stray prose). Anthropic has no native JSON mode, so we parse defensively
// rather than trusting response_format. Returns {} if nothing parses.
export function parseJsonBlock(text) {
  const t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : t
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return {} }
}
