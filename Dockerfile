# OweMe API — production container.
#
# Railway (or any host) builds this image as-is: no build/start commands to
# configure in the dashboard. Everything OweMe-specific lives here.
#
# Why a Dockerfile at all: local dev and the contract-test suite run on SQLite
# (zero external services). Production runs on PostgreSQL. Prisma bakes the
# datasource dialect into the generated client, so the provider must be
# `postgresql` when the client is generated for prod — we flip it for THIS
# image only, leaving the repo (and the green SQLite test gate) untouched.

FROM node:22-slim

# Prisma's query engine needs OpenSSL present at build and runtime.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (the Nest CLI, Prisma CLI and ts-node are devDependencies
# and are needed to build, sync the schema, and seed).
COPY package*.json ./
RUN npm ci

COPY . .

# Point the datasource at Postgres for the production client + build.
# (SQLite stays in the committed schema so `npm run test:ci` keeps working.)
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma \
    && npx prisma generate \
    && npm run build

ENV NODE_ENV=production

# Railway injects PORT; the app reads it (defaults to 3000 locally).
EXPOSE 3000

# On boot: sync the schema to Postgres (idempotent — a no-op once tables exist),
# then start the API. Seed the 5 plans once, separately (see the deploy guide).
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main"]
