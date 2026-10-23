// =========================================================================
// Static prototype data + mock "generators".
// No backend, no AI calls - content is produced from local templates so the
// flow feels real. Swap these functions for an API later.
// =========================================================================

// Primary channels first, then secondary channels.
export const PLATFORMS = [
  { id: 'linkedin', name: 'LinkedIn', dot: 'p-linkedin', primary: true, formats: ['Single thought', 'Short-form post', 'Long-form article'] },
  { id: 'instagram', name: 'Instagram', dot: 'p-instagram', primary: true, formats: ['Single caption', 'Carousel', 'Reel script'] },
  { id: 'substack', name: 'Substack', dot: 'p-substack', primary: true, formats: ['Short note', 'Long-form essay'] },
  { id: 'email', name: 'Email', dot: 'p-email', primary: false, formats: ['Newsletter', 'Short broadcast'] },
  { id: 'x', name: 'X', dot: 'p-x', primary: false, formats: ['Single post', 'Thread'] },
]

export const platformById = (id) => PLATFORMS.find((p) => p.id === id)

// ---------- Step 7: fact-check checklist ----------
export const FACTCHECK_ITEMS = [
  'Names, titles and spellings are correct',
  'Any stats, dates or claims are accurate',
  'Links, handles and @mentions work',
  'Tone matches the brand voice',
  'No unverified or sensitive information',
]

// ---------- Step 8: the three visual paths ----------
export const VISUAL_PATHS = [
  { id: 'photo', name: 'Your own photo', sub: 'Personal or branded', desc: 'Pair the post with an image you already have in the Photo Library.' },
  { id: 'ai', name: 'AI image', sub: 'Brand-matched prompt', desc: 'Generate a visual from a prompt tuned to the brand look.' },
  { id: 'graphic', name: 'Infographic / text', sub: 'No photo needed', desc: 'A text-based graphic or simple infographic built from the post.' },
]

// ---------- Clients ----------
// Clients are no longer seeded here - they come from the API (Supabase
// `clients` table). See src/api.js + the server/ package.

// =========================================================================
// Onboarding - option lists + helpers for the "Add Client" wizard.
// These mirror the single `clients` table schema:
//   social_media_accounts (jsonb)  +  ref_documents (jsonb: tone, voices, docs)
// =========================================================================

// hasHandle: false → platform has no @username (e.g. an email newsletter),
// so the wizard hides the handle field and only asks for a URL.
export const SOCIAL_OPTIONS = [
  { id: 'linkedin', name: 'LinkedIn' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'substack', name: 'Substack' },
  { id: 'x', name: 'X (Twitter)' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'email', name: 'Email / Newsletter', hasHandle: false },
]

export const platformHasHandle = (id) => SOCIAL_OPTIONS.find((o) => o.id === id)?.hasHandle !== false

export const VOICE_KINDS = [
  { id: 'brand', name: 'Brand' },
  { id: 'founder', name: 'Founder' },
  { id: 'custom', name: 'Custom' },
]

export const VOICE_POVS = [
  { id: 'brand_we', name: 'Brand “we”' },
  { id: 'first_person', name: 'First person' },
  { id: 'third_person', name: 'Third person' },
]

// accent_color was dropped from the schema, so the UI derives a stable,
// on-theme avatar swatch from the client name instead of storing one.
const CLIENT_COLORWAYS = ['#ebb7c2', '#9fb6c4', '#e8b9a3', '#cf6b4a', '#bca78f', '#d99aa8']
export function colorFor(seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return CLIENT_COLORWAYS[h % CLIENT_COLORWAYS.length]
}

export const slugify = (s) =>
  String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// Blank wizard draft - two voices pre-seeded (Brand + Founder), per the plan.
export function blankClientDraft() {
  return {
    name: '',
    contact_name: '', tagline: '', industry: '', website_url: '',
    social_media_accounts: [{ platform: 'linkedin', handle: '', url: '' }],
    ref: {
      brand_tone: '', mission: '', keywords: '', avoid_words: '', logo_scraped: '', logo_manual: '', identity: {},
      // 3–6 named themes the brand returns to — drives angles in research + generation.
      content_pillars: [],
      voices: [
        { kind: 'brand', name: '', pov: 'brand_we', tone: '', dos: '', donts: '', samples: '', doc: null },
        { kind: 'founder', name: '', pov: 'first_person', tone: '', dos: '', donts: '', samples: '', doc: null },
      ],
      documents: [],
    },
  }
}

