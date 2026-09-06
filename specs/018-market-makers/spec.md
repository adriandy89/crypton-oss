# 018 — Market makers: ciclo continuo, topes, techo y vista previa

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/018-market-makers`

## Objetivo

Que los dos market makers hagan lo que su guía dice: un par casado no reinicia el bot (ni cambia los ids, ni
borra la cotización, la espera, las muestras de volatilidad o el armado); la vista previa enseña el tamaño
que de verdad se manda; los topes por lado frenan **avisando**; el techo del spread es un techo; la
volatilidad no mueve las órdenes sin recotizar; el recorte al hueco no deja capas por debajo del mínimo; la
espera tras un fill rige también con precio de referencia; un tope por lado a cero no mata el lado y uno
diminuto se rechaza al crear; y al copiar un bot a otro par no viajan precios absolutos ni el símbolo de
origen.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-57 | `preview()` omite `profile.size` (×0,7 en CONSERVATIVE): una config válida puede no colocar nada | Alta |
| F-58 | Cada par casado cierra el ciclo: ids nuevos, cancelar y reponer todas las capas, memoria borrada | Media (Alta por caudal) |
| F-59 | MM v1: los topes por lado son un freno mudo | Media |
| F-60 | MM v2: el techo `maxDynamicSpreadBps` se aplica antes de capa, preset y régimen; `0` lo apaga en silencio | Media |
| F-61 | MM v2: `volBps` se recalcula en cada tick y mueve los precios sin recotizar | Media |
| F-62 | MM v2: `armedAt` se pierde al cerrar ciclo: el bot se duerme tras su primera vuelta | Media |
| F-63 | MM v2: `fitToRoom` deja un resto por debajo de `minNotional` que se rechaza en cada recotización | Media |
| F-15 (MM) | `fillCooldownSeconds` inerte con `referencePrice`; `refreshMs` suelo 5 frente a 15; `feeEstimateBps` 0 de fábrica | Media |
| F-64 | Copy-trading: `toFixed(2)` deja topes por lado de `0.40`/`0.00` que matan una cara; el símbolo de origen viaja | Media |
| F-67 | Textos: «la app avisa» (no había aviso), `direction` «deshace la contraria», causa del suelo, barrido del códec sin V2, fixtures en el bundle | Baja |

## Alcance

- `packages/strategy-core/src/strategies/{market-maker,market-maker-v2,mm-shared}.ts`, `types.ts`,
  `cycle-accounting.ts`; `apps/worker/src/engine/{bot-runner,bot-store}.ts` y `packages/backtest/src/engine.ts`
  (la bandera de ciclo continuo llega a la contabilidad); `apps/api/src/modules/leaderboard/{share-codec,
  leaderboard.service}.ts`; textos in-app (`market-maker*.guide.ts`, `field-labels.ts`); `docs/`.
- Tests: `strategies.spec.ts`, `cycle-accounting.spec.ts`, `share-codec.spec.ts`.

## Fuera de alcance

- El valor de fábrica de `feeEstimateBps` (0): cambiarlo es decisión del usuario (principio 6). Aquí solo se
  avisa al validar.
- F-54 (Lighter sin stream de cuenta) y F-13 (`repriceThresholdBps: 0`), que van en sus specs.
- Exportar o no `venue-markets` desde el índice del paquete (P-07): dos specs lo importan por la raíz; se acepta.

## Requisitos

- **R-1** (F-57) `preview()` de las dos versiones aplica `profile.size` al tamaño: con perfil Conservador y
  12 USDC en un par de mínimo 10, la vista previa enseña 8,40 y **no es válida**.
- **R-2** (F-58, F-62) Los market makers declaran `keepCycleOnFlat`: `cycleAfterFill` no cierra el ciclo al
  quedar plana la posición (ids, scratch, `lastEntryAt` y `realizedPnl` sobreviven al par casado). El motor y
  el backtest pasan la bandera. El armado de la condición de activación sobrevive a quedar plano.
- **R-3** (F-59, F-64) MM v1: un tope por lado alcanzado cuenta como tope (acción al límite, nota «tope
  largo/corto»); un tope por lado a cero significa «sin tope propio»; `validate()` rechaza un tope por lado
  que no deja sitio ni a la cotización más pequeña (la V2 no tiene topes por lado).
- **R-4** (F-60) MM v2: el techo se aplica **después** de los multiplicadores de capa, preset y régimen; el
  suelo por coste sigue mandando; `validate()` avisa si el techo está a 0.
- **R-5** (F-61) MM v2: la volatilidad que fija los precios es la de la última recotización
  (`scratch.quotedVolBps`); entre recotizaciones los precios no se mueven.
- **R-6** (F-63) MM v2: si el recorte al hueco deja una capa por debajo de `minNotional` del par, la capa no
  se coloca.
- **R-7** (F-15) MM v1: la espera tras un fill rige con precio de referencia; el suelo de `refreshMs` es 15;
  MM v2 avisa al validar si `feeEstimateBps` es 0.
- **R-8** (F-64) `expandFromShare` conoce el símbolo de origen: al copiar a otro par no viajan los campos de
  precio absoluto ni `sourceSymbolOverride`; el barrido del códec incluye MARKET_MAKER_V2.
- **R-9** (F-67) La nota del MM v1 avisa cuando el mercado se aleja del ancla más del doble de la capa más
  lejana; los textos de `direction`, `referencePrice`, `maxDynamicSpreadBps` y `activationMode` dicen lo que
  el bot hace; el aviso del suelo de la V2 distingue su causa (distancia mínima frente a comisión y margen).

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-9 en verde; `pnpm build:packages`; strategy-core, worker, backtest, api,
  `pnpm test`, `pnpm lint`, `pnpm check:env` en verde; typecheck de la app.
- **CA-2** `grep -rn "F-57\|F-58\|F-59\|F-60\|F-61\|F-62\|F-63\|F-64\|F-67" docs/`: sin bloques «Limitación
  conocida»; la parte MM de F-15 fuera de las guías.

## Riesgos

- R-2 cambia lo que es «un ciclo» para un market maker: pasa de «un par casado» a «la vida del bot hasta que
  se para o se cierra la posición a mano». Las pantallas que cuentan ciclos enseñarán uno solo; el PnL y las
  estadísticas de market making (`bot_mm_stats`) no cambian.
- R-3 y R-4 cambian precios y frenos de bots en marcha: en la dirección que la guía prometía.

## Referencias oficiales

Ninguna regla de venue nueva: son contratos internos de las estrategias.
