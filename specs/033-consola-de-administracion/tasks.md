# 033 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/033-consola-de-administracion` creada desde `main` limpia
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e) — resultado anotado
- [x] `pnpm lint`

## Fase 1 — Revocación inmediata de sesión

No cambia ninguna conducta hasta la tarea del `JwtStrategy`; los tres primeros pasos son aditivos.

- [x] `CacheService.isReady` + `getOrThrow()` + `CacheUnavailableError` (aditivo)
- [x] `SessionRevocationService` + `session-revocation.service.spec.ts`
- [x] `TokenService.accessTtl` + `revokeAll()` delegando + `token.service.spec.ts`
- [x] `JwtStrategy` async con `iat`, comentario reescrito + `jwt.strategy.spec.ts`
- [x] `BotsSseService.dropUser()` + canal `AUTH_REVOKED` en el bus + spec
- [x] `pnpm --filter api test` en verde

## Fase 2 — El actor de un comando

- [x] `bots-command-actor.spec.ts` **escrito primero y fallando**
- [x] `CommandOptions.requestedBy`, severidad `WARN` por terceros, `userId` del dueño en el bus
- [x] Regresión del camino normal verificada carácter a carácter

## Fase 3 — Módulo admin en la API

- [x] `admin/dtos/index.ts`: DTOs de entrada y tipos de salida
- [x] `AdminUsersService` + controlador + `admin-users.service.spec.ts`
- [x] `AdminBotsService` (lecturas con `ownerOf`) + controlador + `admin-bots.service.spec.ts`
- [x] Comandos de contención + `admin-bots-command.spec.ts` + aviso SSE al dueño
- [x] `admin.module.ts`, registro en `app.module.ts`, `admin-guards.spec.ts`
- [x] Migración `idx_bot_status_created` + `pnpm prisma:migrate`
- [x] Bloque `administración` en `apps/api/test/isolation.e2e-spec.ts`

## Fase 4 — La app

- [x] `core/models/paging.ts` con `Paginated<T>` y `PageMeta`; `ActivityPage` pasa a usarlo
- [x] `AdminUsersService` y `AdminBotsService` en `core/services/` (fuera del barril)
- [x] Ruta padre `/admin` con `children`, página índice, enlace en Cuenta, `defaultHref` de Actividad
- [x] `<admin-forbidden />` y su adopción en `activity.page.ts`
- [x] Usuarios: listado y ficha
- [x] Bots: listado y ficha
- [x] Confirmaciones con `AlertController` y motivo que viaja a la bitácora
- [x] `pnpm --filter app build` y `pnpm --filter app lint`

## Fase 5 — Entorno y documentación

- [x] `AUTH_REVOCATION_FAIL_OPEN` y `AUTH_REVOCATION_STALE_MAX_MS` en `.env.example` y compose
- [x] `pnpm check:env`
- [x] `docs/`: la consola, sus límites, el fail-open como «Limitación conocida» y que deshabilitar
      no para los bots

## Cierre

- [x] Criterios de aceptación repasados: CA-1..CA-10 verificados; **CA-11 es manual y queda pendiente del usuario**
- [x] `pnpm test` en verde: 92 shared + 300 strategy-core + 365 exchange-core + 31 backtest +
      326 worker + 4277 api
- [x] `pnpm --filter api test:e2e`: 87 de 88; el que falla es ajeno y está en `findings.md` (F-01)
- [x] `pnpm lint` sin errores; `pnpm check:env` coherente
- [x] Índice de `specs/README.md` actualizado
- [x] `CLAUDE.md` actualizado si cambió algo que deba saber toda sesión
- [x] Memoria de usuario actualizada si hay decisiones que sobrevivan al spec
