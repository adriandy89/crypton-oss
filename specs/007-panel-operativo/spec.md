# 007 — Panel operativo

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/007-panel-operativo` · Base: `95b46c7` (punta de `spec/006-historial-y-cronologia`; el usuario pidió el 2026-09-05 «continúa los specs siguientes»)

## Objetivo

Que quien administra la plataforma conteste **«¿qué ha pasado hoy y qué ha fallado?»** sin abrir
la base: una pantalla de administración sobre `activity_log`, que ya se escribe y ya se sirve
(`GET /admin/activity` y `GET /admin/activity/summary`) y **no tiene ninguna pantalla**.

Estará conseguido cuando desde Cuenta → Administración se llegue a un panel con el resumen por
acción de la ventana elegida, un interruptor «solo fallos», filtros por actor y severidad, y la
lista paginada de registros con lo que hace falta para seguir el hilo (acción, resultado, actor,
bot, ruta, estado HTTP, duración, cuándo).

## Contexto

Seguimiento **007** propuesto por `specs/002-app-analitica/findings.md` (propuesta P-13). La
bitácora nació en el 001 para dejar rastro de lo que antes solo iba a stdout: accesos, altas y
bajas de credenciales, cambios de límites, fallos HTTP, leases perdidos, cancelaciones de
emergencia. Los dos endpoints existen con sus filtros (`ActivityQueryDto`) y paginación
(`PageDto`), solo para `ADMIN` (`RolesGuard`). Sin pantalla, la tabla solo la lee quien tenga
`psql`.

## Alcance

- `apps/app/src/app/features/admin/activity.page.ts` (**nuevo**), ruta `admin/activity` tras
  `authGuard` y `adminGuard`, enlace en Cuenta junto a Backtest.
- `apps/app/src/app/core/services/activity.service.ts` (**nuevo**) y sus modelos.
- `packages/shared/src/activity.ts` (**nuevo**): `resumenPorAccion`, pura y con spec.
- `apps/api`: **nada**. Los endpoints se usan tal cual.

## Fuera de alcance

Alertas o avisos push; series temporales de la bitácora (no hay endpoint agregado por tiempo y
`summary` agrupa por acción); exportar; actuar sobre usuarios o bots desde el panel (no existe
ningún endpoint de administración para eso); tocar `AuditService` o la lista blanca de `meta`.

## Requisitos

- **R-1** Línea base registrada.
- **R-2** Ventana del resumen: 24 h, 72 h o 7 d (`GET /admin/activity/summary?hours=`). El
  resumen se pinta por acción, con `OK`, `DENIED` y `ERROR` como barra apilada (`ui-meter`) y las
  cifras; ordenado por total. La agregación de las filas del servidor es `resumenPorAccion`, con test.
- **R-3** Lista paginada (`limit` 50, «Cargar más» hasta agotar `hasNextPage`), de la más nueva a
  la más vieja, con filtros: «solo fallos» (`onlyFailures`), actor (`ActorKind`), severidad
  (`EventSeverity`), prefijo de acción (texto). Cambiar un filtro vuelve a la página 1.
- **R-4** Cada registro enseña severidad (badge), acción, resultado, actor (tipo e id
  abreviado), bot abreviado si lo hay, ruta + método + estado HTTP + duración, y cuándo (`ago`).
  `message` y `meta` van plegados; la **`ip` no se pinta** en la lista —es un dato personal y la
  tabla se purga por eso—, solo dentro del desplegable de la fila.
- **R-5** Un 403 del servidor —un token con rol viejo— se dice con un aviso y un enlace de vuelta,
  no con una pantalla vacía. El `adminGuard` es comodidad; la autoridad es el servidor.
- **R-6** Sin registros en la ventana se dice («Nada en las últimas 24 h»), no se pinta una lista
  vacía. Con `AUDIT_LOG_ENABLE` apagado la pantalla lo explica: no hay forma de saberlo desde la
  API, así que el vacío lleva esa posibilidad escrita.

## Criterios de aceptación

- **CA-1** `resumenPorAccion` tiene spec; `pnpm --filter @crypton/shared test` en verde.
- **CA-2** La ruta `admin/activity` no aparece en la barra de nadie y desde una cuenta sin rol
  `ADMIN` redirige a `/tabs/bots` (mismo guard que Backtest).
- **CA-3** Con registros en la base, el resumen y la lista se pintan y «Cargar más» trae la página
  siguiente sin repetir filas. Se comprueba a mano con una cuenta ADMIN.
- **CA-4** `pnpm --filter app build` dentro de presupuesto (la hoja de la pantalla nueva por debajo
  de 6 kB); lint limpio.

## Riesgos

- **Volumen.** Con `AUDIT_LOG_ENABLE` encendido la tabla crece con cada fallo HTTP; la lista va
  paginada a 50 y el resumen lo agrega el servidor (tope 50 acciones). Nada se trae entero.
- **Datos personales.** La `ip` está en la respuesta; la pantalla la esconde en la lista y la
  enseña solo al desplegar. Es la misma tabla que se purga con `RETENTION_AUDIT_DAYS`.

## Preguntas abiertas

Ninguna: la pantalla consume lo que hay.

## Referencias oficiales

Ninguna. Referencias internas: `apps/api/src/modules/activity/*`, `packages/shared/src/enums.ts`
(`ActorKind`, `EventSeverity`, `AuditOutcome`), `apps/app/src/app/features/admin/backtest.page.ts`
(la otra pantalla de administración, cuyo patrón se sigue).
