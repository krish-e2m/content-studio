// =============================================================================
// Branding extractor API. Spawns the standalone engine
// (extractor/extract-branding.mjs) as a child process per job, streams its
// `[branding] ...` stdout to clients over Server-Sent Events, and serves the
// extracted files on disk.
//
//   POST /api/extract        { url }            -> { jobId }
//   GET  /api/status/:jobId   (SSE)             -> progress lines + final event
//   GET  /api/files/:jobId/*  (raw file)        -> screenshots / logo / icons / ...
//
// Mounted onto the existing Express app in index.js. Job state is in-memory
// (a Map); restarting the server drops in-flight jobs.
//
// Output files under extractions/<jobId>/ are a staging area only - the live
// app reads branding.json off the SSE stream and never re-reads the folder, so
// each job's folder is auto-removed CLEANUP_DELAY_MS after it finishes. A
// boot+interval sweep also clears orphans left by a crash/restart.
// =============================================================================
import { Router } from 'express'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeUrl } from '../url.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.join(__dirname, 'extract-branding.mjs')
const EXTRACTIONS_DIR = path.join(__dirname, '..', 'extractions')

export const router = Router()

// jobId -> { status, url, progress:[], result, error, listeners:Set<res> }
const jobs = new Map()

// How long a finished extraction's files linger on disk before auto-removal.
// The live app consumes branding.json over SSE and never re-reads the folder,
// so this only needs to cover any in-flight /api/files reads. Configurable.
const CLEANUP_DELAY_MS = Number(process.env.EXTRACTION_TTL_MS) || 60_000

// Backstop for a job that never finishes. The engine stops itself at its own
// time budget (EXTRACT_BUDGET_MS) + 30s; this fires a minute after that, so it
// only ever catches a wedged browser. SIGTERM lets puppeteer close Chromium.
const JOB_TIMEOUT_MS = Number(process.env.EXTRACT_JOB_TIMEOUT_MS) || (Number(process.env.EXTRACT_BUDGET_MS) || 90_000) + 90_000

// Remove a job's on-disk folder and drop it from the in-memory Map. Safe to
// call more than once (force:true ignores an already-gone dir).
async function removeExtraction(jobId) {
  jobs.delete(jobId)
  try {
    await fs.rm(path.join(EXTRACTIONS_DIR, jobId), { recursive: true, force: true })
  } catch (e) {
    console.error(`[extract] cleanup failed for ${jobId}: ${e.message}`)
  }
}

// Schedule cleanup once per job, CLEANUP_DELAY_MS after it reaches a terminal
// state. The timer is unref'd so it never keeps the process alive on its own.
function scheduleCleanup(jobId) {
  const job = jobs.get(jobId)
  if (!job || job.cleanupScheduled) return
  job.cleanupScheduled = true
  setTimeout(() => { removeExtraction(jobId) }, CLEANUP_DELAY_MS).unref()
}

// Sweep orphaned folders: any extraction dir older than the grace window whose
// job isn't still running. Catches crash/restart orphans (timers don't survive
// a restart) and clears any pre-existing backlog. Runs at boot + on an interval.
async function sweepStaleExtractions() {
  let entries
  try {
    entries = await fs.readdir(EXTRACTIONS_DIR, { withFileTypes: true })
  } catch {
    return // dir doesn't exist yet - nothing to sweep
  }
  const cutoff = Date.now() - CLEANUP_DELAY_MS
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (jobs.get(ent.name)?.status === 'running') continue // never touch a live job
    const dir = path.join(EXTRACTIONS_DIR, ent.name)
    try {
      const { mtimeMs } = await fs.stat(dir)
      if (mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true })
    } catch {}
  }
}

sweepStaleExtractions()
setInterval(sweepStaleExtractions, CLEANUP_DELAY_MS).unref()

// SSE frame helper. `event:` defaults to "message" so the client's onmessage fires.
function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcast(job, payload) {
  for (const res of job.listeners) {
    try { send(res, payload) } catch {}
  }
}

// --- POST /api/extract -------------------------------------------------------
router.post('/api/extract', async (req, res) => {
  // normalize to https:// so the headless browser always gets a navigable URL
  // (a bare domain like "yourwebsite.com" would otherwise fail page.goto)
  const url = normalizeUrl(req.body?.url)
  if (!url) return res.status(400).json({ error: 'a website url is required' })

  const jobId = randomBytes(4).toString('hex') // 8 hex chars
  const outDir = path.join(EXTRACTIONS_DIR, jobId)
  await fs.mkdir(outDir, { recursive: true })

  const job = { status: 'running', url, progress: [], result: null, error: null, listeners: new Set() }
  jobs.set(jobId, job)

  const child = spawn(process.execPath, [ENGINE, url, outDir], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const killTimer = setTimeout(() => {
    if (job.status !== 'running') return
    job.timedOut = true
    console.error(`[extract] ${jobId} still running after ${JOB_TIMEOUT_MS / 1000}s - stopping it`)
    child.kill('SIGTERM')
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000).unref()
  }, JOB_TIMEOUT_MS)
  killTimer.unref()

  // parse stdout line-by-line; strip the "[branding] " prefix; fan out to SSE
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const message = line.replace(/^\[branding\]\s?/, '')
      job.progress.push(message)
      broadcast(job, { type: 'progress', message })
    }
  })
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim()
    if (message) { job.progress.push(message); broadcast(job, { type: 'progress', message }) }
  })

  child.on('error', (err) => {
    job.status = 'error'
    job.error = err.message
    broadcast(job, { type: 'error', error: err.message })
    for (const r of job.listeners) { try { r.end() } catch {} }
    job.listeners.clear()
    scheduleCleanup(jobId)
  })

  child.on('close', async (code) => {
    clearTimeout(killTimer)
    if (code === 0) {
      try {
        const raw = await fs.readFile(path.join(outDir, 'branding.json'), 'utf8')
        job.result = JSON.parse(raw)
        job.status = 'done'
        broadcast(job, { type: 'complete', result: job.result })
      } catch (e) {
        job.status = 'error'
        job.error = `could not read branding.json: ${e.message}`
        broadcast(job, { type: 'error', error: job.error })
      }
    } else {
      job.status = 'error'
      job.error = job.timedOut
        ? `brand extraction took longer than ${Math.round(JOB_TIMEOUT_MS / 1000)}s on this server and was stopped`
        : `extractor exited with code ${code}`
      broadcast(job, { type: 'error', error: job.error })
    }
    for (const r of job.listeners) { try { r.end() } catch {} }
    job.listeners.clear()
    scheduleCleanup(jobId)
  })

  res.json({ jobId })
})

// --- GET /api/status/:jobId (SSE) -------------------------------------------
router.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'unknown jobId' })

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // replay buffered progress so a late subscriber still sees the whole story
  for (const message of job.progress) send(res, { type: 'progress', message })

  // already finished? emit the terminal event immediately and close
  if (job.status === 'done') { send(res, { type: 'complete', result: job.result }); return res.end() }
  if (job.status === 'error') { send(res, { type: 'error', error: job.error }); return res.end() }

  // otherwise attach as a live listener
  job.listeners.add(res)
  req.on('close', () => { job.listeners.delete(res) })
})

// --- GET /api/files/:jobId/* -------------------------------------------------
router.get('/api/files/:jobId/*', (req, res) => {
  const rel = req.params[0] || ''
  const base = path.join(EXTRACTIONS_DIR, req.params.jobId)
  const abs = path.resolve(base, rel)
  // contain the path: never serve outside the job's own directory
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return res.status(400).json({ error: 'invalid path' })
  }
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file not found' })
  })
})
