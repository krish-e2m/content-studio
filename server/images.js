// =============================================================================
// AI image generation via OpenRouter (Gemini image models). Turns a free-text
// idea + a set of "guardrail" controls (style / mood / aspect / brand palette)
// into a well-engineered image prompt, optionally conditions on reference
// images, and returns base64 data-URL image(s).
//
// Guardrails keep client-facing output on-brand and predictable: the dropdowns
// map to fixed prompt fragments (below) rather than letting the model roam.
// =============================================================================
import { recordUsage, usageTag } from './usage.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
// Nano-Banana (Gemini 2.5 Flash Image) is the proven, cheap default: takes
// reference images as input and returns an image. Override with any OpenRouter
// image-output model via OPENROUTER_IMAGE_MODEL.
const DEFAULT_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image'

// --- guardrail vocabularies -------------------------------------------------
// id → prompt fragment. The client mirrors these ids in its dropdowns; unknown
// ids are ignored (treated as "auto"), so adding a new option is one entry here
// plus one in the client list.

export const STYLE_PRESETS = {
  auto: '',
  photographic:
    'A photorealistic photograph shot on a full-frame DSLR with a 50mm f/1.8 lens. Pin-sharp focus on the main subject, crisp micro-detail, lifelike textures, true-to-life color. Background may be softly blurred — the subject must stay razor-clear.',
  illustration:
    'A clean, modern flat vector illustration with confident shapes, smooth gradients, sharp edges and balanced negative space.',
  render3d:
    'A polished 3D render with soft global illumination, subtle ambient occlusion, physically based materials, crisp surface detail and gentle shadows.',
  watercolor:
    'A delicate hand-painted watercolor with soft bleeding edges, visible paper texture and layered washes.',
  lineart: 'Minimal, single-weight line art with clean confident strokes on a plain, uncluttered background.',
  minimalist:
    'A refined minimalist composition with generous negative space, a restrained palette and one clear focal point.',
  cinematic:
    'A cinematic film still with dramatic composition, film-grade color grading, razor-sharp subject focus and natural motion-picture lighting.',
  isometric: 'A tidy isometric illustration with consistent 2:1 perspective, clean edges and soft shading.',
}

// Framing / shot-type guardrail (id → prompt fragment).
export const COMPOSITION_PRESETS = {
  auto: '',
  closeup: 'Tight close-up shot with the subject filling the frame.',
  portrait: 'Portrait framing centered on the subject with a pleasant background blur.',
  wide: 'Wide establishing shot with plenty of environmental context.',
  flatlay: 'Overhead flat-lay composition looking straight down, neatly arranged.',
  product: 'Clean product shot with the subject centered on an uncluttered surface, tack-sharp focus on the product.',
}

// Styles that should read as real photography get the stronger anti-artifact
// negative baseline (the usual "AI look" tells); everything else gets a light one.
const PHOTO_STYLES = new Set(['photographic', 'cinematic', 'auto'])
const PHOTO_NEGATIVES =
  'blurry, soft focus, out of focus, motion blur, smeared subject, distorted proportions, extra limbs, extra fingers, deformed or fused hands, mutated features, plastic or waxy skin, over-smoothed, oversaturated, harsh HDR, low resolution, pixelated, noisy grain, compression artifacts, watermark, signature, text overlays, jpeg artifacts, uncanny, AI-generated look'
const BASE_NEGATIVES =
  'blurry, soft focus, out of focus, low resolution, pixelated, noisy, muddy details, distorted, watermark, signature, text overlays, jpeg artifacts'

// --- text-first styles (infographics) ----------------------------------------
// These invert several photo-era assumptions: text is REQUIRED (so the "text
// overlays" negative would sabotage the output), composition/lighting presets
// are photographic and must be skipped, and the palette is assigned by design
// role rather than "accent" vs "strict".
const TEXT_STYLES = new Set(['infographic'])

