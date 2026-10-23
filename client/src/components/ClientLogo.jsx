import { useEffect, useState } from 'react'

// Classify a logo for backdrop purposes. Returns:
//   'none'  — fills its own frame (has a baked-in background) → needs no plate
//   'dark'  — a dark mark on a transparent backdrop → wants a light plate
//   'light' — a light mark on a transparent backdrop → wants a dark plate
//   null    — couldn't read the pixels (e.g. a cross-origin image taints canvas)
function useLogoTone(src) {
  const [tone, setTone] = useState(null)
  useEffect(() => {
    if (!src) {
      setTone(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const s = 24
        const cv = document.createElement('canvas')
        cv.width = s
        cv.height = s
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, s, s)
        const { data } = ctx.getImageData(0, 0, s, s)
        const total = s * s
        let sum = 0
        let opaque = 0
        let transparent = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 24) {
            transparent++
            continue
          }
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          opaque++
        }
        if (cancelled) return
        // A logo that fills its frame (little transparency) carries its own
        // background — show it as-is, no plate. Only a logo on a transparent
        // backdrop gets a contrasting plate, chosen by the mark's brightness.
        if (!opaque || transparent / total < 0.12) setTone('none')
        else setTone(sum / opaque < 128 ? 'dark' : 'light')
      } catch {
        if (!cancelled) setTone(null) // canvas tainted by CORS, etc.
      }
    }
    img.onerror = () => {
      if (!cancelled) setTone(null)
    }
    img.src = src
    return () => {
      cancelled = true
    }
  }, [src])
  return tone
}

// A client logo rendered as its natural PNG. When a logo is present it sits on
// an adaptive backdrop that contrasts with the logo itself — a light plate for
// dark logos, a dark plate for light ones — so it reads on both dark surfaces
// (the brand-profile hero) and light cards. With no logo, renders `fallback` (e.g. the
// client's initial) on `fallbackStyle`. `defaultPlate` is used while the tone
// is still unknown (or undetectable), so dark-on-dark surfaces stay safe.
export function ClientLogo({ src, alt = '', className = '', fallback = null, fallbackStyle, surface = 'light' }) {
  const tone = useLogoTone(src)
  // Only add a backdrop when the mark would otherwise blend into its surface:
  // a dark mark on a dark surface, or a light mark on a light surface. A logo
  // with its own background ('none'), or one that already contrasts (e.g. a
  // dark mark on a light card), stays bare.
  let plate = ''
  if (src && tone !== 'none') {
    if (surface === 'dark') {
      if (tone === 'dark' || tone === null) plate = 'on-plate' // null → safe fallback on dark
    } else if (tone === 'light') {
      plate = 'on-plate-dark'
    }
  }
  return (
    <span className={`${className} ${plate}`.trim()} style={src ? undefined : fallbackStyle}>
      {src ? <img className="avatar-img" src={src} alt={alt} /> : fallback}
    </span>
  )
}