// ---------- Static "AI generated" sample images (no network / no real model) ----------
function aiSvg(c1, c2, c3) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='800' height='600' fill='url(#g)'/>
    <circle cx='600' cy='190' r='230' fill='${c3}' opacity='0.5'/>
    <circle cx='210' cy='470' r='170' fill='#ffffff' opacity='0.22'/>
    <circle cx='470' cy='360' r='90' fill='${c3}' opacity='0.35'/>
    <rect x='44' y='44' width='712' height='512' fill='none' stroke='#0a0a0a' stroke-opacity='0.12'/>
    <text x='64' y='556' font-family='monospace' font-size='17' fill='#0a0a0a' fill-opacity='0.4' letter-spacing='4'>AI · GENERATED PREVIEW</text>
  </svg>`
}
export const SAMPLE_AI_IMAGES = [
  `data:image/svg+xml,${encodeURIComponent(aiSvg('#F5D5DC', '#F7F4EE', '#EBB7C2'))}`,
  `data:image/svg+xml,${encodeURIComponent(aiSvg('#EBB7C2', '#F7F4EE', '#cf6b4a'))}`,
  `data:image/svg+xml,${encodeURIComponent(aiSvg('#1C1917', '#5a4f49', '#EBB7C2'))}`,
]
export function pickAiImage(topic) {
  return SAMPLE_AI_IMAGES[(topic || '').length % SAMPLE_AI_IMAGES.length]
}

// ---------- Step 1: seed research ----------
// "Upstream" = the wider industry & trends. "On-stream" = the client's own content.
export const SEED_RESEARCH = {
  upstream: [
    { id: 'up-1', text: 'Creators are moving from "post more" to "build a repeatable system" - systems content is resonating.' },
    { id: 'up-2', text: 'Substack is surging for founder-led, long-form voice; LinkedIn rewards a strong personal POV.' },
    { id: 'up-3', text: 'Audiences are fatigued by generic AI output - authentic, specific, first-person stories outperform.' },
  ],
  onstream: [
    { id: 'on-1', text: 'Top past post: behind-the-scenes breakdown of our workflow (highest saves).' },
    { id: 'on-2', text: 'Recurring theme in writing: building systems and better feedback loops.' },
    { id: 'on-3', text: 'Audience frequently asks: "what visual style works best?" - clear content gap to address.' },
  ],
}

// ---------- Idea bank ----------
// No static seed ideas - the Idea Bank starts empty and is filled by the user
// via the "Add an idea" form (see IdeaBankPage.jsx).

// Photos are no longer seeded here - they come from the API (Supabase `photos`
// table + the `client-photos` Storage bucket). See src/api.js + PhotoLibraryPage.

// =========================================================================
// Mock content generator
// =========================================================================

const clean = (s) => (s || '').trim().replace(/\s+/g, ' ')
const lower = (s) => clean(s).toLowerCase().replace(/[.?!]+$/, '')

function hashtagsFor(topic, tags = []) {
  const base = [...tags, ...lower(topic).split(' ')]
    .map((w) => w.replace(/[^a-z0-9]/gi, ''))
    .filter((w) => w.length > 2)
  const uniq = [...new Set(base)].slice(0, 4)
  return uniq.map((w) => '#' + w.charAt(0).toUpperCase() + w.slice(1)).join('  ')
}

// Returns { title, body, hashtags } per platform/format
export function generateContent({ topic, note, platform, format }) {
  const t = clean(topic) || 'an idea worth sharing'
  const tl = lower(topic) || 'this idea'
  const angle = clean(note) || `Most people overcomplicate ${tl}. It doesn't have to be hard.`

  switch (platform) {
    case 'linkedin':
      if (format === 'Carousel') {
        return {
          title: t,
          body: `Slide 1 - ${t}\n\nSlide 2 - The problem\n${angle}\n\nSlide 3 - What most people do\nThey react. No system, no plan, just posting and hoping.\n\nSlide 4 - A better way\nThree small shifts that make ${tl} repeatable.\n\nSlide 5 - Start here\nPick one. Do it this week. Tell me how it goes. →`,
          hashtags: hashtagsFor(t),
        }
      }
      return {
        title: t,
        body: `${t}.\n\n${angle}\n\nHere's what I've learned:\n\n→ It's not about doing more. It's about a system you can repeat.\n→ The foundation matters more than the tool.\n→ Small, consistent choices beat big, occasional pushes.\n\nIf you've been stuck on ${tl}, start with one thing this week.\n\nWhat's worked for you?`,
        hashtags: hashtagsFor(t),
      }

    case 'instagram':
      if (format === 'Reel script') {
        return {
          title: t,
          body: `HOOK (0-2s): "Stop overthinking ${tl}."\n\nBEAT 1: Show the messy before - scattered notes, half-written posts.\n\nBEAT 2: ${angle}\n\nBEAT 3: The one change that fixed it.\n\nCTA: Save this for your next content session. ↓`,
          hashtags: hashtagsFor(t),
        }
      }
      return {
        title: t,
        body: `${t} ✨\n\n${angle}\n\nThe truth? You already have everything you need - it's just scattered.\n\nSave this for later, and tell me in the comments: what's your #1 blocker right now?`,
        hashtags: hashtagsFor(t) + '  #ContentCreation  #CreatorTips',
      }

    case 'email':
      return {
        title: `Subject: ${t}`,
        body: `__SUBJECT__${t}\n\nHi friend,\n\n${angle}\n\nI want to walk you through how I think about this - without the overwhelm.\n\nThree things to try this week:\n1. Capture every idea in one place.\n2. Turn one idea into three pieces.\n3. Schedule it before you second-guess it.\n\nThat's the whole system. Reply and tell me which one you'll start with.\n\nWarmly,\n[Your Name]`,
        hashtags: '',
      }

    case 'substack':
      if (format === 'Short note') {
        return {
          title: t,
          body: `${angle}\n\nI keep coming back to this: ${tl} isn't a talent problem. It's a system problem.\n\nMore on this soon. →`,
          hashtags: '',
        }
      }
      return {
        title: t,
        body: `${t}\n\n${angle}\n\n- I -\n\nFor a long time, I treated content like a series of one-off decisions. Every post started from zero.\n\n- II -\n\nThen I built a foundation: a voice, an idea bank, a calendar. Suddenly ${tl} got quiet and repeatable.\n\n- III -\n\nThe lesson isn't "work harder." It's "build the thing once, then feed it."\n\nIf this resonated, hit reply - I read everything.`,
        hashtags: '',
      }

    case 'x':
      if (format === 'Thread') {
        return {
          title: t,
          body: `1/ ${t}\n\n${angle}\n\n2/ Most people think the problem is effort. It's not. It's the lack of a system.\n\n3/ Capture → repurpose → schedule. That's the whole loop.\n\n4/ Do it once properly and ${tl} stops being a weekly scramble.\n\n5/ Try it this week. Report back. 👇`,
          hashtags: hashtagsFor(t),
        }
      }
      return {
        title: t,
        body: `${t}.\n\n${angle}\n\nThe fix isn't more effort - it's a system you can repeat.`,
        hashtags: hashtagsFor(t),
      }

    default:
      return { title: t, body: angle, hashtags: '' }
  }
}