// The prompt is layered so we only pay for (and only ship) what applies:
//   CORE        — structural rules true of every infographic. Always sent.
//   DEFAULT_LOOK— an opinionated house style. Sent ONLY when the user's own
//                 description names no style, so it can never blend with one.
//   PRECEDENCE  — backstop for a detector miss; only meaningful next to
//                 DEFAULT_LOOK, so it ships only alongside it.
const INFOGRAPHIC_CORE =
  'A clean, minimal infographic — not a photograph, and not a dense data-journalism poster. Most infographics online are text-heavy with paragraph blocks and cluttered multi-panel diagrams; explicitly avoid that. One bold headline at the top, then clearly separated sections on a strict grid with generous whitespace — match the section count to what the description actually asks for, and if the source content has many sub-points, pick the 3–5 most important and drop the rest rather than cramming everything in. Each section gets one short label (a few words) and at most one simple icon — never stack or cluster multiple icons, never nest boxes inside boxes, never add connecting arrows between more than one pair of elements. Body copy under each section must be brief: one short sentence or phrase, never more than roughly 12–15 words — this is a scannable graphic, not an article. If the description supplies longer explanatory text, compress it down to its essential point rather than reproducing it in full. Any typography or font guidance in the brand instructions describes how text should look, never what the text should say — do not render font names, style notes, or guideline text as visible words in the image. Every word must be real, correctly spelled and legible at thumbnail size. No background decorations, no filler graphics, no floating shapes, no scattered charts. The background must be plain and unbroken. Flat and clean: no photographic elements, no 3D, no drop shadows, no gradients.'

const INFOGRAPHIC_PRECEDENCE =
  'If the description above names a visual style, that style governs the entire image — apply it consistently and do not blend it with any other look.'

const INFOGRAPHIC_DEFAULT_LOOK =
  'Default look (the description above did not specify one): a solid light background with dark high-contrast text and one single accent color used sparingly for numbers and thin rules. A large display serif headline, geometric sans-serif body text. Hairline rules between zones, simple rounded-rectangle cards with plenty of padding, and minimal single-stroke icons — one per section maximum. Let whitespace dominate; do not fill empty areas.'

// NEW — always sent alongside a brand palette, independent of STYLE_CUE, so a
// user-named style never causes brand colors to read as washed-out or token.
const INFOGRAPHIC_PALETTE_WEIGHT =
  'Give the accent color real visual presence: use it for numbers, icons, thin dividing rules, and small card-fill tints — not just a token touch. The background and text roles should carry the bulk of the contrast.'

// Does the user's description already name a visual style? Deterministic and
// free (no model call). A miss is caught by PRECEDENCE; a false positive just
// means the model leans on the user's own wording — which they did provide.
const STYLE_CUE =
  /\b(hand[- ]?drawn|sketch\w*|doodle|marker|ink|serif|sans|typewriter|editorial|magazine|newspaper|blueprint|chalkboard|whiteboard|retro|vintage|y2k|brutalis\w+|swiss|bauhaus|memphis|corporate style|corporate look|playful style|neon|cyberpunk|isometric|gradient\w*|glassmorph\w+|dark[- ]?mode|dark background|black background|outline|line[- ]?art|watercolou?r|collage|paper[- ]?cut|risograph|halftone|in the style of|styled like)\b/i
// Note what's ABSENT vs the photo baselines: "text overlays" — an infographic
// is text. The negatives target garbled type and messy layout instead.
const TEXT_NEGATIVES =
  'verbose, verbose text, verbose paragraphs, gibberish text, misspelled words, garbled or invented letterforms, duplicated or overlapping labels, unreadable micro-text, dense paragraphs, lorem ipsum, cluttered layout, stacked or clustered icons, multiple icons per section, background decorations, floating shapes, scattered charts, pie charts, bar graphs used as filler, decorative borders, busy patterns, textured backgrounds, 3D bevels, drop shadows, photographic textures, watermark, signature, low resolution, pixelated, jpeg artifacts'

export const LIGHTING_PRESETS = {
  auto: '',
  bright: 'Bright, airy lighting with soft highlights and an upbeat feel.',
  moody: 'Moody, low-key lighting with deep shadows and rich contrast.',
  warm: 'Warm golden-hour lighting with a cozy glow.',
  studio: 'Clean studio lighting on a smooth seamless backdrop.',
  natural: 'Soft, diffuse natural daylight.',
  highcontrast: 'High-contrast, dramatic lighting with crisp edges.',
}

