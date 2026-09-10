# 034 — Plan de implementación

## Enfoque

Un servicio nuevo en la API, no una llamada al worker. La purga manual la dispara una persona que
está mirando la pantalla y quiere ver el resultado: mandar un comando por el bus y esperar un
evento sería asíncrono, más piezas y peor respuesta. La API ya tiene `DbService`.

Se duplican unas diez líneas de borrado por lotes con el worker. Es a propósito: la alternativa
—un paquete compartido con SQL de Prisma— metería consultas de infraestructura en `packages/`,
que es dominio y aritmética de dinero. Diez líneas comentadas cuestan menos.

## Los seis ámbitos

| Ámbito | Tabla | Suelo | Qué NO toca nunca |
|---|---|---|---|
| `BOT_SNAPSHOTS` | `bot_snapshots` | 15 d | Bots vivos |
| `BOT_EVENTS` | `bot_events` | 15 d | Bots vivos; `ERROR` y `CRITICAL` |
| `BOT_COMMANDS` | `bot_commands` | 15 d | Bots vivos; los no ejecutados |
| `PORTFOLIO_SNAPSHOTS` | `portfolio_snapshots` | 15 d | Usuarios con algún bot vivo |
| `BACKTESTS` | `backtest_runs` (+ fills en cascada) | 15 d | — (un backtest no toca ningún bot) |
| `ACTIVITY_LOG` | `activity_log` | **90 d** | Las filas `CRITICAL` |

**La exclusión de bots vivos es la regla que gobierna el spec.** Se escribe una vez, como una
subconsulta `bot_id NOT IN (SELECT id FROM bots WHERE status IN (...))`, y la usan los tres ámbitos
que cuelgan de un bot. Para la curva de cartera el ancla es el usuario, así que la exclusión es
«usuarios sin ningún bot vivo»: purgar la curva de quien está operando le rompería el selector de
un año de su pantalla de Cartera.

`ACTIVITY_LOG` no excluye por bot —la bitácora es transversal y filtrar por eso no significaría
nada—: lo que la protege es el suelo de 90 días y que los `CRITICAL` no se tocan.

## Endpoints

| Verbo | Ruta | Qué hace |
|---|---|---|
| GET | `/admin/maintenance` | Estado: por ámbito, filas totales, retención automática vigente y suelo |
| POST | `/admin/maintenance/preview` | `{ scope, days }` → cuántas filas caerían. **No borra.** |
| POST | `/admin/maintenance/purge` | `{ scope, days, reason }` → borra por lotes. Audita crítico. |

`GET` da el total por tabla con `count()` acotado a lo purgable-en-principio; el recuento fino por
antigüedad lo da `preview`, que es lo que la pantalla llama al mover el selector.

## Ficheros

- `apps/api/src/modules/admin/admin-maintenance.service.ts` — los seis ámbitos en una tabla de
  definiciones (`scope → { tabla, columna de fecha, suelo, where extra }`), un `contar()` y un
  `purgar()` que la recorren. Sin un `switch` por ámbito repetido tres veces.
- `apps/api/src/modules/admin/admin-maintenance.controller.ts`

**Corregido en revisión:** el cerrojo NO se comparte con el del worker —aquel dura 55 minutos
y no se suelta— y el tope de lotes baja a 10 (50.000 filas) para caber en el timeout de 80 s
del interceptor global.
- DTOs en `admin/dtos/index.ts`: `PurgeScope`, `PurgeQueryDto`, `PurgeDto`.
- `apps/app/src/app/features/admin/maintenance.page.ts` + entrada en el índice y en las rutas.
- `apps/app/src/app/core/services/admin-maintenance.service.ts`

## Verificación

- `admin-maintenance.service.spec.ts`: la exclusión de bots vivos en los seis ámbitos, los suelos,
  la protección de lo grave, que `preview` no borra y que sin cerrojo no se ejecuta.
- Bloque en el e2e: 403 para un USER, 400 por debajo del suelo.
- `pnpm --filter app build` y `lint`.