// ---------- Image-prompt suggestions (editorial styling) ----------
export function imagePromptFor(topic) {
  const tl = lower(topic) || 'the idea'
  const options = [
    `Editorial photograph illustrating "${tl}" - warm cream paper background, soft natural window light, dusty-rose accents, minimal props, shallow depth of field. Calm, premium, magazine-quality.`,
    `Flat-lay for "${tl}" - linen surface, a single notebook and pen, blush and ink tones, generous negative space for text overlay. Quiet and considered.`,
    `Text-based graphic - Cormorant Garamond headline pulled from the post over a soft blush-to-cream gradient, thin ink hairline border. Elegant, on-brand, no stock photo needed.`,
  ]
  return options
}

// pick one suggestion deterministically from a topic (no Math.random for stable previews)
export function pickImagePrompt(topic) {
  const opts = imagePromptFor(topic)
  const seed = (topic || '').length % opts.length
  return opts[seed]
}

// text-based graphic / infographic brief (the "no photo needed" path)
export function graphicPromptFor(topic) {
  const t = clean(topic) || 'Your headline here'
  return `Text-based graphic - set "${t}" in Cormorant Garamond over a soft blush-to-cream gradient, thin ink hairline border, generous margins. Add 2–3 supporting points as a simple stacked list if it's an infographic. Elegant, on-brand, no stock photo needed.`
}
