# Content Engine - API

Node/Express API backed by Supabase Postgres. Phase 1: client onboarding (the
single `clients` table).

## Setup

```bash
cd server
npm install
cp .env.example .env     # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run dev              # http://localhost:4000
```

The frontend (Vite, port 5173) proxies `/api/*` to this server, so run both.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness check |
| GET | `/api/clients` | list all clients (newest first) |
| GET | `/api/clients/:id` | one client |
| POST | `/api/clients` | create a client (onboarding wizard) |
| PATCH | `/api/clients/:id` | update a client |
| DELETE | `/api/clients/:id` | delete a client |

`POST` body is exactly the `clients` row shape:

```json
{
  "name": "Your Brand Name",
  "slug": "your-brand",
  "contact_name": "Founder / Contact",
  "tagline": "Founder-led · Brand Marketing",
  "industry": "Marketing",
  "website_url": "https://yourwebsite.com",
  "status": "onboarding",
  "social_media_accounts": [ { "platform": "linkedin", "handle": "@yourbrand", "url": "", "connected": false } ],
  "ref_documents": { "brand_tone": "…", "voices": [], "documents": [] }
}
```

The server uses the **service role** key and is the trusted layer (bypasses RLS).
Never ship that key to the browser.
