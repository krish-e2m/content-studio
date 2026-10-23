# Branding extractor

Takes any website URL, drives a **headless system Chromium** to it (via
`puppeteer-core`), crawls up to 5 more key pages, and reverse-engineers the
site's visual brand into a structured `branding.json` plus downloadable assets
(logo, favicon, OG image, desktop+mobile screenshots, SVG icons, self-contained
component HTML, and an `extracted.css` dump).

This is **separate** from the existing `/api/brand/extract` flow (which fetches
HTML with cheerio and asks Groq to infer a brand identity). This engine paints
the real page in a browser and reads computed styles, so it's accurate for
SPAs, dark themes, and JS-rendered sites.

## Pieces

| File | Role |
| --- | --- |
| `extract-branding.mjs` | Standalone CLI engine. `node extract-branding.mjs <url> <outDir>` |
| `routes.js` | Express router: spawns the engine per job, streams progress over SSE, serves output files. Mounted in `../index.js`. |
| `../../client/src/hooks/useExtraction.js` | React hook: `start(url)` → POST → EventSource. |
| `../../client/src/components/BrandExtractor.jsx` | Minimal demo component. |

## CLI

```bash
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node server/extractor/extract-branding.mjs https://stripe.com /tmp/out
```

Every step prints a `[branding] <message>` line to stdout (the backend strips
the prefix and streams these to the client). A `branding.json` is **always**
written, even on a fatal error or a mid-crawl browser crash (the browser is
relaunched and the run continues with partial data + an offline QA pass).

Output layout under `<outDir>`:

```
branding.json
logo.svg | logo.png
favicon.png
assets/og-image.png
screenshots/<page>.png
screenshots/mobile/<page>.png
icons/<name>.svg
html/pages/<page>.html
html/components/<name>.html        (full standalone doc)
html/components/<name>.snippet.html (raw outerHTML)
html/styles/extracted.css
```

## HTTP API (mounted on the existing Express app)

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/extract` | Body `{ url }` → `{ jobId }`. Creates `extractions/<jobId>/` and spawns the engine. |
| `GET` | `/api/status/:jobId` | **SSE** stream. Replays buffered progress, then live `{type:"progress"}` lines, then a final `{type:"complete", result}` (the parsed `branding.json`) or `{type:"error"}`. |
| `GET` | `/api/files/:jobId/*` | Serves an individual extracted file (path-contained to the job dir). |

Job state is kept in an in-memory `Map`; output files persist under
`server/extractions/<jobId>/` (git-ignored).

## React usage

```jsx
import BrandExtractor from './components/BrandExtractor.jsx'
// or, lower level:
const { start, status, progressLines, result, error, fileUrl } = useExtraction()
start('https://stripe.com')
// result.colors.primary, result.screenshots.desktop, fileUrl(result.logo.file), ...
```

In dev, Vite proxies `/api` → `http://localhost:4000` (see
`client/vite.config.js`), so SSE works without CORS.

## Deployment — Chromium must be present

`puppeteer-core` does **not** download a browser. Production must have Chromium
installed and (ideally) `PUPPETEER_EXECUTABLE_PATH` set. The engine resolves the
binary in this order: `PUPPETEER_EXECUTABLE_PATH` → common paths
(`/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`,
`/Applications/Google Chrome.app/...`, the Nix path) → puppeteer-core auto-detect.

- **Nixpacks / Railway-style:** add `chromium` to the Nix packages and point at it:
  ```toml
  # nixpacks.toml
  [phases.setup]
  nixPkgs = ["nodejs_20", "chromium"]
  [variables]
  PUPPETEER_EXECUTABLE_PATH = "/nix/var/nix/profiles/default/bin/chromium"
  ```
- **Debian/Ubuntu image:** `apt-get install -y chromium` (or `chromium-browser`),
  then set `PUPPETEER_EXECUTABLE_PATH` to the installed path.
- The engine already launches with `--no-sandbox --disable-setuid-sandbox
  --disable-dev-shm-usage` so it runs in containers without extra config.
