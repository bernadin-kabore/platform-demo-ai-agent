# syntax=docker/dockerfile:1
FROM node:20.15.1-alpine3.20 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20.15.1-alpine3.20 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
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
