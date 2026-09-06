# 017 — Rejillas: dimensionado, vista previa y forma con inventario

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/017-grids-dimensionado-y-preview`

## Objetivo

Que las rejillas hagan lo que su guía dice: la neutral cobre el vaivén (la banda muerta ya no cancela la
línea que se acerca), GridMart no borre seguridades con sus recompras ni pierda trozos de venta ni deje polvo,
la clásica dimensione en «Cantidad de moneda» con un precio fijo, recorte lo que tiende con el tope de
exposición y enseñe en la vista previa el peor caso de todas las líneas; que la vista previa diga cuando la
liquidación estimada no es la real (cruzado, neutral) y no repita avisos; y que un cambio en tibio de la forma
de una escalera o rejilla con inventario se rechace en vez de recolocar sobre índices que ya no significan lo
mismo.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-81 | Neutral Grid: la banda muerta cancela la línea justo antes de que pueda ejecutarse | Alta |
| F-82 | GridMart: la recompra `GRID_BUY#j` borra `SAFETY#j` para el resto del ciclo | Alta |
| F-89 | GridMart: los trozos de una venta sobrescriben la recompra; el reparto del núcleo deja polvo | Media |
| F-03 | Grid Classic en `sizingMode: BASE` dimensiona con el mark en `plan()` y con `refPrice` en `preview()` | Alta |
| F-87 | Grid Classic: `maxNotionalCap` no acota lo que se tiende | Media |
| F-88 | Grid Classic: el preview cuenta solo las líneas de debajo del precio como peor caso | Media |
| F-90 | Revisión WARM de la forma con inventario: `filledLevelIndexes` sin remapear | Media |
| F-14 | Preview: liquidación siempre aislada y siempre larga; TDCA repite los avisos comunes | Media |

## Alcance

- `packages/strategy-core/src/strategies/{neutral-grid,gridmart,grid-classic,tdca,martingale}.ts`,
  `common.ts` (`buildPreview`), `cycle-accounting.ts`, `types.ts`; `packages/shared/src/config-meta.ts`
  (`FieldMeta.reshapes`); `apps/worker/src/engine/{bot-runner,bot-store}.ts` y `packages/backtest/src/engine.ts`
  (la bandera de GridMart llega a la contabilidad); `apps/api/src/modules/bots/bots.service.ts`
  (`updateConfig` rechaza la forma con inventario).
- Tests: `strategies.spec.ts`, `cycle-accounting.spec.ts`, `bots-reshape.spec.ts` (API, nuevo).

## Fuera de alcance

- Remapear `filledLevelIndexes` a la forma nueva (la alternativa a rechazar): exige decidir qué venta
  corresponde a cada compra tras mover las líneas; rechazar con inventario es seguro y reversible.
- Una liquidación «cruzada» calculada: depende del saldo de toda la cuenta, que la vista previa no conoce.

## Requisitos

- **R-1** (F-81) La banda muerta de Neutral Grid solo gobierna el **cambio de lado** de una línea (histéresis
  sobre el lado memorizado en el scratch del ciclo), nunca si la línea se tiende: una compra en 95 sigue viva
  mientras el precio baja de 98 a 95,5.
- **R-2** (F-82) GridMart declara `rebuysOffLevelIndexes` y la contabilidad no marca `filledLevelIndexes` con
  las recompras `GRID_BUY`: `SAFETY#j` sigue en el plan tras la recompra `j`.
- **R-3** (F-89) Los trozos de una venta de rejilla **suman** en la recompra del escalón; el reparto del
  núcleo entrega el resto al último escalón (la suma de las ventas es el núcleo entero).
- **R-4** (F-03) En `sizingMode: BASE` la cantidad por línea se calcula con un precio de referencia fijado en
  el primer plan del ciclo (memorizado en el scratch) y la vista previa usa el precio de referencia de la
  creación: dos planes con marks distintos dan las mismas cantidades.
- **R-5** (F-87) `maxNotionalCap` en Grid Classic acota el notional **proyectado** de lo que se tiende (de la
  línea más cercana a la más lejana), como en las escaleras.
- **R-6** (F-88) La vista previa de Grid Classic cuenta **todas** las líneas como peor caso (notional, margen,
  precio medio, liquidación).
- **R-7** (F-14) `buildPreview` avisa cuando el modo de margen es cruzado (la estimación aislada es una cota) y,
  en un bot neutral, añade la liquidación simétrica del lado corto; TDCA no repite los avisos comunes.
- **R-8** (F-90) Los campos que cambian el significado de los índices llevan `reshapes: true` en `meta.fields`
  y `updateConfig` rechaza (409) un cambio de esos campos mientras el ciclo tenga niveles ejecutados: «cierra
  la posición o espera al fin del ciclo».

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-8 en verde; `pnpm build:packages`; strategy-core, worker, backtest, api,
  `pnpm test`, `pnpm lint` en verde.
- **CA-2** `grep -rn "F-81\|F-82\|F-89\|F-03\|F-87\|F-88\|F-90\|F-14" docs/`: sin bloques «Limitación conocida».

## Riesgos

- R-1, R-2, R-4 y R-5 cambian la conducta de rejillas en marcha (más ejecuciones en la neutral, seguridades
  que vuelven en GridMart, cantidades fijas en BASE, menos líneas con tope). Es lo que las guías describen como
  conducta prevista y lo que las fichas del 001 documentan como fallo.
- R-8 impide un cambio que hoy se permite (con confirmación): a quien lo intente con inventario se le dice qué
  hacer en su lugar.

## Referencias oficiales

Ninguna regla de venue nueva: son contratos internos de las estrategias y de la vista previa.
