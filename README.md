# Content Studio · Workspace & Social Metrics

> **An all-in-one, multi-tenant content creation engine and performance analytics platform designed for marketing agencies, content creators, and founder-led brands.**

---

## 1. Executive Summary & Project Goal

### The Problem
Marketing agencies and creator teams traditionally juggle disconnected tools:
* Google Sheets or Notion for idea capture and topic research.
* Google Docs or generic AI chat windows for drafting content.
* Cloud drives or local folders for photos and reference graphics.
* External social media dashboards or manual spreadsheets for performance tracking.

This fragmentation leads to inconsistent brand voices, tedious manual copying, lost ideas, and zero feedback loop between what was published and how it actually performed.

### The Solution & Vision
**Content Studio** unifies the entire content lifecycle into a calm, streamlined editorial workspace:
$$\text{Client Onboarding} \longrightarrow \text{Brand Brain Extraction} \longrightarrow \text{Topic Research} \longrightarrow \text{Idea Banking} \longrightarrow \text{AI Drafting} \longrightarrow \text{Visuals \& Calendar} \longrightarrow \text{Live Social Analytics}$$

Every client in the system has an isolated workspace with its own dedicated voice guidelines, content pillars, media library, and connected social media profiles.

---

## 2. Core Workflows & What Tasks the System Performs

| Module | What It Does & Key Tasks Handled |
| :--- | :--- |
| **Client Management** | Multi-tenant organization. Create, configure, and switch between client workspaces. Admins can restrict team members to specific clients. |
| **Brand Brain & Extraction** | The editorial soul of each client. Reverse-engineers brand guidelines from any live website or uploaded brand-guide PDF using a headless browser (Puppeteer) and AI. Stores tone attributes, founder POV, approved keywords, forbidden phrases, and content pillars. |
| **Research & Stream Discovery** | Live topic discovery. Combines manual topic brainstorming with AI-powered trend analysis to uncover high-traction angles before competitors do. |
| **Idea Bank** | A structured repository to capture, tag, prioritize, and manage content ideas. Includes status tracking (*Idea*, *In Progress*, *Draft*, *Published*) and multi-channel targeting. |
| **AI Content Studio** | Generates platform-tailored copy using Claude / OpenRouter with format playbooks (LinkedIn posts/articles, Instagram captions/reels/carousels, X single-posts/threads, Substack essays/notes, Email newsletters). Inlines brand rules and learnings to prevent generic hallucinations. |
| **Photo Library & AI Image Studio** | Centralized image storage (drag-and-drop uploads, reordering, tagging) paired with an AI image generation studio (Gemini Flash Image via OpenRouter) tuned to produce brand-aligned visuals. |
| **Editorial Calendar** | Visual month-by-month planning grid. Shows scheduled posts across all channels, color-coded with channel tags, and allows seamless rescheduling. |
| **Live Social Performance** | Automated scraping via Apify for Instagram, LinkedIn, TikTok, X, and Substack. Pulls live follower counts, engagement rates, impressions, post archives, and visible comment threads to analyze real audience sentiment. |
| **Team Access (RBAC)** | Role-based authentication (`admin` vs `user`) managed through Supabase GoTrue metadata. Admins manage the workspace; restricted users only see clients assigned to them. |
| **AI Spend Ledger** | Transparent, real-time financial tracking. Records the exact USD cost and token count of every AI inference call per client. |

---

## 3. Technology Stack & Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │          React 18 + Vite Frontend            │
                       │   (Client SPA on port 5173 / dist bundle)    │
                       └──────────────────────┬───────────────────────┘
                                              │ Proxies /api calls
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │             Node / Express API               │
                       │           (Backend on port 4000)             │
                       └───────┬──────────────┬──────────────┬────────┘
                               │              │              │
           ┌───────────────────▼──┐   ┌───────▼──────┐   ┌───▼────────────────┐
           │   Supabase Cloud     │   │ AI Providers │   │   Apify Scrapers   │
           │  • PostgreSQL DB     │   │  • Claude    │   │  • LinkedIn        │
           │  • GoTrue RBAC Auth  │   │  • OpenRouter│   │  • Instagram       │
           │  • Storage (S3)      │   │  • Groq      │   │  • TikTok / X / Sub│
           └──────────────────────┘   └──────────────┘   └────────────────────┘
