// =============================================================================
// server/mediaCache.js
// Mirrors scraped images (post poster frames + channel avatars) into Supabase
// Storage.
//
// WHY THIS EXISTS
// Instagram serves images from signed CDN URLs that carry an expiry
// (`oe=`/`_nc_ohc=` params), and they are hotlink-protected: requested from our
// own origin they 403 even *before* expiring. Either way the browser gets
// nothing and the post tile renders "Image link expired". LinkedIn and X behave
// the same way on a longer fuse.
//
// So a scraped URL is only useful at the moment of the scrape. We download the
// bytes then, while the link is still live, and put them in a public bucket.
// Everything downstream — the DB row, the UI — points at our copy.
//
// VIDEOS ARE NOT MIRRORED. Only the poster frame is stored; `video_url` keeps
// the platform's own link, which does expire. That is a deliberate trade for
// storage footprint: a poster frame is ~100-200KB, a single post video is
// 5-50MB.
// =============================================================================

import { supabase } from './db.js'

export const MEDIA_BUCKET = 'social-media'

// A poster frame that doesn't fit in this is not a poster frame — refuse it
// rather than let one oversized asset eat the storage quota.
const MAX_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20000

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

// Only mirror what these CDNs serve. A scrape result is data from a third
// party, and `url` is the one field that would make the server fetch whatever
// it says — so it is matched against a host allowlist before any request goes
// out, and never used to reach an internal address.
const ALLOWED_HOSTS = [
  // fbcdn.net is Instagram's CDN as much as Meta's — scontent-*.xx.fbcdn.net
  // serves Instagram media, so it stays even though Facebook was removed.
  'cdninstagram.com', 'fbcdn.net', 'instagram.com',
  'licdn.com', 'linkedin.com',
  'twimg.com', 'twitter.com', 'x.com',
  // Substack serves covers from its CDN and author photos from one specific
  // S3 bucket — the exact host, not amazonaws.com, which would be far too broad.
  'substackcdn.com', 'substack.com', 'substack-post-media.s3.amazonaws.com',
  'tiktokcdn.com', 'tiktokcdn-eu.com', 'tiktokcdn-us.com', 'tiktok.com', 'muscdn.com',
  'apify.com', 'apifyusercontent.com',
]

const hostAllowed = (hostname) => {
  const h = hostname.toLowerCase()
  return ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`))
}

let bucketReady = false
async function ensureBucket() {
  if (bucketReady) return
  const { data } = await supabase.storage.getBucket(MEDIA_BUCKET)
  if (!data) {
    const { error } = await supabase.storage.createBucket(MEDIA_BUCKET, { public: true })
    if (error && !/already exists/i.test(error.message)) throw new Error(error.message)
  }
  bucketReady = true
}

// Object keys must be ASCII-safe and free of path tricks — external_id comes
// from a third party, so it is never interpolated into a path raw.
const safeSegment = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'x'

/**
 * Download one image and put it in the bucket at `objectPath` (extension is
 * appended from the response's content-type).
 *
 * Returns { url, path, sourceUrl } on success, or null on ANY failure — a
 * caller that gets null keeps whatever it had, because a stale link that might
 * still render beats no image at all.
 */
export async function mirrorImage(sourceUrl, objectPath) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null

  let parsed
  try { parsed = new URL(sourceUrl) } catch { return null }
  if (!/^https?:$/.test(parsed.protocol) || !hostAllowed(parsed.hostname)) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: {
        // These CDNs reject requests without a browser-shaped UA, and serve a
        // 403 when the Referer isn't the platform's own site.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: `${parsed.protocol}//${parsed.hostname}/`,
      },
    })
    if (!res.ok) return null

    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = EXT_BY_TYPE[type]
    if (!ext) return null
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return null

    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null

    await ensureBucket()
    const path = `${objectPath}.${ext}`
    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      // upsert: paths are deterministic, so a re-scrape replaces the file
      // rather than leaving the previous one orphaned.
      .upload(path, buf, { contentType: type, upsert: true, cacheControl: '2592000' })
    if (error) {
      console.warn('[mediaCache] upload failed:', error.message)
      return null
    }

    const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path)
    return { url: data?.publicUrl || null, path, sourceUrl }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const avatarPath = (clientId, platform) => `${clientId}/${platform}/avatar`
export const thumbPath = (clientId, platform, externalId) =>
  `${clientId}/${platform}/${safeSegment(externalId)}/thumb`

/**
 * Delete every mirrored object under a prefix. Storage does NOT cascade when
 * the owning rows go, so removing a client has to sweep the bucket explicitly
 * or the files sit there forever.
 */
export async function removeMediaPrefix(prefix) {
  try {
    await ensureBucket()
    // list() is one directory deep, so walk the platform folders and their
    // per-post folders rather than assuming a flat layout.
    const paths = []
    const { data: top } = await supabase.storage.from(MEDIA_BUCKET).list(prefix, { limit: 1000 })
    for (const entry of top || []) {
      if (entry.id) { paths.push(`${prefix}/${entry.name}`); continue }
      const { data: inner } = await supabase.storage
        .from(MEDIA_BUCKET).list(`${prefix}/${entry.name}`, { limit: 1000 })
      for (const child of inner || []) {
        if (child.id) { paths.push(`${prefix}/${entry.name}/${child.name}`); continue }
        const { data: leaf } = await supabase.storage
          .from(MEDIA_BUCKET).list(`${prefix}/${entry.name}/${child.name}`, { limit: 1000 })
        for (const f of leaf || []) paths.push(`${prefix}/${entry.name}/${child.name}/${f.name}`)
      }
    }
    if (paths.length) await supabase.storage.from(MEDIA_BUCKET).remove(paths)
    return paths.length
  } catch (err) {
    console.warn('[mediaCache] prefix cleanup skipped:', err.message)
    return 0
  }
}