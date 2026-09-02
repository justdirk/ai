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

# ---- dirk.it simplification for non-technical users ----
# Fixed model (Kimi K2 via the dirk.it gateway) + default provider = OpenAILike,
# so students never pick a model or paste a key.
RUN sed -i "s/export const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';/export const DEFAULT_MODEL = 'kimi-k2';/" app/utils/constants.ts \
  && sed -i "s/export const DEFAULT_PROVIDER = llmManager.getDefaultProvider();/export const DEFAULT_PROVIDER = PROVIDER_LIST.find((p) => p.name === 'OpenAILike') ?? llmManager.getDefaultProvider();/" app/utils/constants.ts
# Trimmed prompt box (no model/API-key controls; keeps the enhance button)
COPY ChatBox.tsx app/components/chat/ChatBox.tsx
# ---- dirk.it gate: members only (signed .dirk.it cookie from gate.dirk.it) ----
COPY _middleware.ts functions/_middleware.ts
RUN sed -i 's/^interface Env {/interface Env {\n  GATE_COOKIE_SECRET: string;\n  GATE_LOGIN_URL: string;\n  GATE_BYPASS: string;/' worker-configuration.d.ts \
  && grep -q GATE_COOKIE_SECRET worker-configuration.d.ts
# Friendlier intro copy
RUN sed -i 's/Where ideas begin/Build an app by describing it/' app/components/chat/BaseChat.tsx \
  && sed -i 's/Bring ideas to life in seconds or get help on existing projects./Tell me what to build in plain language and I will write the code and run it live./' app/components/chat/BaseChat.tsx

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
