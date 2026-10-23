# Railway build for the Content Engine — the Express API in server/ also serves
# the built React client (client/dist) as a single service.
#
# Why this exists: the brand extractor drives a headless browser via
# `puppeteer-core`, which ships NO Chromium binary. Railway's default Nixpacks
# build has no Chrome, so the extractor can't launch and brand COLORS come back
# empty. This image installs a system Chromium and points puppeteer at it.
#
# Node 22 (not 20): @supabase/supabase-js requires a global WebSocket, which is
# only native from Node 22 — on Node 20 it throws at boot in db.js.
FROM node:22-slim

# Chromium + the bits a headless browser needs. apt pulls in Chromium's own
# shared-lib dependencies; fonts-liberation avoids blank text in screenshots.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Explicit path for puppeteer-core (resolveChromium() also probes /usr/bin/chromium).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install deps (root postinstall installs the server/ and client/ workspaces too)
# and build the client bundle the server serves. Dev deps are needed for the
# Vite build, so keep NODE_ENV unset until after `npm run build`.
COPY . .
RUN npm install
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4000

# root "start" -> npm --prefix server start -> node index.js (reads $PORT)
CMD ["npm", "start"]
