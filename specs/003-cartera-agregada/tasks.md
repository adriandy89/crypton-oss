# 003 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Aprobación y línea base

- [x] Preguntas abiertas del `spec.md` contestadas (borrados, cadencia, retención) — 2026-09-05, con las propuestas del borrador
- [x] Rama `spec/003-cartera-agregada` creada desde `ffdfded`
- [x] `pnpm build:packages` — `shared` y `db` recompilados
- [x] Tests paquete a paquete — `shared` 55, `backtest` 24, `worker` 254 (+2 rojos del 001), `api` 4184 antes de tocar nada
- [x] `pnpm lint` — limpio en app y API (los dos avisos de `venue-matrix.spec.ts` son previos)
- [x] `pnpm check:env` — coherente

## Fase 1 — Función pura y contrato

- [x] `apps/worker/src/engine/portfolio-aggregate.ts` + `portfolio-aggregate.spec.ts` — 5 tests (`5f85b42`)
- [x] `packages/shared/src/portfolio.ts` exportado desde `index.ts` — y `gapMsFor(bucket, cadencia)` con test (`8133974`)

## Fase 2 — Migración

- [x] Modelo `PortfolioSnapshot` en `schema.prisma`, con la relación inversa en `User`
- [x] Migración `20260905200000_portfolio_snapshots`: SQL generado con `prisma migrate diff` y comentado; solo `CREATE TABLE`, índice y clave ajena
- [x] Aplicada en local con `pnpm prisma:deploy` (nunca `migrate dev`, que puede proponer un reset) sobre la base con datos. **Sorpresa**: la migración `20260827090000_backtests` estaba pendiente en esta base y se aplicó en la misma pasada; también es solo aditiva. `pnpm build:packages` regenera el cliente

## Fase 3 — Cron, purga y variables

- [x] `portfolio-snapshots.service.ts` con `@Cron` cada 5 min, `tryLock` (4 min), e interruptor `PORTFOLIO_SNAPSHOTS_ENABLE`
- [x] `portfolio-snapshots.spec.ts` — 7 tests: sin cerrojo no escribe, apagado no lo intenta, una fila por (usuario, red), corte de frescura de diez minutos, fallo tragado
- [x] `purgePortfolio` en `RetentionService.purge()` con `RETENTION_PORTFOLIO_DAYS`, dentro de la guarda y del log
- [x] Variables en los dos `.env.example` (la API la lee para `retentionFrom`) y en el compose; `pnpm check:env` en verde
- [x] Las tres consultas (agregado, fuentes del cron, purga) ejecutadas contra el Postgres local con `prisma db execute`: sintaxis y columnas correctas
- [ ] Comprobado con dos réplicas: una fila por (usuario, red) y cinco minutos — **a mano, con la infra y dos workers** (CA-3)

## Fase 4 — API

- [x] Módulo `portfolio` con `GET /portfolio/equity`, DTO (`range` de la lista compartida, `testnet` con la misma transformación que `market-data`), caché 60 s (`fe1bffe`)
- [x] `portfolio.service.spec.ts` — 5 tests
- [x] `pnpm --filter api test` 4189 en verde; lint limpio

## Fase 5 — App

- [x] `portfolio.service.ts` (cliente), contrato reexportado en `core/models` (`fe0bc2d`)
- [x] Curva en el héroe con selector 24h / 7d / 30d / 1y, cero visible, ventana real rotulada, peor caída y aviso cuando `bots` baja; refresco acotado a la cadencia y a los cambios de ventana y red
- [x] `pnpm --filter app build` dentro de presupuesto (persiste el aviso previo de `bot-detail.page.scss`); lint limpio
- [ ] CA-4 y CA-5 a mano — necesitan un bot real (o testnet) con snapshots y el worker nuevo corriendo

## Cierre

- [x] Criterios de aceptación repasados uno a uno — CA-1, CA-2, CA-7, CA-8 cumplidos; CA-6 parcialmente (la consulta corre y usa el índice, pero no hay un año de filas con las que medir los 200 ms); **CA-3, CA-4 y CA-5 pendientes de la comprobación manual** con el worker nuevo en marcha
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-3..CA-5 estén comprobados
- [x] `README.md`: 19 tablas. `Resume.MD` no se toca: su lista de tablas ya estaba desfasada (001/F-20) y una corrección parcial engañaría más que ayudaría
- [x] Memoria de usuario actualizada
