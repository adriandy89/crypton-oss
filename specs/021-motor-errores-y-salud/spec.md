# 021 — Motor: errores que no se tragan, salud que dice la verdad y retención

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/021-motor-errores-y-salud`

## Objetivo

Que una credencial revocada o un castigo del venue detengan al bot **en el tick en que ocurren**, también
cuando el tick solo reemplaza órdenes; que ninguna promesa suelta pueda tumbar el worker entero por un
fallo de la base; que las escrituras «best-effort» y el reclamo de comandos dejen rastro cuando fallan; que
el proceso salga con código de error cuando muere por un fatal; que un fallo de Redis no cuente como fallo
de la fuente de precio; que la bitácora de actividad esté encendida por defecto en el despliegue como en los
`.env.example`; y que `bot_commands` tenga retención.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-06 | `safely()` se traga `AUTH` y `THROTTLED` en el camino de reemplazo | Alta |
| F-07 | Promesas sin `catch` con acceso a la base (`acquireFairPrice`, `NotifierService.onEvent`, `applyDetachments`) | Alta |
| F-18 | Escrituras best-effort mudas, `claimForBots` tragado, `/health` sano sin runners ni Redis, `exit(0)` en fatales | Media |
| F-40 | Un fallo de Redis al cachear cuenta como fallo de la fuente de precio externa | Baja |
| F-41 | `AUDIT_LOG_ENABLE` vale `false` en el compose y `true` en `.env.example` | Baja |
| F-39 | `bot_commands` y `bot_config_revisions` sin retención ni mención | Baja |

## Alcance

- `apps/worker/src/engine/{bot-runner,bot-store,command-inbox.service,engine.service,lease.service,retention.service}.ts`,
  `apps/worker/src/notifications/notifier.service.ts`, `apps/worker/src/marketdata/price-source.service.ts`,
  `apps/worker/src/main.ts`; `docker/docker-compose.yml`; `apps/worker/.env.example`.
- Tests: `bot-runner.spec.ts`, `price-source.service.spec.ts`, `retention.service.spec.ts` (nuevo),
  `health.spec.ts` (nuevo).

## Fuera de alcance

- Purgar `bot_config_revisions`: son el historial de cambios de configuración y la revisión vigente vive ahí
  (`bot.config_version` apunta a una fila). Se documenta como conservación deliberada.
- Reiniciar el contenedor desde el healthcheck: Docker no reinicia por «unhealthy» sin un orquestador; el
  worker ya devuelve 503 y el proceso sale con código 1 en un fatal para que `restart: unless-stopped` actúe.

## Requisitos

- **R-1** (F-06) `safely()` relanza `AUTH` y `THROTTLED`: llegan a `onTickError` como en el camino de
  `toPlace` (estado `ERROR`, `AUTH_ERROR` y desenganche; o dejar de insistir).
- **R-2** (F-07) Las promesas sueltas con acceso a la base llevan `catch` con registro: `acquireFairPrice`,
  la suscripción del notificador y `applyDetachments`.
- **R-3** (F-18) Las escrituras best-effort de `BotStore` y `CommandInbox` registran un WARN al fallar en vez de
  callar; `drainCommands` registra un ERROR cuando el reclamo falla («la base no responde: los comandos
  esperan»); `/health` es 503 también cuando los leases llevan más de un TTL sin confirmarse (Redis caído);
  un fatal (`unhandledRejection`, `uncaughtException`) sale con código 1 y una señal con 0.
- **R-4** (F-40) Cachear el precio en Redis va fuera del camino de fallo del feed: si Redis falla se anota y el
  precio sigue valiendo.
- **R-5** (F-41) `AUDIT_LOG_ENABLE` por defecto `true` en el compose (API y worker), como en los `.env.example`.
- **R-6** (F-39) `RETENTION_COMMAND_DAYS` (90) purga los comandos **ejecutados** más antiguos; las revisiones
  de configuración se conservan a propósito y el comentario de la clase lo dice.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-6 en verde; `pnpm --filter worker test`, `pnpm test`, `pnpm lint`, `pnpm check:env`.
- **CA-2** Fichas de los seis hallazgos con la decisión; `docs/` no los cita.

## Riesgos

- R-1 hace que un `THROTTLED` durante un reemplazo cuente como error de tick (el bot deja de insistir durante
  el castigo): es el propósito.
- R-5 enciende la bitácora de actividad en despliegues que no fijaban la variable: guarda la IP de las
  peticiones de la API; el `.env.example` ya lo dejaba encendido y lo explica.

## Referencias oficiales

Ninguna regla de venue: son contratos internos del motor.
