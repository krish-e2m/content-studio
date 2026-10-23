// =============================================================================
// Brand-file bootstrap: turn the structured brand guideline (clients.ref_documents,
// built by hand or by the AI extractor) into starter core/*.md brand documents —
// the same layered "brand brain" folder convention used in Claude Code
// (core/brand-voice.md, core/founder-voice.md, core/business-info.md, …).
//
// Deterministic templating, no LLM: the guideline data maps 1:1 into markdown,
// so nothing can be invented. Humans enrich the drafts in the Brand documents
// UI afterwards; the generation engine (engine.js) then reads them as files.
// =============================================================================

const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
// voices store dos/donts/samples as arrays in the DB, but tolerate strings too
const toArr = (v) =>
  Array.isArray(v) ? v.filter(Boolean)
    : typeof v === 'string' ? v.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
    : []

const section = (title, lines) => (lines.length ? [`## ${title}`, '', ...lines, ''] : [])

function voiceDoc(v, fallbackTitle) {
  const L = [`# ${v.name || fallbackTitle}`, '']
  L.push(`Point of view: ${v.pov === 'first_person' ? 'first person ("I")' : 'brand "we"'}.`, '')
  const tone = toArr(v.tone_attributes)
  if (tone.length) L.push(...section('Tone', tone.map((t) => `- ${t}`)))
  const dos = toArr(v.dos)
  if (dos.length) L.push(...section('Do', dos.map((d) => `- ${d}`)))
  const donts = toArr(v.donts)
  if (donts.length) L.push(...section("Don't", donts.map((d) => `- ${d}`)))
  const samples = toArr(v.samples).length ? toArr(v.samples) : toArr(v.sample_posts)
  if (samples.length) {
    L.push('## Writing samples (match this style)', '')
    for (const s of samples) L.push('> ' + String(s).replace(/\n/g, '\n> '), '')
  }
  return L.join('\n').trim() + '\n'
}

// Build the starter core docs from a client row. Returns [{ name, content, tag }]
// in the shape of clients.documents. Only sections with real data are emitted.
export function draftCoreDocs(client = {}) {
  const rd = client.ref_documents || {}
  // The app nests the extractor's identity sections under ref_documents.identity,
  // but tolerate the raw extractor shape too (sections at the top level) so
  // drafting never comes up empty for rows saved through another path.
  const nested = rd.identity || {}
  const idn = {
    positioning: nested.positioning || rd.positioning || {},
    colors: nested.colors || rd.colors || {},
    typography: nested.typography || rd.typography || {},
    wordmark: nested.wordmark || rd.wordmark || {},
  }
  const voices = list(rd.voices)
  const out = []

  // --- core/business-info ----------------------------------------------------
  {
    const L = [`# ${client.name || 'Business'} — Business info`, '']
    const facts = []
    if (client.tagline) facts.push(`- **Tagline:** ${client.tagline}`)
    if (client.industry) facts.push(`- **Industry:** ${client.industry}`)
    if (client.website_url) facts.push(`- **Website:** ${client.website_url}`)
    if (client.contact_name) facts.push(`- **Founder / contact:** ${client.contact_name}`)
    L.push(...section('Basics', facts))
    if (rd.mission) L.push(...section('Mission', [rd.mission]))
    const pos = []
    if (idn.positioning?.tagline) pos.push(idn.positioning.tagline, '')
    if (idn.positioning?.statement) pos.push(idn.positioning.statement)
    L.push(...section('Positioning', pos))
    const socials = list(client.social_media_accounts)
      .map((s) => `- ${s.platform}${s.handle ? `: ${s.handle}` : ''}${s.url ? ` (${s.url})` : ''}`)
    L.push(...section('Channels', socials))
    if (L.length > 2) out.push({ name: 'business-info', content: L.join('\n').trim() + '\n', tag: 'core' })
  }

  // --- core/brand-voice + core/founder-voice ---------------------------------
  const brandVoice = voices.find((v) => v.kind === 'brand') || voices.find((v) => v.pov === 'brand_we')
  const founderVoice = voices.find((v) => v.kind === 'founder') || voices.find((v) => v.pov === 'first_person' && v !== brandVoice)
  {
    const L = ['# Brand voice', '']
    if (rd.brand_tone) L.push(rd.brand_tone, '')
    if (brandVoice) L.push(voiceDoc(brandVoice, 'Brand voice').replace(/^# .*\n\n?/, ''))
    if (L.length > 2 || brandVoice) out.push({ name: 'brand-voice', content: L.join('\n').trim() + '\n', tag: 'core' })
  }
  if (founderVoice) {
    // title the doc as a voice spec - e.g. "# Founder Name" alone reads as a bio
    const title = founderVoice.name ? `Founder voice — ${founderVoice.name}` : 'Founder voice'
    out.push({ name: 'founder-voice', content: voiceDoc({ ...founderVoice, name: title }, 'Founder voice'), tag: 'core' })
  }

  // --- core/content-rules ------------------------------------------------------
  {
    const L = ['# Content rules', '', 'Hard rules every piece of content must follow. Edit and extend freely — the writer treats these as law.', '']
    const lean = list(rd.keywords)
    if (lean.length) L.push(...section('Lean into (themes to weave in naturally)', lean.map((k) => `- ${k}`)))
    const avoid = list(rd.avoid_words)
    if (avoid.length) L.push(...section('Never use (words / phrases)', avoid.map((k) => `- ${k}`)))
    const pillars = list(rd.content_pillars).filter((p) => p && (p.name || p.title))
    if (pillars.length) {
      L.push(...section(
        'Content pillars (every piece should serve ONE)',
        pillars.slice(0, 6).map((p) => {
          const name = String(p.name || p.title || '').trim()
          const desc = String(p.description || p.desc || '').trim()
          return desc ? `- **${name}:** ${desc}` : `- **${name}**`
        }),
      ))
    }
    L.push(...section('Always', ['- No hashtags in post bodies (managed separately).', '- Ground every claim in the brand files — never invent facts, stats, names or links.']))
    out.push({ name: 'content-rules', content: L.join('\n').trim() + '\n', tag: 'core' })
  }

  // --- core/brand-design --------------------------------------------------------
  {
    const L = ['# Brand design', '']
    const prim = list(idn.colors?.primary).filter((c) => c?.hex)
    const supp = list(idn.colors?.supporting).filter((c) => c?.hex)
    if (prim.length) L.push(...section('Primary colors', prim.map((c) => `- ${c.hex}${c.name ? ` — ${c.name}` : ''}${c.role ? ` (${c.role})` : ''}`)))
    if (supp.length) L.push(...section('Supporting colors', supp.map((c) => `- ${c.hex}${c.name ? ` — ${c.name}` : ''}`)))
    if (idn.colors?.rule) L.push(idn.colors.rule, '')
    const fonts = list(idn.typography?.fonts).filter((f) => f?.family)
    if (fonts.length) L.push(...section('Typography', fonts.map((f) => `- ${f.family}${f.role ? ` — ${f.role}` : ''}`)))
    const wm = []
    if (idn.wordmark?.rules) wm.push(idn.wordmark.rules)
    const wmDonts = list(idn.wordmark?.donts)
    if (wmDonts.length) wm.push('', "Don'ts:", ...wmDonts.map((d) => `- ${d}`))
    L.push(...section('Wordmark', wm))
    if (L.length > 2) out.push({ name: 'brand-design', content: L.join('\n').trim() + '\n', tag: 'core' })
  }

  return out
}
