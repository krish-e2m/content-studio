import { colorFor, platformHasHandle, SOCIAL_OPTIONS, VOICE_POVS } from '../data.js'
import { normalizeUrl } from './util.js'

// Add cosmetic-only aliases the existing workspace UI reads (who/tag/accent).
// These are NOT stored - derived from the real DB columns on every load.
export function decorateClient(c) {
  return {
    ...c,
    who: c.contact_name || '',
    tag: c.tagline || 'Client',
    accent: colorFor(c.slug || c.name),
    logo: c.ref_documents?.logo_url || '',
  }
}

/* ---------- onboarding: option-name lookups + draft → DB row ---------- */
export const optName = (list, id) => list.find((o) => o.id === id)?.name || id
export const platformName = (id) => optName(SOCIAL_OPTIONS, id)
export const povName = (id) => optName(VOICE_POVS, id)

export const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
export const splitSamples = (s) => String(s || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)

// Editable fields shared by create (wizard) and edit (Brand Brain). No slug -
// the server generates a random one and it's never editable here.
export function buildClientFields(d) {
  const social = d.social_media_accounts
    .filter((s) => s.platform && (s.handle.trim() || s.url.trim()))
    .map((s) => ({ platform: s.platform, handle: platformHasHandle(s.platform) ? s.handle.trim() : '', url: normalizeUrl(s.url), connected: false }))
  const voices = d.ref.voices
    .filter((v) => v.name.trim() || v.tone.trim() || v.samples.trim() || v.doc?.url)
    .map((v) => ({
      kind: v.kind,
      name: v.name.trim() || `${v.kind.charAt(0).toUpperCase()}${v.kind.slice(1)} voice`,
      pov: v.pov,
      tone_attributes: splitList(v.tone),
      dos: splitList(v.dos),
      donts: splitList(v.donts),
      samples: splitSamples(v.samples),
      // custom voices are defined by an uploaded reference PDF instead
      doc: v.doc?.url ? { title: v.doc.title || 'Untitled', path: v.doc.path || '', url: v.doc.url } : null,
    }))
  const documents = d.ref.documents
    .filter((doc) => doc.url || doc.path)
    .map((doc) => ({ title: doc.title || 'Untitled', path: doc.path || '', url: doc.url || '' }))
  const content_pillars = (Array.isArray(d.ref.content_pillars) ? d.ref.content_pillars : [])
    .map((p) => ({
      name: String(p?.name || '').trim(),
      description: String(p?.description || '').trim(),
    }))
    .filter((p) => p.name)
    .slice(0, 6)
  return {
    name: d.name.trim(),
    contact_name: d.contact_name.trim(),
    tagline: d.tagline.trim(),
    industry: d.industry.trim(),
    website_url: normalizeUrl(d.website_url),
    social_media_accounts: social,
    ref_documents: {
      brand_tone: d.ref.brand_tone.trim(),
      mission: d.ref.mission.trim(),
      keywords: splitList(d.ref.keywords),
      avoid_words: splitList(d.ref.avoid_words),
      logo_scraped: d.ref.logo_scraped || '',
      logo_manual: d.ref.logo_manual || '',
      // resolved effective logo: manual overrides scraped
      logo_url: d.ref.logo_manual || d.ref.logo_scraped || '',
      identity: d.ref.identity || {},
      content_pillars,
      voices,
      documents,
    },
  }
}

// Merge an AI extraction result into a draft.ref (voice fields, voices list,
// and the nested identity).
export function mergeExtraction(ref, data, url) {
  const asStr = (v, fb) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' && v ? v : fb)
  // AI-derived brand/founder voices → the editor's voice-row shape
  const aiVoices = (Array.isArray(data.voices) ? data.voices : []).filter(
    (v) => v && (v.name || v.tone_attributes?.length || v.dos?.length || v.sample_posts?.length),
  )
  const voices = aiVoices.length
    ? aiVoices.map((v) => {
        const kind = v.kind === 'founder' || v.kind === 'custom' ? v.kind : 'brand'
        return {
          kind,
          // AI-drafted voices get a stable default name: the brand voice is
          // always "Brand Voice" (we drop the LLM's own label like
          // "Acme Brand"). Founder/custom keep any AI-suggested name.
          name: kind === 'brand' ? 'Brand Voice' : (v.name || ''),
          pov: v.pov || (kind === 'founder' ? 'first_person' : 'brand_we'),
          tone: (v.tone_attributes || []).join(', '),
          dos: (v.dos || []).join(', '),
          donts: (v.donts || []).join(', '),
          samples: (v.sample_posts || []).join('\n\n'),
          doc: null,
        }
      })
    : ref.voices
  const aiPillars = (Array.isArray(data.content_pillars) ? data.content_pillars : [])
    .map((p) => ({
      name: String(p?.name || p?.title || '').trim(),
      description: String(p?.description || p?.desc || '').trim(),
    }))
    .filter((p) => p.name)
    .slice(0, 6)
  return {
    ...ref,
    brand_tone: data.brand_tone || ref.brand_tone,
    mission: data.mission || ref.mission,
    keywords: asStr(data.keywords, ref.keywords),
    avoid_words: asStr(data.avoid_words, ref.avoid_words),
    content_pillars: aiPillars.length ? aiPillars : (ref.content_pillars || []),
    voices,
    identity: {
      positioning: data.positioning || {},
      colors: data.colors || {},
      typography: data.typography || {},
      wordmark: data.wordmark || {},
      source: 'ai',
      source_url: url,
    },
  }
}

