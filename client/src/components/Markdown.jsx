import { useMemo } from 'react'
import { marked } from 'marked'

// Render raw markdown → HTML. Used for the brand-document preview / view.
// GFM + soft line breaks so authored docs render the way they read.
marked.setOptions({ gfm: true, breaks: true })

export function Markdown({ source, className = '' }) {
  const html = useMemo(() => marked.parse(String(source || '')), [source])
  return (
    <div
      className={`md-body ${className}`}
      // content is authored internally by the team (not public input)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
