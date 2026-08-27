# syntax=docker/dockerfile:1
#
# Imagen del worker (motor de bots). Se construye desde la RAIZ del monorepo.
#
# Va en una imagen aparte de la API a proposito: el motor mantiene WebSockets
# abiertos a los DEX y estado en memoria por bot, asi que no debe compartir
# ciclo de vida con el proceso web. Un despliegue de la API no debe tocar ni
# una sola orden.

# ── Por qué Debian y no Alpine ───────────────────────────────────
# El firmante de Lighter (zklighter-sdk) NO es JavaScript: es una librería
# nativa compilada en Go y enlazada contra GLIBC. Comprobado sobre el binario
# que trae el paquete, `dist/signers/lighter-signer-linux-amd64.so` pide
# `libc.so.6`, `libpthread.so.0` y `libresolv.so.2`, con símbolos versionados
# GLIBC_2.2.5, GLIBC_2.3.2 y GLIBC_2.14.
#
# Alpine no lleva glibc sino musl, así que ahí no existe ninguna de las tres y
# el cargador dinámico se rompe justo al firmar —nunca al construir la imagen—:
#
#   Failed to load signer library from .../lighter-signer-linux-amd64.so:
#   Error loading shared library libresolv.so.2: No such file or directory
#
# `gcompat` NO lo arregla: resuelve el nombre de la librería y el fallo se
# mueve una capa más abajo, a la reubicación del TLS que hace el runtime de Go
# —«seteuid: initial-exec TLS resolves to dynamic definition»—. Comprobado.
#
# Y no hay forma de esquivarlo eligiendo otro binario: el SDK escoge el fichero
# SOLO por `os.platform()` y `os.arch()` (`dist/signer.js`, `initialize_signer`),
# no distingue libc, y el paquete no publica ninguna variante para musl.
#
# El firmante hace falta en las DOS imágenes: el worker firma órdenes y la API
# llama a `check_client()` al verificar una credencial (`adapter.verify()`).
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/strategy-core/package.json packages/strategy-core/
COPY packages/exchange-core/package.json packages/exchange-core/
COPY apps/worker/package.json apps/worker/

# --ignore-scripts aqui es obligatorio: el postinstall de @crypton/db ejecuta
# `prisma generate`, que necesita el esquema, y en esta fase solo hay
# manifiestos. Los scripts se ejecutan en la fase siguiente.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY packages/ packages/
COPY apps/worker/ apps/worker/

# Segunda pasada CON scripts, ya con las fuentes presentes. Hacen falta dos:
#   · Prisma produce su ejecutable en su propio postinstall.
#   · koffi, el firmante nativo de Lighter, compila su binding aqui; sin el, la
#     firma de ordenes falla en tiempo de EJECUCION, no al instalar.
RUN pnpm install --frozen-lockfile --prefer-offline

RUN pnpm --filter @crypton/shared build \
 && pnpm --filter @crypton/strategy-core build \
 && pnpm --filter @crypton/exchange-core build \
 && pnpm --filter worker build

FROM node:${NODE_VERSION} AS production
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

# ── Certificados raiz ────────────────────────────────────────────
# El firmante de Lighter habla por su cuenta con el venue: `check_client()`
# llama a `/api/v1/apikeys` DESDE la libreria de Go, no desde Node. Node trae su
# propio almacen de CA compilado dentro, pero Go usa el del sistema, y
# `bookworm-slim` viene sin ninguno:
#
#   tls: failed to verify certificate: x509: certificate signed by unknown authority
#
# La imagen de Alpine si los traia, asi que este paquete es lo que hay que
# reponer al cambiar de base. Es tambien la razon de que el .so pida
# `libresolv.so.2`: resuelve DNS por su cuenta.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── Comprobacion del firmante nativo de Lighter ──────────────────
# Se carga la libreria AQUI, en la imagen final, porque lo que puede fallar es
# la libc de la base y no el codigo: en la de compilacion pasaria siempre.
#
# Sin esto el fallo salia en produccion, en la primera credencial de Lighter que
# alguien intentaba verificar, y con un mensaje que no señalaba a la imagen.
# Ahora rompe el build, que es donde se arregla.
# Y que hay CA raiz para la llamada TLS que hace la propia libreria.
RUN test -s /etc/ssl/certs/ca-certificates.crt \
 && cd /app/packages/exchange-core \
 && node -e "const {create_api_key}=require('zklighter-sdk');const r=create_api_key('');if(r[2])throw new Error(r[2]);console.log('firmante nativo de Lighter: CARGA')"

USER node

WORKDIR /app/apps/worker
CMD ["node", "dist/main"]