// Overlay the headless-browser extractor's branding.json onto a ref (typically
// one already merged with the Groq voice pass). The browser engine reads the
// REAL painted page, so its colors / fonts / logo override the LLM's guesses;
// Groq still owns voice/tone/mission/voices + positioning copy + wordmark.
export function applyBrowserBranding(ref, branding, url, logoUrl) {
  const c = branding.colors || {}
  const t = branding.typography || {}
  const idn = ref.identity || {}

  // role colors → the editor's primary-swatch shape, de-duped by hex
  const seen = new Set()
  const primary = [
    c.primary && { name: 'Primary', hex: c.primary, role: 'primary' },
    c.secondary && { name: 'Secondary', hex: c.secondary, role: 'secondary' },
    c.accent && { name: 'Accent', hex: c.accent, role: 'accent' },
    c.background && { name: 'Background', hex: c.background, role: 'paper' },
    c.text && { name: 'Text', hex: c.text, role: 'ink' },
  ].filter((x) => x && x.hex && !seen.has(x.hex.toLowerCase()) && seen.add(x.hex.toLowerCase()))
  const roleHexes = new Set(primary.map((x) => x.hex.toLowerCase()))
  const supporting = (c.all || [])
    .filter((h) => h && !roleHexes.has(String(h).toLowerCase()))
    .slice(0, 8)
    .map((h) => ({ name: '', hex: h }))

  // typography: the Groq AI owns the font list (families + roles). We only fall
  // back to the page's browser-detected families if Groq returned none, so the
  // Type section is never empty.
  const browserFonts = []
  const pushFam = (family, role) => {
    const f = (family || '').trim()
    if (f && !browserFonts.some((x) => x.family.toLowerCase() === f.toLowerCase())) browserFonts.push({ family: f, role })
  }
  pushFam(t.heading?.family, 'Headings')
  pushFam(t.body?.family, 'Body')
  ;(t.fonts_used || []).forEach((f) => pushFam(f, ''))
  const groqFonts = Array.isArray(idn.typography?.fonts) ? idn.typography.fonts.filter((f) => f && f.family) : []
  const typography = groqFonts.length ? idn.typography : { fonts: browserFonts }

  return {
    ...ref,
    // prefer the extractor's captured logo; fall back to whatever was there
    logo_scraped: logoUrl || ref.logo_scraped || '',
    identity: {
      ...idn,
      // keep Groq's positioning copy; fall back to the page's own meta/tagline
      positioning: {
        tagline: idn.positioning?.tagline || branding.meta?.tagline || '',
        statement: idn.positioning?.statement || branding.meta?.description || '',
      },
      colors: { primary, supporting, rule: idn.colors?.rule || '' },
      typography,
      wordmark: idn.wordmark || {},
      source: 'ai',
      source_url: url,
    },
  }
}

// Create payload (server assigns slug + id + created_at).
export const draftToClient = (d) => ({ ...buildClientFields(d), status: 'onboarding' })

// Reverse: a saved client row → the editable draft shape (for the edit form).
export function clientToDraft(c) {
  const r = c.ref_documents || {}
  return {
    name: c.name || '',
    contact_name: c.contact_name || '',
    tagline: c.tagline || '',
    industry: c.industry || '',
    website_url: c.website_url || '',
    social_media_accounts: (c.social_media_accounts || []).map((s) => ({
      platform: s.platform || 'linkedin', handle: s.handle || '', url: s.url || '',
    })),
    ref: {
      brand_tone: r.brand_tone || '',
      mission: r.mission || '',
      keywords: (r.keywords || []).join(', '),
      avoid_words: (r.avoid_words || []).join(', '),
      // back-compat: an old row's single logo_url becomes the scraped baseline
      logo_scraped: r.logo_scraped || r.logo_url || '',
      logo_manual: r.logo_manual || '',
      identity: r.identity || {},
      content_pillars: (Array.isArray(r.content_pillars) ? r.content_pillars : [])
        .map((p) => ({ name: p?.name || '', description: p?.description || '' }))
        .filter((p) => p.name || p.description),
      voices: (r.voices || []).map((v) => ({
        kind: v.kind || 'brand', name: v.name || '', pov: v.pov || 'brand_we',
        tone: (v.tone_attributes || []).join(', '),
        dos: (v.dos || []).join(', '),
        donts: (v.donts || []).join(', '),
        samples: (v.samples || []).join('\n\n'),
        doc: v.doc || null,
      })),
      documents: (r.documents || []).map((doc) => ({ ...doc })),
    },
  }
}
