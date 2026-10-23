-- =============================================================================
-- RBAC — stored entirely in auth.users.raw_user_meta_data
--
-- No app tables. Every access decision reads the metadata blob on the Supabase
-- auth user:
--
--   admin           { "is_admin": true }
--   restricted user { "is_user": true, "client_ids": ["<uuid>", ...] }
--   no access       neither flag present
--
-- The server (server/auth.js) fails closed on the third case, so a bare Supabase
-- signup never inherits access.
--
-- Restricted users are created through the app (Users → Add user), which stamps
-- is_user + client_ids for you. The only thing SQL is needed for is promoting
-- your first admin, below.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. PROMOTE YOUR FIRST ADMIN
--
-- Create the account first: Supabase → Authentication → Users → "Add user",
-- set a password and tick "Auto Confirm User". Then run this with that email.
--
-- jsonb || jsonb merges, so any existing metadata (full_name etc.) is preserved
-- and is_user is cleared so the account can't be both.
-- ---------------------------------------------------------------------------
update auth.users
set raw_user_meta_data =
      coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('is_admin', true)
      - 'is_user'
where lower(email) = lower('admin@yourdomain.com');     -- <-- CHANGE THIS EMAIL


-- ---------------------------------------------------------------------------
-- 2. HANDY QUERIES (optional)
-- ---------------------------------------------------------------------------

-- Who has access, and to what?
--   select email,
--          raw_user_meta_data ->> 'full_name'                    as name,
--          case when (raw_user_meta_data ->> 'is_admin')::bool then 'admin'
--               when (raw_user_meta_data ->> 'is_user')::bool  then 'user'
--               else 'no access' end                             as role,
--          raw_user_meta_data -> 'client_ids'                    as client_ids
--   from auth.users
--   order by created_at desc;

-- Assign clients to an existing user by hand (the Users page does this for you):
--   update auth.users
--   set raw_user_meta_data =
--         coalesce(raw_user_meta_data, '{}'::jsonb)
--         || jsonb_build_object(
--              'is_user', true,
--              'client_ids', '["PUT-A-CLIENT-UUID-HERE"]'::jsonb)
--   where lower(email) = lower('someone@example.com');

-- Revoke all access without deleting the login:
--   update auth.users
--   set raw_user_meta_data = raw_user_meta_data - 'is_user' - 'is_admin' - 'client_ids'
--   where lower(email) = lower('someone@example.com');
