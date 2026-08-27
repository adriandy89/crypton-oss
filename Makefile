# ═══════════════════════════════════════════════════════════════
# CRYPTON — atajos de desarrollo
# ═══════════════════════════════════════════════════════════════
#
#   make           lista todo lo que hay
#   make api       arranca solo la API
#
# Cada proceso se levanta POR SEPARADO, en su propia terminal. No hay un target
# que los arranque todos: son procesos de larga duración con recarga en
# caliente, y multiplexarlos desde make mezclaría los logs y dejaría sin forma
# limpia de parar uno solo.
#
# ─── Los paquetes compartidos hay que COMPILARLOS ────────────────────────────
# apps/api y apps/worker no tienen `paths` a packages/*/src: resuelven
# @crypton/shared por el symlink de node_modules, que apunta a dist/index.js.
# Sin ese dist, la API ni compila ni arranca:
#
#   error TS2307: Cannot find module @crypton/shared
#   Error: Cannot find module ...\@crypton\exchange-core\dist\index.js
#
# `@crypton/db` no da el problema porque su postinstall se compila solo. Los
# otros tres, no. De ahí que `api` y `worker` dependan aquí de sus dist: si
# faltan, se construyen antes de arrancar.
#
# ─── Y para que los cambios salgan solos, hay que VIGILARLOS ─────────────────
# `make packages` deja un tsc --watch por paquete. Comprobado sobre esta
# instalación:
#
#   · cambias algo en packages/*/src  →  el watcher recompila su dist
#   · si el cambio altera el .d.ts    →  nest lo detecta y REINICIA la app
#   · si solo cambia el cuerpo de     →  nest NO reinicia: se queda con el
#     una función, sin tocar tipos       código viejo en memoria
#
# Ese último caso es una limitación de `nest start --watch`: su vigilante es el
# de TypeScript, que mira los .d.ts que entran en el programa, no los .js
# compilados de las dependencias. Si te pasa, Ctrl+C y `make api` otra vez.
#
# ─── Por qué los `echo` están escritos así ───────────────────────────────────
# Los recipes tienen que funcionar TAMBIÉN en cmd.exe: fuera de Git Bash, make
# no encuentra sh.exe y cae al shell de Windows. De ahí tres reglas en el texto
# que se imprime:
#
#   · sin comillas         cmd las imprimiría literalmente
#   · sin acentos          mojibake con la página de códigos de la consola
#   · un solo espacio      sh colapsa los espacios múltiples, cmd no; con uno
#     entre palabras       solo, la salida es idéntica en ambos. De ahí los
#                          puntos de relleno para alinear.
#
# Los comentarios sí llevan acentos: make nunca los imprime.

# El único compose que este fichero toca. El de la aplicación
# (docker/docker-compose.yml) queda deliberadamente fuera: aquí viven los datos
# y la separación entre ambos es justo lo que impide destruirlos por accidente.
INFRA := docker compose -f docker/docker-compose.infra.yml

# Los ficheros que api y worker necesitan que existan. `db` lleva su dist un
# nivel más abajo porque su package.json apunta a dist/src/index.js.
PKG_DIST := packages/shared/dist/index.js \
  packages/strategy-core/dist/index.js \
  packages/exchange-core/dist/index.js \
  packages/db/dist/src/index.js

.DEFAULT_GOAL := help

# `bootstrap` encadena sus prerequisitos y el orden importa. Sin esto, un
# `make -j bootstrap` los lanzaría a la vez y migraría contra una base que
# todavía no existe.
.NOTPARALLEL:

.PHONY: help api api-debug worker app android packages packages-build infra infra-down infra-logs infra-ps db-deploy db-migrate db-studio db-generate install setup check-env bootstrap build lint test