// id → { label, phrase } — phrase is dropped into the prompt as the aspect
// instruction. (Gemini 2.5 Flash Image honors composition guidance in the
// prompt rather than a separate size parameter over OpenRouter.)
export const ASPECT_PRESETS = {
  square: '1:1 square',
  portrait: '4:5 vertical portrait',
  story: '9:16 tall vertical (story/reel)',
  landscape: '16:9 wide landscape',
  auto: '',
}

// id → the ratio string the image model's `image_config.aspect_ratio` accepts.
// This is what ACTUALLY controls the output dimensions (the prompt text alone
// does not - the model would just letterbox a square). 'auto' omits it.
const ASPECT_RATIO = {
  square: '1:1',
  portrait: '4:5',
  story: '9:16',
  landscape: '16:9',
  auto: '',
}

const MAX_REFERENCES = 4
const MAX_COUNT = 4
const MAX_PROMPT = 2000
// Cap the brand-guideline text folded in from selected instruction docs, so a
// long SOP can't crowd out the actual subject in the prompt. Sized to fit a
// full brand skill (palette + typography + wordmark + marks) without truncation.
const MAX_GUIDELINES = 3200

// Turn selected markdown instruction docs into a compact, plain-text guideline
// string the image model can follow. Strips markdown noise (headings, code
// fences, links, images, list markers) and caps the total length.
export function documentsToGuidelines(documents) {
  if (!Array.isArray(documents)) return ''
  const parts = documents
    .filter((d) => d && typeof d.content === 'string' && d.content.trim())
    .map((d) => {
      const name = (typeof d.name === 'string' ? d.name : 'Document').trim() || 'Document'
      const body = d.content
        .replace(/```[\s\S]*?```/g, ' ') // code fences
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
        .replace(/^[ \t]*[#>*+\-]+[ \t]*/gm, '') // heading / quote / list markers
        .replace(/[*_`~]+/g, '') // inline emphasis
        .replace(/\s+/g, ' ')
        .trim()
      return body ? `${name}: ${body}` : ''
    })
    .filter(Boolean)
  let out = parts.join(' | ')
  if (out.length > MAX_GUIDELINES) out = out.slice(0, MAX_GUIDELINES).trim() + '…'
  return out
}

// Remove colour guidance from a markdown brand doc, for when the studio's
// "Use on-brand colors" toggle is off. Drops whole sections whose heading names
// a colour or palette (core/brand-design keeps its colour rule inside those
// sections), plus any other line that carries a hex / rgb / hsl value. The rest
// of the doc (voice, typography, wordmark) still guides the image.
const COLOR_HEADING = /colou?r|palette/i
const COLOR_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i
export function stripColorGuidance(markdown) {
  const out = []
  let dropLevel = 0 // depth of the colour section being dropped; 0 = keeping lines
  for (const line of String(markdown || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      if (dropLevel && level > dropLevel) continue // sub-heading of a dropped section
      dropLevel = COLOR_HEADING.test(heading[2]) ? level : 0
      if (dropLevel) continue
    } else if (dropLevel || COLOR_VALUE.test(line)) {
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
}

// Compose the final image prompt from the free-text idea + guardrails. The
// order matters: subject first, then medium/style, framing, light, palette,
// a quality clause, and finally an explicit "avoid" clause that merges the
// user's negatives with a style-aware anti-artifact baseline (this is what
// keeps photographic output looking real rather than obviously AI-generated).
//
// Text-first styles (infographic) invert several photo-era assumptions:
//   — Text labels are REQUIRED (so "text overlays" in negatives would sabotage)
//   — Composition/lighting presets are photographic concepts and are skipped
//   — Palette is assigned by design role (bg / text / accent), not "soft" vs "strict"
//   — The prompt is layered: structural core (always) + default look (only when
//     the user names no style) + palette roles (only when brandColors exist)
export function buildPrompt({ prompt, style, composition, lighting, aspect, brandColors, brandColorsOff, guidelines, avoid, logo, hasReferences, hasLogoImage }) {
  const parts = []
  const userText = String(prompt || '').trim()
  const isText = TEXT_STYLES.has(style)
  // Toggle off: colour values are already stripped from the guidelines, but a
  // colour can still be named in prose ("wordmark in Acme Red"), so say it outright.
  const colorsOffClause = brandColorsOff
    ? `Brand colors are switched off for this image: do not steer the colors toward the brand's palette or any color named in the brand guidelines; use whatever colors suit the subject naturally.${hasLogoImage ? ' The attached brand logo keeps its original colors.' : ''}`
    : ''

  // ── TEXT-FIRST BRANCH (infographic) ────────────────────────────────────
  if (isText) {
    // Reference images for infographics are LAYOUT references, not person
    // references — skip the "match this person" preamble.
    if (hasReferences) {
      parts.push(
        'Use the attached reference image(s) as layout and style inspiration only — match the visual structure, color feel, and typography style, but create completely original content. Then create the following:',
      )
    }

    // Layer A — structural core. Always sent.
    parts.push(INFOGRAPHIC_CORE)

    // User's description — placed after the core so it refines rather than
    // getting overridden.
    parts.push(userText)

    // Layer B + B′ — default look + precedence backstop.
    // Sent ONLY when the user's description names no visual style.
    const userSpecifiesStyle = STYLE_CUE.test(userText)
    if (!userSpecifiesStyle) {
      parts.push(INFOGRAPHIC_DEFAULT_LOOK)
      parts.push(INFOGRAPHIC_PRECEDENCE)
    }

    // Aspect — still needed; infographics have a shape.
    const aspectPhrase = ASPECT_PRESETS[aspect]
    if (aspectPhrase)
      parts.push(
        `Output the image in a ${aspectPhrase} aspect ratio. This is the required output format and takes priority over any other aspect ratios or dimensions mentioned elsewhere in these instructions — always produce the image, never refuse over a ratio mismatch.`,
      )

    // Layer C — role-based palette. Only when brandColors is non-empty.
    const palette = Array.isArray(brandColors)
      ? brandColors.map((h) => String(h || '').trim()).filter((h) => /^#[0-9a-fA-F]{3,8}$/.test(h)).slice(0, 8)
      : []
     if (palette.length) {
      const logoExempt = hasLogoImage ? ' The attached brand logo is the only exception — keep its original colors.' : ''
      parts.push(
        `Build the entire design from this brand color palette: ${palette.join(', ')}. Assign by role — the lightest tone becomes the page background, the darkest becomes the body text, and the most saturated becomes the single accent used for icons, rules, numbers and emphasis, with soft pale tints of that accent for card fills. Where the palette lacks a light or dark enough tone for a role, substitute a low-saturation off-white or a near-black neutral. Introduce no hue outside this palette.${logoExempt}`,
      )
      parts.push(INFOGRAPHIC_PALETTE_WEIGHT) // NEW
    }

    // Guidelines
    const guide = String(guidelines || '').trim()
    if (guide) {
      parts.push(`Follow these brand and visual guidelines wherever visually relevant: ${guide}`)
    }
    if (colorsOffClause) parts.push(colorsOffClause)

    // Logo — same logic as photo styles
    if (logo === true && hasLogoImage) {
      parts.push(
        "The final attached image is the brand's official logo. Composite that exact logo into the scene — keep its shape, proportions, and colors unchanged; do not redraw, restyle, recolor, crop, or duplicate it. Place it in the top-right corner, small and unobtrusive, with clear padding from the edges, unless the description above requests a specific placement. This overrides any \"no logo\" or \"avoid logos\" guidance elsewhere. Add no other logos, wordmarks, captions, or text.",
      )
    } else if (logo === true) {
      parts.push(
        "Include the brand's own logo or wordmark, rendered per the brand's wordmark guidelines, placed small and unobtrusive in the top-right corner unless the description above requests a specific placement. This is explicitly requested and overrides any \"no logo\" or \"avoid logos\" guidance elsewhere. Do not invent an unrelated logo, and add no other text or captions.",
      )
    } else if (logo === false) {
      parts.push('Do not include any logo, wordmark, brand name, watermark, or added text anywhere in the image.')
    } else {
      parts.push('Do not add any watermarks or logos unless explicitly requested.')
    }

    // Layer D — text-style negatives (no "text overlays" — it IS text).
    const negatives = [String(avoid || '').trim(), TEXT_NEGATIVES].filter(Boolean).join(', ')
    parts.push(`Avoid: ${negatives}.`)

    return parts.filter(Boolean).join(' ')
  }

  // ── PHOTO / ILLUSTRATION BRANCH (original pipeline) ────────────────────
  if (hasReferences) {
    parts.push(
      'Use the attached reference image(s) as visual guidance for the main person\'s appearance (hair, age range, clothing vibe) and overall look. Create an original new photograph inspired by that reference — do not copy the reference pixel-for-pixel. Then create the following scene:',
    )
  }

  parts.push(userText)

  const stylePhrase = STYLE_PRESETS[style]
  if (stylePhrase) parts.push(stylePhrase)

  const compPhrase = COMPOSITION_PRESETS[composition]
  if (compPhrase) parts.push(compPhrase)

  const lightPhrase = LIGHTING_PRESETS[lighting]
  if (lightPhrase) parts.push(lightPhrase)

  const aspectPhrase = ASPECT_PRESETS[aspect]
  if (aspectPhrase)
    parts.push(
      `Output the image in a ${aspectPhrase} aspect ratio. This is the required output format and takes priority over any other aspect ratios or dimensions mentioned elsewhere in these instructions — always produce the image, never refuse over a ratio mismatch.`,
    )

  const palette = Array.isArray(brandColors)
    ? brandColors.map((h) => String(h || '').trim()).filter((h) => /^#[0-9a-fA-F]{3,8}$/.test(h)).slice(0, 8)
    : []
  if (palette.length) {
    const logoExempt = hasLogoImage ? ' The attached brand logo is the only exception — keep its original colors.' : ''
    if (hasReferences || composition === 'portrait' || style === 'photographic') {
      // Soft palette: accent the brand without recoloring skin / product realism.
      parts.push(
        `Accent the composition with this brand color palette where it fits naturally (backgrounds, props, wardrobe accents, graphic elements): ${palette.join(', ')}. Do NOT recolor skin tones, hair, product materials, or photorealistic reference subjects to force-fit the palette — preserve natural colors from reference images.${logoExempt}`,
      )
    } else {
      parts.push(
        `Use ONLY this brand color palette — it strictly governs every color in the image: ${palette.join(', ')}. These brand colors are mandatory and take strict priority over any other colors named in the description or implied by the subject. The only additional colors permitted are neutral black, white, and grey, and only where needed for contrast or legibility.${logoExempt}`,
      )
    }
  }

  // Portrait / people mode — keep realism without identity-lock wording that
  // some image models refuse (returns text, no image).
  if (composition === 'portrait' && hasReferences) {
    parts.push(
      'Portrait framing. Keep a natural resemblance to the person in the reference (similar age, hair, general look). Professional portrait quality, natural skin texture, no plastic or over-smoothed skin. Always output an image.',
    )
  } else if (composition === 'portrait') {
    parts.push(
      'Professional portrait quality with natural skin texture — no plastic or over-smoothed skin, no beauty-filter look. Always output an image.',
    )
  } else if (hasReferences) {
    parts.push('Always output a finished image (not text-only). Keep the person looking natural and clear.')
  }

  const guide = String(guidelines || '').trim()
  if (guide) {
    parts.push(`Follow these brand and visual guidelines wherever visually relevant: ${guide}`)
  }
  if (colorsOffClause) parts.push(colorsOffClause)

  // Quality / clarity clause — always push for a sharp, usable social asset.
  const isPhoto = PHOTO_STYLES.has(style)
  parts.push(
    isPhoto
      ? 'CRITICAL CLARITY: ultra-detailed, 8K-quality look, razor-sharp focus on the main subject, crisp edges, clean contrast, realistic textures and lighting, natural imperfections, high dynamic range, professional and social-media ready. Do not deliver a soft, hazy, or low-resolution image.'
      : 'CRITICAL CLARITY: crisp, high-detail, sharp edges, clean contrast, well-composed, professional and social-media ready. No soft, muddy, or low-resolution output.',
  )
  // Logo handling. The "Add logo" toggle is authoritative: ON explicitly
  // requests the brand mark (overriding any "avoid logos" guidance from the
  // brand doc); OFF forbids it; undefined keeps the neutral default.
  if (logo === true && hasLogoImage) {
    parts.push(
      "The final attached image is the brand's official logo. Composite that exact logo into the scene — keep its shape, proportions, and colors unchanged; do not redraw, restyle, recolor, crop, or duplicate it. Place it in the top-right corner, small and unobtrusive, with clear padding from the edges, unless the description above requests a specific placement. This overrides any \"no logo\" or \"avoid logos\" guidance elsewhere. Add no other logos, wordmarks, captions, or text.",
    )
  } else if (logo === true) {
    parts.push(
      "Include the brand's own logo or wordmark, rendered per the brand's wordmark guidelines, placed small and unobtrusive in the top-right corner unless the description above requests a specific placement. This is explicitly requested and overrides any \"no logo\" or \"avoid logos\" guidance elsewhere. Do not invent an unrelated logo, and add no other text or captions.",
    )
  } else if (logo === false) {
    parts.push('Do not include any logo, wordmark, brand name, watermark, or added text anywhere in the image.')
  } else {
    parts.push('Do not add any text, captions, watermarks or logos unless explicitly requested.')
  }

  // Merge the user's avoid text with the style-aware negative baseline. When a
  // logo is requested, drop logo/text tells from the baseline so they don't
  // fight the explicit instruction above.
  const baseline = isPhoto ? PHOTO_NEGATIVES : BASE_NEGATIVES
  const negatives = [String(avoid || '').trim(), baseline].filter(Boolean).join(', ')
  parts.push(`Avoid: ${negatives}.`)

  return parts.filter(Boolean).join(' ')
}

// Normalize whatever shape OpenRouter/Gemini put the image in → a data URL
// (or https URL the browser can still display). Providers disagree on casing
// and nesting (image_url vs imageUrl, string vs object, b64_json, etc.).
function extractImageUrl(message) {
  const msg = message && typeof message === 'object' ? message : {}
  const candidates = []

  const push = (v) => {
    if (typeof v === 'string' && v.trim()) candidates.push(v.trim())
  }
  const fromEntry = (entry) => {
    if (!entry) return
    if (typeof entry === 'string') return push(entry)
    if (typeof entry !== 'object') return
    push(entry.image_url?.url)
    push(entry.imageUrl?.url)
    push(entry.url)
    push(entry.b64_json)
    push(entry.data)
    // Rare: nested { image_url: "data:..." }
    if (typeof entry.image_url === 'string') push(entry.image_url)
    if (typeof entry.imageUrl === 'string') push(entry.imageUrl)
  }

  if (Array.isArray(msg.images)) msg.images.forEach(fromEntry)

  const content = msg.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'image_url' || part.type === 'image') fromEntry(part)
      if (part.inline_data?.data) {
        const mime = part.inline_data.mime_type || part.inline_data.mimeType || 'image/png'
        push(`data:${mime};base64,${part.inline_data.data}`)
      }
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || part.inlineData.mime_type || 'image/png'
        push(`data:${mime};base64,${part.inlineData.data}`)
      }
    }
  } else if (typeof content === 'string') {
    const m = content.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/)
    if (m) push(m[0])
  }

  for (const raw of candidates) {
    if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw
    // Bare base64 → assume PNG
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s/g, '').length > 80) {
      return `data:image/png;base64,${raw.replace(/\s/g, '')}`
    }
  }
  return null
}

function refusalText(message) {
  const msg = message && typeof message === 'object' ? message : {}
  const c = msg.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .join(' ')
      .trim()
  }
  return ''
}

