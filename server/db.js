import './load-env.js'
import { createClient } from '@supabase/supabase-js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '\n[server] Missing Supabase config.\n' +
      'Fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the root .env file.\n',
  )
  process.exit(1)
}

// Service-role client: trusted server context, bypasses RLS.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Separate client for password sign-in. GoTrue's password grant is meant to be
// called with the anon key; calling it with the service-role key sends an
// already-privileged Authorization header, which is both unnecessary and
// unreliable. Falls back to the service client so login still works if
// SUPABASE_ANON_KEY isn't set — but set it: it's the supported path.
export const supabaseAuth = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

export const usingAnonKeyForAuth = Boolean(SUPABASE_ANON_KEY)
if (!SUPABASE_ANON_KEY) {
  console.warn(
    '[server] SUPABASE_ANON_KEY is not set - password sign-in is falling back to\n' +
    '         the service-role key. Add SUPABASE_ANON_KEY to .env (Supabase →\n' +
    '         Project Settings → API → anon/public key).',
  )
}
