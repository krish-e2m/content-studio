// Loads environment variables from the root-level .env (shared by both the
// server and the Vite client), then from server/.env for anything the root
// file didn't define. Both are resolved by absolute path so it works no matter
// what the current working directory is when the server starts.
//
// Why two files: the root .env is the documented convention, but server/.env
// is the intuitive place to put a server-only secret and used to be read by
// nothing at all — a key dropped there went silently missing, which is a
// genuinely confusing failure (the feature 502s as "token rejected" when the
// token was simply never loaded). Root still wins on conflict, so the
// documented layout keeps precedence.
//
// In production (e.g. Render) neither file exists - dotenv simply does nothing
// and the platform's dashboard env vars are used instead.
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// dotenv never overwrites an already-set variable, so load order = precedence.
dotenv.config({ path: join(here, '..', '.env') })
dotenv.config({ path: join(here, '.env') })
