# syntax=docker/dockerfile:1

FROM node:20-bookworm AS builder
WORKDIR /app

ENV NODE_ENV=development

COPY package*.json ./
# Use npm install because this repo does not have a package-lock.json
RUN npm install

COPY tsconfig.json ./
COPY . .

RUN npm run build \
    && npm prune --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
