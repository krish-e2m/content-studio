// =============================================================================
// server/logger.js
// Daily file logs at <repo>/logs/YYYY-MM-DD.log. Also echoes to stdout so a
// running terminal still shows the same lines.
//
// Files older than KEEP_DAYS are deleted on write and on server start.
// =============================================================================

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const LOG_DIR = join(ROOT, 'logs')
const KEEP_DAYS = 7
const PRUNE_EVERY_MS = 60 * 60 * 1000

const pad = (n, w = 2) => String(n).padStart(w, '0')

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localStamp(d = new Date()) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function ensureDir() {
  mkdirSync(LOG_DIR, { recursive: true })
}

let lastPruneAt = 0

export function pruneOldLogs({ force = false } = {}) {
  if (!force && lastPruneAt && Date.now() - lastPruneAt < PRUNE_EVERY_MS) return
  lastPruneAt = Date.now()
  ensureDir()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoff = today.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(LOG_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
    const fileDay = new Date(`${name.slice(0, 10)}T00:00:00`).getTime()
    if (!Number.isFinite(fileDay) || fileDay >= cutoff) continue
    try { unlinkSync(join(LOG_DIR, name)) } catch { /* ignore */ }
  }
}

function fmtExtra(extra) {
  if (extra === undefined) return ''
  if (typeof extra === 'string') return ` ${extra}`
  try { return ` ${JSON.stringify(extra)}` } catch { return ` ${String(extra)}` }
}

function write(level, msg, extra) {
  ensureDir()
  pruneOldLogs()
  const now = new Date()
  const line = `${localStamp(now)} ${level.padEnd(5)} ${msg}${fmtExtra(extra)}\n`
  try {
    appendFileSync(join(LOG_DIR, `${localDate(now)}.log`), line)
  } catch (err) {
    console.error('[logger] write failed:', err.message)
  }
  const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'
  if (extra !== undefined) console[fn](msg, extra)
  else console[fn](msg)
}

export const log = {
  info: (msg, extra) => write('INFO', msg, extra),
  warn: (msg, extra) => write('WARN', msg, extra),
  error: (msg, extra) => write('ERROR', msg, extra),
  debug: (msg, extra) => write('DEBUG', msg, extra),
}

pruneOldLogs({ force: true })
write('INFO', '[logger] ready', { dir: LOG_DIR, keepDays: KEEP_DAYS })
