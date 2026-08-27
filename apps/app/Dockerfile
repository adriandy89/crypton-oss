# syntax=docker/dockerfile:1
#
# Cliente web de CRYPTON. Es la MISMA aplicacion que la de Android: el mismo
# codigo Angular/Ionic, compilado para navegador y servido por nginx.
#
# Se construye desde la RAIZ del monorepo (context: ..) porque depende de
# packages/* por workspace: un contexto limitado a apps/app no podria
# resolverlos.

ARG NODE_VERSION=24-alpine
ARG NGINX_VERSION=1.27-alpine

# ── Dependencias ─────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
RUN corepack enable
WORKDIR /app

# Solo los manifiestos primero: mientras no cambien, Docker reutiliza la capa de
# instalacion aunque cambie todo el codigo fuente.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/strategy-core/package.json packages/strategy-core/
COPY packages/exchange-core/package.json packages/exchange-core/
COPY apps/app/package.json apps/app/

# --ignore-scripts en las DOS fases, al contrario que en la imagen de la API.
# El unico postinstall del workspace es el de @crypton/db, que ejecuta
# `prisma generate`; el cliente web no toca la base de datos, asi que arrastrar
# el motor de Prisma a esta imagen solo la haria mas lenta y mas grande.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── Compilacion ──────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY packages/ packages/
COPY apps/app/ apps/app/
RUN pnpm install --frozen-lockfile --prefer-offline --ignore-scripts

# El orden importa: strategy-core importa tipos de shared.
RUN pnpm --filter @crypton/shared build \
 && pnpm --filter @crypton/strategy-core build

# La configuracion `docker` deja la URL de la API en /api/v1 —relativa— porque
# nginx sirve las dos cosas desde el mismo origen. Ver nginx.conf.
RUN pnpm --filter app exec ng build --configuration docker

# ── Produccion ───────────────────────────────────────────────────
# Imagen `unprivileged`: nginx corre como uid 101 y escucha en 8080, sin root
# dentro del contenedor. Mismo criterio que el `USER node` de la API.
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS production

COPY apps/app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/app/www /usr/share/nginx/html

EXPOSE 8080