help:
	@echo CRYPTON - comandos de desarrollo
	@echo -----------------------------------------------------------------
	@echo FLUJO - una terminal por linea, en este orden
	@echo 1. make infra ..... Postgres y Redis en Docker
	@echo 2. make packages .. watchers de los paquetes compartidos
	@echo 3. make api ....... y en otras terminales worker o app
	@echo -----------------------------------------------------------------
	@echo APPS - cada una en su propia terminal
	@echo make api ......... API NestJS con watch, http://localhost:3200
	@echo make api-debug ... idem, con el inspector de Node en el 9229
	@echo make worker ...... motor de bots con watch, sin puerto HTTP
	@echo make app ......... app Ionic/Angular, http://localhost:8100
	@echo make android ..... app en dispositivo o emulador con live reload
	@echo -----------------------------------------------------------------
	@echo PAQUETES COMPARTIDOS - shared, strategy-core, exchange-core, db
	@echo make packages ....... watchers tsc, dejalo en su terminal
	@echo make packages-build . compilacion unica, sin watch
	@echo -----------------------------------------------------------------
	@echo INFRAESTRUCTURA - Postgres en 5341, Redis en 6381
	@echo make infra ....... levanta los contenedores y espera a healthy
	@echo make infra-down .. los para SIN borrar volumenes
	@echo make infra-logs .. sigue los logs
	@echo make infra-ps .... estado y puertos publicados
	@echo -----------------------------------------------------------------
	@echo BASE DE DATOS
	@echo make db-deploy ... aplica las migraciones ya existentes
	@echo make db-migrate .. crea una migracion nueva desde el esquema
	@echo make db-studio ... Prisma Studio, http://localhost:5555
	@echo make db-generate . regenera el cliente de Prisma
	@echo -----------------------------------------------------------------
	@echo PREPARACION
	@echo make install ..... pnpm install en todo el workspace
	@echo make setup ....... genera los .env con los secretos compartidos
	@echo make check-env ... cruza codigo, .env.example y compose
	@echo make bootstrap ... deja el entorno listo de cero, de una vez
	@echo -----------------------------------------------------------------
	@echo CALIDAD
	@echo make build ....... compila todo el workspace
	@echo make lint ........ eslint en todo el workspace
	@echo make test ........ los tests de todos los paquetes

# ═══════════════════════════════════════════════════════════════
# Paquetes compartidos
# ═══════════════════════════════════════════════════════════════

# Un tsc --watch por paquete, en paralelo. `db` se queda fuera solo: no tiene
# script `dev` y pnpm lo salta sin protestar.
packages:
	pnpm --parallel --filter "./packages/**" run dev

packages-build:
	pnpm run build:packages

# Target AGRUPADO (`&:`): una sola pasada de build produce los cuatro dist. Sin
# el `&`, make ejecutaría el recipe una vez por cada fichero que falte.
$(PKG_DIST) &:
	pnpm run build:packages

# ═══════════════════════════════════════════════════════════════
# Apps — desarrollo en el host, contra la infra en Docker
# ═══════════════════════════════════════════════════════════════

# Dependen de los dist, no del target `packages`: así se construyen si faltan,
# pero no se rehacen en cada arranque, que pelearía con el watcher.
api: $(PKG_DIST)
	pnpm --filter api start:dev

api-debug: $(PKG_DIST)
	pnpm --filter api start:debug

worker: $(PKG_DIST)
	pnpm --filter worker start:dev

app: $(PKG_DIST)
	pnpm --filter app start

# El WebView no tiene dev server que haga de proxy, así que la app apunta a la
# IP absoluta de environment.device.ts. Si no carga, es casi siempre eso.
android: $(PKG_DIST)
	pnpm --filter app exec ionic cap run android -l --external

# ═══════════════════════════════════════════════════════════════
# Infraestructura — Postgres + Redis
# ═══════════════════════════════════════════════════════════════

# `--wait` bloquea hasta que los healthchecks pasan. Sin él, un db-deploy
# inmediatamente después puede encontrarse Postgres aceptando conexiones pero
# todavía sin terminar de inicializar.
infra:
	$(INFRA) up -d --wait

# Sin `-v`, y no es un descuido: `down -v` aquí borra las credenciales de
# exchange cifradas y el histórico de los bots.
infra-down:
	$(INFRA) down

infra-logs:
	$(INFRA) logs -f

infra-ps:
	$(INFRA) ps

# ═══════════════════════════════════════════════════════════════
# Base de datos
# ═══════════════════════════════════════════════════════════════

db-deploy:
	pnpm run prisma:deploy

db-migrate:
	pnpm run prisma:migrate

db-studio:
	pnpm --filter @crypton/db run studio

db-generate:
	pnpm --filter @crypton/db run generate

# ═══════════════════════════════════════════════════════════════
# Preparación
# ═══════════════════════════════════════════════════════════════

install:
	pnpm install

# No pisa los .env que ya existan. Para regenerarlos:
#   node scripts/setup-env.mjs --force
# Ojo: eso cambia la clave maestra y las credenciales guardadas dejan de poder
# descifrarse.
setup:
	pnpm run setup

check-env:
	pnpm run check:env

# `setup` va antes que `packages-build` a propósito: el build de @crypton/db
# lanza `prisma generate`, que lee DATABASE_URL de apps/api/.env.
bootstrap: install setup packages-build infra db-deploy
	@echo Listo. Ahora una terminal por proceso: make packages / make api / make worker

# ═══════════════════════════════════════════════════════════════
# Calidad
# ═══════════════════════════════════════════════════════════════

build:
	pnpm run build

lint:
	pnpm run lint

test:
	pnpm run test
