# 037 — Tareas

Una casilla por tarea. Cada arreglo lleva **su test que falla primero**: se anota la salida del
fallo antes de tocar el código, para que conste que falla **por el motivo declarado**.

## Fase 0 — Línea base

- [x] Rama `spec/037-combinaciones-de-market-maker` creada desde `main` limpia (`180af9b`)
- [x] `pnpm build:packages` — verde
- [x] `pnpm test` (sin e2e) — **exit 0**. `strategy-core` 314 tests / 7 suites; `apps/api` 4307 / 35
- [x] `pnpm lint` — limpio (dentro de `pnpm test`… se repite al cierre)
- [x] `pnpm check:env` — entorno coherente

## Fase 1 — R-1: el ensanchado por inventario deja de anular el modo defensivo

- [x] Test que falla: ocupación 70 %, `dynamicSpread: true`, base 20 ⇒ el lado que reduce hoy sale
      a 20,4 bps y debería salir a 12
- [x] Test que falla: ocupación 90 % ⇒ hoy 19,0 bps, debería 10
- [x] Test que **pasa** y debe seguir pasando: el lado que añade conserva `× 1,7 × 1,5`
- [x] Arreglo en `market-maker.ts`: `spreadWiden` solo al lado que añade
- [x] `pnpm test:strategies` verde
- [x] Commit `fix(strategy-core): el ensanchado por inventario no aleja la salida (spec 037 R-1)`

## Fase 2 — R-2: la V2 no coloca dos órdenes al mismo precio

- [x] Test que falla: `validate()` con `layers: 3`, `layerDistanceMultiplier: '1'` ⇒ issue
- [x] Test que falla: `plan()` con esa config ⇒ hoy tres `QUOTE_BID` al mismo precio
- [x] Arreglo: ERROR en `validate()` + colapso de capas repetidas en `plan()`
- [x] Corregir el comentario mentiroso de `market-maker.ts:583-585` (F-07)
- [x] Commit `fix(strategy-core): la V2 no repite capas al mismo precio (spec 037 R-2, F-07)`

## Fase 3 — R-3: el TTL de salida respeta el lado que el mercado alcanza

- [x] Test que falla en `mm-ejecucion.spec.ts`: camino de precio que se acerca a la salida
      mientras vence su TTL ⇒ hoy se cancela
- [x] Arreglo en `mm-shared.ts` (`expiredQuotes`)
- [x] Commit `fix(strategy-core): el TTL no tira la salida que el mercado viene a buscar (spec 037 R-3)`

## Fase 4 — Lo que el usuario ve antes de poner dinero

- [x] **R-4** test que falla: `preview()` vs `plan()` de la V2 con techo por debajo del bruto
- [x] **R-5** test genérico: para toda estrategia, `meta.default` == `defaults()`
- [x] **R-6** test: preview NEUTRAL no mezcla los dos lados en la liquidación estimada
- [x] Arreglos y commit(s)

## Fase 5 — Diagnóstico y caudal

- [x] **R-7** test: la nota de la V2 cuenta las vivas
- [x] **R-8** test: `now` pequeño y `lastEntryAt` nulo ⇒ no hay enfriamiento
- [x] **R-9** test: ancla + `autoAdjustDistance` ⇒ no reescribe `quotedAutoBps` cada tick
- [x] Arreglos y commit(s)

## Fase 6 — Guías

- [x] `docs/market-maker.md` §2 paso 3 (la tabla de modos de riesgo) y §5
- [x] `docs/market-maker-v2.md` §2 paso 5, §5 y §6 (valores de fábrica)
- [x] `apps/app/src/app/core/content/market-maker.guide.ts` y `market-maker-v2.guide.ts`
- [x] `grep -rn "F-0" docs/` por si alguna «Limitación conocida» queda obsoleta — sin resultados

## Cierre

- [x] `pnpm build:packages` · `pnpm test:strategies` · `pnpm --filter worker test` ·
      `pnpm test:backtest` · `pnpm lint` · `pnpm test` · `ng build` de la app (su typecheck real: no tiene script de tsc)
- [x] Criterios de aceptación CA-1..CA-12 repasados uno a uno
- [x] `findings.md` con el estado final de F-01..F-08
- [x] Fila 037 en el índice de `specs/README.md` (y arreglar las filas 034-036, que están pegadas
      en una sola línea)
- [ ] **CA-13 pendiente del usuario** (comprobación manual con la infra levantada)
- [x] Memoria de usuario actualizada
