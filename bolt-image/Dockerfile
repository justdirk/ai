# dirk.it overlay build of bolt.diy
# Builds bolt.diy from source, applies dirk.it branding (favicon, page title,
# header wordmark), and serves it exactly like upstream (wrangler on :5173).
# Pinned to a known-good commit so the branding patches match; bump the SHA to update.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV HUSKY=0
ENV CI=true

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates perl \
  && rm -rf /var/lib/apt/lists/*

# Clone bolt.diy at a known-good commit
RUN git clone https://github.com/stackblitz-labs/bolt.diy.git . \
  && git checkout 2e254ac19a696394030601bc602f54945b12bfc4

# ---- dirk.it branding overlay ----
# favicon (browser tab)
COPY favicon.svg public/favicon.svg
# page <title> + meta description
RUN sed -i "s/{ title: 'Bolt' }/{ title: 'dirk.it \xE2\x80\x94 build apps' }/" app/routes/_index.tsx \
  && sed -i "s/Talk with Bolt, an AI assistant from StackBlitz/Build apps in plain language on dirk.it/" app/routes/_index.tsx
# header logo: replace the two bolt logo images with a dirk.it text wordmark
RUN perl -0777 -pi -e 's{<img src="/logo-light-styled\.png".*?/>\s*<img src="/logo-dark-styled\.png".*?/>}{<span className="text-2xl font-semibold text-accent">dirk<span className="opacity-50">.it</span></span>}s' app/components/header/Header.tsx

# ---- build ----
RUN pnpm install --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- production ----
FROM build AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5173
ENV HOST=0.0.0.0
ENV WRANGLER_SEND_METRICS=false
ENV RUNNING_IN_DOCKER=true

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.config/.wrangler && echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json
RUN chmod +x /app/bindings.sh

EXPOSE 5173
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:5173/ || exit 1
CMD ["pnpm", "run", "dockerstart"]
