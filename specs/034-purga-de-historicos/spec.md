# 034 — Purga de históricos desde la consola

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/034-purga-de-historicos`

## Objetivo

Que un administrador pueda **ver cuánto ocupa cada histórico y purgar lo que ya no se usa**,
eligiendo la antigüedad (15 días, 1 mes, 3 meses, 6 meses), sin que ninguna de esas purgas pueda
tocar datos de un bot en marcha.

## Contexto

La purga automática **ya existe** y funciona: `apps/worker/src/engine/retention.service.ts` corre
cada hora con `@nestjs/schedule`, detrás de un cerrojo en Redis (`crypton:lock:retention`, porque
`@Cron` dispara en todas las réplicas), y borra por lotes de 5.000 con tope de 40 por pasada. Sus
seis variables —`RETENTION_SNAPSHOT_DAYS=30`, `RETENTION_EVENT_DAYS=90`,
`RETENTION_CRITICAL_EVENT_DAYS=365`, `RETENTION_COMMAND_DAYS=90`, `RETENTION_AUDIT_DAYS=180`,
`RETENTION_PORTFOLIO_DAYS=365`— están declaradas en `.env.example` y en el compose.

Lo que no existe es la parte manual: no hay forma de saber cuánto hay guardado ni de limpiar algo
concreto sin esperar a la hora en punto y sin cambiar una variable de despliegue.

Y hay un hueco real: **`backtest_runs` y `backtest_fills` no los purga nadie**. Ningún cron los
toca y cada backtest genera muchos fills.

## Alcance

- `apps/api`: `modules/admin/admin-maintenance.{controller,service}.ts` y sus DTOs.
- `apps/app`: pantalla `/admin/maintenance`, colgada del índice de administración.
- `docs/administracion.md`: qué se puede purgar, qué no, y por qué.

## Fuera de alcance

- **Tocar `RetentionService` ni sus variables.** El cron ya hace lo suyo y no se duplica.
- **`bot_orders`, `bot_fills` y `bot_cycles`.** Son la reconciliación del motor —el worker lee
  órdenes por `status` y por `cycle_seq` (`bot-store.ts:195` y `:1037`)—, la contabilidad del PnL y
  el historial que ve el usuario. No se purgan por antigüedad simple.
- **`bot_config_revisions`.** `bot.config_version` apunta a una de sus filas.
- **Añadir `backtest_runs` al cron.** Entra en la purga manual; el automático se decide aparte.

## Requisitos

- **R-1** Ningún ámbito purgable puede borrar una fila que pertenezca a un bot **vivo**
  (`STARTING`, `RUNNING`, `PAUSED`, `STOPPING`). Es la restricción que gobierna todo el spec.
- **R-2** Cada ámbito tiene un **suelo** de días por debajo del cual no se puede purgar, y el
  servidor lo impone: `ACTIVITY_LOG` 90 días, el resto 15.
- **R-3** Los `bot_events` de gravedad `ERROR` y `CRITICAL` y las filas `CRITICAL` de
  `activity_log` **no se purgan nunca** desde el panel, sea cual sea la antigüedad elegida.
- **R-4** Antes de borrar se puede **contar**: un recuento previo dice cuántas filas caerían, sin
  borrar ninguna.
- **R-5** El borrado va **por lotes**, como el del worker, y toma un cerrojo **propio**
  (`crypton:lock:maintenance`). Compartir el del cron era un error: aquel se toma cada hora con
  TTL de 55 minutos y no se suelta, así que el endpoint habría respondido 503 casi siempre.
  Que las dos purgas coincidan es inocuo: las dos borran por `id IN (SELECT … LIMIT)`.
- **R-6** Purgar exige motivo y se audita como acción crítica.
- **R-7** El panel enseña, por ámbito: filas totales, filas purgables con la antigüedad elegida, la
  retención automática vigente y el suelo.

## Criterios de aceptación

- **CA-1** Un `it.each` sobre los seis ámbitos: con un bot vivo, sus filas **no** entran en el
  recuento ni en el borrado. (unitario)
- **CA-2** Pedir menos días que el suelo devuelve 400 y no borra nada; `ACTIVITY_LOG` a 30 días
  también. (unitario + e2e)
- **CA-3** Un evento `CRITICAL` de hace un año sobrevive a una purga de 15 días. (unitario)
- **CA-4** El recuento previo no borra: la cuenta de filas es la misma antes y después. (unitario)
- **CA-5** Sin el cerrojo, la purga no se ejecuta y lo dice. (unitario)
- **CA-6** Un USER normal recibe 403 en toda la superficie de mantenimiento. (e2e)
- **CA-7** `pnpm --filter app build` y `lint` pasan.
- **CA-8** *(manual)* Con la infra levantada, recorrer la pantalla y purgar snapshots de un bot
  **parado** de prueba.

## Riesgos

- **Es un borrado, y no hay deshacer.** Mitigación: recuento previo obligatorio en la pantalla,
  suelos en el servidor, exclusión de bots vivos, motivo y auditoría crítica.
- **Competir con el cron.** Mitigación: el mismo cerrojo de Redis; si no se puede tomar, no se
  ejecuta y se dice.
- **Un `DELETE` grande bloquea la tabla e hincha el WAL.** Mitigación: lotes, igual que el worker.