```

### Frontend (`client/`)
* **Framework:** React 18, Vite 6, React Router 7
* **Motion & Animations:** Motion (Framer Motion 12)
* **Styling:** Custom design system built with CSS variables (sleek dark mode, warm paper/rose accents, responsive layouts)
* **Markdown Rendering:** Marked

### Backend (`server/`)
* **Runtime:** Node.js (v22+ required for native WebSocket database client support)
* **API Framework:** Express 4 (ES Modules)
* **Headless Browser:** Puppeteer-core + system Chromium (used for brand identity crawling)
* **File Uploads:** Multer (memory storage directly streamed to Supabase Storage)
* **Document Parsing:** `pdf-parse` (for PDF brand guide analysis) & `cheerio` (for HTML parsing)

### Database & Storage (`supabase/`)
* **PostgreSQL:** 9 relational tables (`clients`, `ideas`, `photos`, `posts`, `research_topics`, `client_learnings`, `social_posts`, `social_snapshots`, `ai_usage`).
* **Supabase Storage:** 4 public S3 buckets (`client-logos`, `ref-documents`, `client-photos`, `social-media`).
* **Authentication:** Supabase GoTrue with RBAC embedded in `raw_user_meta_data`.

---

## 4. System Requirements & Prerequisites

1. **Node.js:** Version `22.0.0` or higher (verified on Node `v24.x`).
2. **Supabase Project (Free Tier):**
   * Database URL & Service Role Key (for Express server access).
   * Anon/Public Key (for auth).
3. **External Services (Optional, for full functionality):**
   * **Apify Token:** Free tier ($5/month included) for social metrics scraping.
   * **OpenRouter / Anthropic Key:** For AI copywriting, stream research, and image generation.

---

## 5. Local Setup & Running Guide

### 1. Clone & Enter Directory
```bash
git clone https://github.com/krish-e2m/content-studio.git
cd content-studio
```

### 2. Configure Environment Variables
Create a `.env` file inside the `server/` directory (or use `server/.env.example` as a template):

```env
# Required for database & auth
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJh...your-service-role-key...
SUPABASE_ANON_KEY=eyJh...your-anon-key...

# API Port
PORT=4000

# Optional integrations
APIFY_TOKEN=your_apify_token
OPENROUTER_API_KEY=your_openrouter_key
ANTHROPIC_API_KEY=your_anthropic_key
```

### 3. Database Migration
1. Go to your **Supabase Dashboard → SQL Editor**.
2. Copy and execute the complete schema from [`supabase/full_schema.sql`](supabase/full_schema.sql).
3. Create your first admin user under **Authentication → Users**, then grant admin rights in the SQL editor:
   ```sql
   update auth.users
   set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('is_admin', true)
   where lower(email) = lower('your_email@example.com');
   ```

### 4. Install Dependencies
```bash
npm install
```
*(The root postinstall script will automatically install both `client/` and `server/` packages).*

### 5. Start Development Servers
```bash
npm run dev
```
* **Frontend:** `http://localhost:5173`
* **Backend API:** `http://localhost:4000`

---

## 6. Deployment Guide

### Single-Service Container (Render, Railway, Fly.io, or Docker)
The application includes a production-ready [`Dockerfile`](Dockerfile) that:
1. Provisions Debian with Node 22 and headless Chromium.
2. Installs dependencies and builds the Vite frontend bundle into `client/dist`.
3. Runs the Express API, which serves both the `/api/*` endpoints and the static frontend as a single service on port `4000`.

To deploy on **Render**:
1. Connect your GitHub repository to Render.
2. Create a new **Web Service**, select **Docker** environment, and pick the **Free** instance.
3. Add your `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, and `PORT=4000` environment variables.
4. Deploy!
