# syntax=docker/dockerfile:1
FROM node:22.23.2-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22.23.2-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# debian13, not debian12. The debian12 image ships openssl 3.0.18-1~deb12u2,
# which carries six HIGH/CRITICAL CVEs that Debian has already fixed in
# 3.0.20-1~deb12u2 -- including CVE-2026-45447, a heap use-after-free in
# PKCS7_verify. They are fixable, so --ignore-unfixed does not hide them and
# should not: the image scan is a gate precisely so a stale base cannot ship.
# The debian13 image at the same Node major scans clean, and its contract is
# identical -- entrypoint /nodejs/bin/node, uid 65532 -- so nothing below
# changes.
FROM gcr.io/distroless/nodejs22-debian13:nonroot AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# distroless nonroot images already run as uid 65532; no USER directive
# needed, and there's no shell to drop into even if a Kyverno policy or the
# PSS restricted profile were somehow bypassed. The agent holds a GitHub App
# private key in its environment, so "no shell in the image" is doing real
# work here rather than being a stylistic preference.
EXPOSE 8080
ENV NODE_ENV=production
ENTRYPOINT ["/nodejs/bin/node", "--import", "/app/dist/tracing.js", "/app/dist/index.js"]