// Call OpenRouter once and return a base64 data-URL string, or throw.
// `imageConfig` (e.g. { aspect_ratio: '16:9' }) controls the output dimensions.
async function generateOne({ key, model, content, imageConfig }) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 90_000)
  const tag = usageTag()
  let r
  try {
    r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // OpenRouter attribution headers (optional but recommended).
        'HTTP-Referer': 'https://content-engine.e2m',
        'X-Title': 'Content Engine',
      },
      body: JSON.stringify({
        model,
        modalities: ['image', 'text'],
        usage: { include: true },
        // Whose credits this burns (client_<uuid>) — see server/usage.js. Image
        // generation is by far the dearest call in the app, so leaving it
        // untagged would lose most of the per-client spend.
        ...(tag ? { user: tag } : {}),
        ...(imageConfig ? { image_config: imageConfig } : {}),
        messages: [{ role: 'user', content }],
      }),
    })
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Image generation timed out' : 'Could not reach the image service')
  } finally {
    clearTimeout(t)
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Image model ${r.status}: ${body.slice(0, 300)}`)
  }
  const json = await r.json()
  const msg = json.choices?.[0]?.message || {}
  let url = extractImageUrl(msg)
  // Some providers return a hosted URL — fine for the browser preview; the
  // save path already accepts https when re-fetched, but the studio expects
  // something displayable. Keep https as-is.
  if (!url) {
    const why = refusalText(msg).slice(0, 280)
    const keys = Object.keys(msg).join(',') || 'none'
    console.warn(`[images] no image in response · message keys: ${keys} · text: ${why.slice(0, 120) || '(empty)'}`)
    throw new Error(
      why
        ? `No image returned: ${why}`
        : 'The model did not return an image. Try a shorter prompt, Portrait composition, or re-add the reference photo.',
    )
  }
  if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) {
    throw new Error('The model returned an unusable image payload')
  }
  // Studio "Save" expects a data URL — fetch hosted URLs once here.
  if (/^https?:\/\//i.test(url)) {
    try {
      const ir = await fetch(url)
      if (!ir.ok) throw new Error(`fetch ${ir.status}`)
      const ct = (ir.headers.get('content-type') || 'image/png').split(';')[0].trim()
      const buf = Buffer.from(await ir.arrayBuffer())
      if (!buf.length) throw new Error('empty image')
      url = `data:${ct};base64,${buf.toString('base64')}`
    } catch (e) {
      throw new Error(`Could not download generated image (${e.message})`)
    }
  }
  // OpenRouter's usage.cost (with usage.include=true) is the actual billed USD
  // for this request — not an estimate we invent.
  const usage = json.usage || {}
  const costUsd = typeof usage.cost === 'number' ? usage.cost : null
  // One row per image: each is its own billed OpenRouter request, so recording
  // them individually keeps the ledger's totals exact rather than rolled up.
  recordUsage({
    feature: 'image-gen',
    model: json.model || model,
    costUsd,
    usage,
    generationId: json.id,
  })
  return {
    url,
    costUsd,
    usage: {
      cost: costUsd,
      prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
      // Native provider accounting when OpenRouter exposes it (image gens often
      // bill via output-image tokens rather than text completion tokens).
      native: usage.native_tokens_prompt != null || usage.native_tokens_completion != null
        ? {
            prompt: usage.native_tokens_prompt ?? null,
            completion: usage.native_tokens_completion ?? null,
            reasoning: usage.native_tokens_completion_reasoning ?? null,
          }
        : null,
    },
  }
}

// Generate `count` images for one guardrailed prompt. References are passed
// through verbatim (public URLs or data: URLs both work as image_url input).
// Uses allSettled so a partial failure still returns whatever succeeded.
export async function generateImages({
  prompt,
  style = 'auto',
  composition = 'auto',
  lighting = 'auto',
  aspect = 'square',
  brandColors = [],
  useBrandColors,
  documents = [],
  avoid = '',
  logo,
  logoUrl,
  references = [],
  count = 1,
} = {}) {
  // The studio's "Use on-brand colors" toggle. Off means no palette AND no
  // colour guidance smuggled in through the auto-attached brand docs.
  // (undefined = an older caller; keep the previous behaviour.)
  const colorsOff = useBrandColors === false
  if (colorsOff) {
    brandColors = []
    documents = (Array.isArray(documents) ? documents : []).map((d) =>
      d && typeof d.content === 'string' ? { ...d, content: stripColorGuidance(d.content) } : d,
    )
  }
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in the .env file')

  const cleanPrompt = String(prompt || '').trim().slice(0, MAX_PROMPT)
  if (!cleanPrompt) throw new Error('a prompt is required')

  const refs = (Array.isArray(references) ? references : [])
    .filter((u) => typeof u === 'string' && /^(https?:\/\/|data:image\/)/.test(u))
    .slice(0, MAX_REFERENCES)

  // The client's actual logo, fed as an extra reference so the model composites
  // the real mark rather than inventing one. Only when the toggle is on and a
  // logo URL was resolved (public bucket URL or data URL both work as input).
  const logoRef =
    logo === true && typeof logoUrl === 'string' && /^(https?:\/\/|data:image\/)/.test(logoUrl.trim())
      ? logoUrl.trim()
      : ''

  const finalPrompt = buildPrompt({
    prompt: cleanPrompt,
    style,
    composition,
    lighting,
    aspect,
    brandColors,
    brandColorsOff: colorsOff,
    guidelines: documentsToGuidelines(documents),
    avoid,
    logo: typeof logo === 'boolean' ? logo : undefined,
    hasReferences: refs.length > 0,
    hasLogoImage: !!logoRef,
  })

  const content = [{ type: 'text', text: finalPrompt }]
  for (const url of refs) content.push({ type: 'image_url', image_url: { url } })
  // Logo goes last so the prompt can refer to it as "the final attached image".
  if (logoRef) content.push({ type: 'image_url', image_url: { url: logoRef } })

  // Aspect ratio is enforced via image_config (the actual dimension control),
  // not just the prompt text. 'auto' omits it and lets the model default.
  const ratio = ASPECT_RATIO[aspect]
  const imageConfig = ratio ? { aspect_ratio: ratio } : undefined

  const model = DEFAULT_MODEL
  const n = clampInt(count, 1, MAX_COUNT, 1)
  const palette = Array.isArray(brandColors)
    ? brandColors.map((h) => String(h || '').trim()).filter((h) => /^#[0-9a-fA-F]{3,8}$/.test(h)).slice(0, 8)
    : []
  const docNames = (Array.isArray(documents) ? documents : [])
    .map((d) => (typeof d?.name === 'string' ? d.name.trim() : ''))
    .filter(Boolean)
    .slice(0, 8)
  const modules = {
    model,
    style: style || 'auto',
    composition: composition || 'auto',
    lighting: lighting || 'auto',
    aspect: aspect || 'square',
    count: n,
    brandColors: palette,
    brandColorsOff: colorsOff,
    logo: logo === true,
    logoAttached: !!logoRef,
    references: refs.length,
    documents: docNames,
    avoid: String(avoid || '').trim() || null,
    promptChars: cleanPrompt.length,
  }

  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => generateOne({ key, model, content, imageConfig })),
  )

  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
  const images = ok.map((o) => o.url)
  const costUsd = ok.reduce((sum, o) => sum + (typeof o.costUsd === 'number' ? o.costUsd : 0), 0)
  const hasCost = ok.some((o) => typeof o.costUsd === 'number')
  const usageRollup = ok.map((o) => o.usage).filter(Boolean)
  if (!images.length) {
    const firstErr = settled.find((s) => s.status === 'rejected')
    throw new Error(firstErr?.reason?.message || 'Image generation failed')
  }
  const billed = hasCost ? `$${costUsd.toFixed(4)} (OpenRouter usage.cost — actual billed)` : 'unknown'
  const tokBits = usageRollup.map((u, i) => {
    const parts = [
      u.prompt_tokens != null ? `${u.prompt_tokens} in` : null,
      u.completion_tokens != null ? `${u.completion_tokens} out` : null,
      typeof u.cost === 'number' ? `$${u.cost.toFixed(4)}` : null,
    ].filter(Boolean)
    return parts.length ? `#${i + 1}:{${parts.join(', ')}}` : null
  }).filter(Boolean)
  console.log(
    `[images] ${model} · ${images.length}/${n} ok · billed ${billed}${tokBits.length ? ` · usage ${tokBits.join(' ')}` : ''} · modules ${JSON.stringify(modules)}`,
  )
  return {
    images,
    prompt: finalPrompt,
    model,
    costUsd: hasCost ? costUsd : undefined,
    costSource: hasCost ? 'openrouter.usage.cost' : undefined,
    usage: usageRollup,
    modules,
  }
}

// Split a "data:image/png;base64,AAAA" URL into { buffer, mime, ext } or null.
const DATA_URL_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
export function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/is.exec(String(dataUrl || '').trim())
  if (!m) return null
  const mime = m[1].toLowerCase()
  const ext = DATA_URL_EXT[mime]
  if (!ext) return null
  const buffer = Buffer.from(m[2], 'base64')
  if (!buffer.length) return null
  return { buffer, mime, ext }
}
