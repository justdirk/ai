# dirk.it overlay build of bolt.diy
# Builds bolt.diy from source and applies dirk.it branding:
#   - favicon.svg / favicon.ico / apple-touch icons (generated at build)
#   - social share preview (og:image)
#   - page <title> + meta, header wordmark
# Serves exactly like upstream (wrangler on :5173).
# Pinned to a known-good commit so the overlaid source files match; bump to update.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV HUSKY=0
ENV CI=true

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates librsvg2-bin fonts-dejavu-core python3 python3-pip python3-pil \
  && rm -rf /var/lib/apt/lists/*

# Clone bolt.diy at a known-good commit
RUN git clone https://github.com/stackblitz-labs/bolt.diy.git . \
  && git checkout 2e254ac19a696394030601bc602f54945b12bfc4

# ---- dirk.it branding overlay ----
# vector favicon + patched source (title/meta/og + header wordmark)
COPY favicon.svg public/favicon.svg
COPY _index.tsx app/routes/_index.tsx
COPY Header.tsx app/components/header/Header.tsx
# raster icons + social preview, generated from the vector mark at build time
COPY gen_assets.py /tmp/gen_assets.py
RUN rsvg-convert public/favicon.svg -w 512 -h 512 -o /tmp/mark512.png \
  && python3 /tmp/gen_assets.py \
  && rm -f /tmp/gen_assets.py /tmp/mark512.png

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
