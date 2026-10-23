// =========================================================================
// useExtraction() - drive the branding extractor engine from React.
//
//   const { start, status, progressLines, result, error, fileUrl, reset } = useExtraction()
//   start('https://stripe.com')
//
// start() POSTs the URL to /api/extract, then opens an EventSource to
// /api/status/:jobId and streams progress lines until a `complete` (sets
// `result`) or `error` event. `fileUrl(relPath)` builds a /api/files URL for
// any asset referenced in the result (screenshots, logo, icons, ...).
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react'

const BASE = import.meta.env.VITE_API_URL || ''

export function useExtraction() {
  const [status, setStatus] = useState('idle') // idle | running | done | error
  const [progressLines, setProgressLines] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [jobId, setJobId] = useState(null)

  const esRef = useRef(null)

  const closeStream = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
  }, [])

  // tidy up the EventSource if the component unmounts mid-run
  useEffect(() => closeStream, [closeStream])

  const reset = useCallback(() => {
    closeStream()
    setStatus('idle'); setProgressLines([]); setResult(null); setError(null); setJobId(null)
  }, [closeStream])

  const start = useCallback(async (url) => {
    closeStream()
    setStatus('running'); setProgressLines([]); setResult(null); setError(null); setJobId(null)

    let id
    try {
      const res = await fetch(`${BASE}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
      id = body.jobId
    } catch (e) {
      setStatus('error'); setError(e.message || 'Could not start extraction')
      return
    }
    setJobId(id)

    const es = new EventSource(`${BASE}/api/status/${id}`)
    esRef.current = es
    es.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'progress') {
        setProgressLines((prev) => [...prev, msg.message])
      } else if (msg.type === 'complete') {
        setResult(msg.result); setStatus('done'); closeStream()
      } else if (msg.type === 'error') {
        setError(msg.error || 'Extraction failed'); setStatus('error'); closeStream()
      }
    }
    es.onerror = () => {
      // a clean server-side es.end() also surfaces here; only treat it as an
      // error if we never reached a terminal state.
      setStatus((s) => {
        if (s === 'running') { setError('Lost connection to the extractor'); return 'error' }
        return s
      })
      closeStream()
    }
  }, [closeStream])

  // build a /api/files URL for any relative asset path in the result
  const fileUrl = useCallback(
    (relPath) => (jobId && relPath ? `${BASE}/api/files/${jobId}/${relPath}` : null),
    [jobId],
  )

  return { start, reset, status, progressLines, result, error, jobId, fileUrl }
}
