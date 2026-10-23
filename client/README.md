# Content Studio - Client Workspace

A front-end client **Content Creation Workspace**.
One calm place for clients to turn scattered ideas, photos and half-written posts into
planned, ready-to-use content.

## The idea

One calm place for clients to turn scattered ideas, photos and half-written posts into
planned, ready-to-use content.

**Core flow:** Idea Bank → pick a content type → generate → organize on the calendar.

## Run it

```bash
cd client
npm install
npm run dev      # http://localhost:5173
npm run build    # production build → dist/
npm run preview  # serve the build
```

## What's inside

| View | What it does |
|------|--------------|
| **Overview** | Stats, what's coming up, fresh ideas from the bank |
| **Idea Bank** | Capture topics/stories/angles; add & remove ideas |
| **Create** | One topic → choose platform (LinkedIn / Instagram / Email / Substack / X) + format → generate a draft → copy or schedule. Includes an editorial **image direction** suggestion. |
| **Photos** | Upload your own images (shown instantly via FileReader) + seeded swatches |
| **Calendar** | Month grid, color-coded by channel; click an event to remove |

## Theme

- **Type:** Inter (body/display) · JetBrains Mono (labels)
- **Color:** ink `#0A0A0A` · warm-dark `#1C1917` · dusty rose `#EBB7C2` · blush `#F5D5DC` · paper cream `#F7F4EE`
- **Detail:** 2px radius, wide-tracked uppercase mono eyebrows, soft pink glows, slow fade-up motion

## Files

```
src/
  App.jsx       all views (Dashboard, IdeaBank, Composer, PhotoLibrary, Calendar) + modal/toast
  data.js       platforms, seed ideas/photos, mock content + image-prompt generators
  icons.jsx     inline stroke icons
  styles.css    the Content Studio design system
```

## Swapping in a real backend later

Replace `generateContent()` / `pickImagePrompt()` in `src/data.js` with API calls, and
swap the `usePersisted` hooks in `src/App.jsx` for fetches. Everything else stays.
