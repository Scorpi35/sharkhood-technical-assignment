# syntax=docker/dockerfile:1

# --- base: same npm major as the one that wrote package-lock.json ---------
# node:22-alpine ships npm 10, which resolves peer deps differently from npm 11
# and rejects the lockfile in `npm ci`.
FROM node:22-alpine AS base
RUN npm install -g npm@11.17.0 && npm cache clean --force
WORKDIR /app

# --- deps: full install for building -------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts: nothing we build needs install scripts, and it stops
# mongodb-memory-server (dev dep) downloading a mongod binary into the image.
RUN npm ci --ignore-scripts

# --- build ----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: runtime dependencies only ---------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
# APP_ROLE (api | worker | all) picks what this container runs.
CMD ["node", "dist/main.js"]
