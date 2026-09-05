# 003 — Plan

## Enfoque

Materializar, no calcular al vuelo. Una fila por usuario y red cada cinco minutos, escrita por el
worker a partir de los últimos snapshots de los bots reales, leída por la API con la misma
agregación por extremos que ya tiene `BotSeriesService`, y pintada por la app con el mismo
`ui-spark` que ya pinta la curva de un bot. Casi todo lo que hace falta ya existe; lo nuevo es la
tabla y el cron.

El orden es el de menor riesgo: primero la función pura y su test (sin base, sin Nest), después la
migración y el cron (con el interruptor por variable), después la API (solo lectura), y la pantalla
al final, cuando ya hay filas que pintar.

Alternativas descartadas:

- **Sumar las series de los bots en el cliente**: no hay dato más allá de 8 h sin el rango del
  servidor, son N peticiones, los bots borrados desaparecen del pasado, y es aritmética de dinero en
  una vista sin runner.
- **Agregar `bot_snapshots` al vuelo en la API**: mismo problema de los borrados, y un `GROUP BY`
  sobre decenas de miles de filas en cada apertura de la pestaña de aterrizaje.
- **Escribir la fila de cartera desde el tick del bot**: N bots de un usuario escribirían N veces
  la misma fila cada minuto, y metería una escritura más en el camino que coloca órdenes.
- **Un minuto de cadencia**: 1440 filas por usuario y día para una curva que a 480 puntos ni se
  nota; y un cron por minuto compitiendo con los ticks por la base.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/db/prisma/schema.prisma` | Modelo `PortfolioSnapshot` (tabla nueva) | `pnpm build:packages` |
| `packages/db/prisma/migrations/<ts>_portfolio_snapshots/migration.sql` | `CREATE TABLE` + índice | aplicación en local con datos |
| `packages/shared/src/portfolio.ts`, `index.ts` | `PortfolioEquityPoint`, `PortfolioEquitySeries`, `PortfolioRange` | typecheck de los consumidores |
| `apps/worker/src/engine/portfolio-aggregate.ts` | **Nuevo.** `aggregatePortfolio(filas)`: pura, `Decimal` | `portfolio-aggregate.spec.ts` (nuevo) |
| `apps/worker/src/engine/portfolio-snapshots.service.ts` | **Nuevo.** Cron 5 min tras `tryLock`, consulta los últimos snapshots, escribe | `portfolio-snapshots.spec.ts` (nuevo): con `DbService` y `LeaseService` de mentira, comprueba que sin cerrojo no escribe y que escribe una fila por (usuario, red) |
| `apps/worker/src/engine/engine.module.ts` | Registra el servicio | arranque del worker |
| `apps/worker/src/engine/retention.service.ts` | `purgePortfolio(days)` dentro de `purge()` | test existente de retención si lo hay; si no, uno nuevo mínimo |
| `apps/worker/.env.example`, `docker/docker-compose.yml` | `RETENTION_PORTFOLIO_DAYS`, `PORTFOLIO_SNAPSHOTS_ENABLE` | `pnpm check:env` |
| `apps/api/src/modules/portfolio/{portfolio.module,controller,service}.ts`, `dtos/index.ts` | **Nuevo.** `GET /portfolio/equity` con SQL por extremos y caché 60 s | `portfolio.service.spec.ts` (nuevo), mismo patrón que `bot-series.service.spec.ts` |
| `apps/api/src/app.module.ts` | Importa el módulo | arranque de la API |
| `apps/app/src/app/core/services/portfolio.service.ts` | **Nuevo.** Cliente del endpoint | typecheck |
| `apps/app/src/app/features/portfolio/portfolio.page.{ts,scss}` | La curva en el héroe con selector de ventana | build de la app |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Aprobación del usuario, rama, línea base | Preguntas abiertas contestadas; rojos conocidos anotados |
| 1 | `aggregatePortfolio` + spec, y el contrato en `shared` | Tests del worker en verde |
| 2 | Migración + modelo; `pnpm prisma:migrate` en local; `build:packages` | CA-1 |
| 3 | Cron con cerrojo e interruptor; purga; variables; `check:env` | CA-3, CA-7; filas apareciendo cada 5 min en local |
| 4 | API: módulo, endpoint, caché, spec | CA-6; `pnpm --filter api test` y lint |
| 5 | App: servicio y curva en el héroe | CA-4, CA-5 a mano; build dentro de presupuesto |
| 6 | Cierre: índice, `CLAUDE.md` si aplica (tabla nueva en el mapa de las 18 → 19), memoria | Estado `hecho` |

## Verificación

```bash
pnpm --filter worker test                # aggregate + snapshots + retención
pnpm --filter api test                   # portfolio.service.spec y el resto
pnpm build:packages && pnpm --filter api build && pnpm --filter worker build
pnpm --filter app build                  # presupuestos 2 MB / 6 kB
pnpm lint && pnpm check:env
```

Desde Git Bash. A mano, con la infraestructura levantada: aplicar la migración, arrancar **dos**
réplicas del worker y comprobar que cada cinco minutos aparece **una** fila por (usuario, red);
con un bot real en testnet (o dos), comparar la fila con la suma de sus últimos snapshots cifra a
cifra; borrar uno de los bots y comprobar que las filas anteriores no cambian y la siguiente baja
`bots` en uno. En la app, la curva del héroe debe romperse en los tramos sin fila y rotular la
ventana que cubre.
