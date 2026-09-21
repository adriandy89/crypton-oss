# 068 — Plan

## Enfoque

No se inventa estadística. `canal/estadistica.ts` ya tiene Bollinger, ATR, RSI, ADX, CHOP,
eficiencia, percentiles, OLS y media vida; `canal/regimen.ts` tiene el filtro de régimen, que es la
pieza que este repo ha medido como más valiosa. El motor nuevo **los envuelve**.

Lo que sí es nuevo es la **forma de la decisión**: una matriz de 3 stops × 3 objetivos sobre un
único montaje, en vez de una lista de candidatos con parámetros por candidato. Esa forma no es
estética — viene de que el proveedor del 069 evalúa sus preguntas **en paralelo y en aislamiento**,
así que una respuesta no puede informar a otra. Al fijar la dirección por el borde tocado
desaparece la dimensión «candidato» y lo que queda son elecciones ortogonales.

## Pasos

1. `packages/shared/src/ia-trader.ts` — el vocabulario: `BucketStop`, `BucketObjetivo`,
   `AccionTrader`, `RespuestaTrader`, `EsqueletoTrader`, `EspacioTrader`, `PlanTrader`,
   `MotivoTrader`. Todo enumeraciones; ni un número de decisión.
2. `packages/strategy-core/src/trader/senal.ts` — los rasgos de la vela, envolviendo la estadística.
3. `packages/strategy-core/src/trader/esqueletos.ts` — la matriz 3 × 3, valorada y validada.
4. `packages/strategy-core/src/trader/construir.ts` — `construirOperacionTrader()`, el único camino
   de enumeración a número.
5. `packages/strategy-core/src/trader/juez.ts` — el brazo de control.
6. `packages/strategy-core/src/trader/config.ts` — `DEFAULTS_TRADER` y el lector.
7. `packages/strategy-core/src/strategies/ai-trader.ts` — la estrategia y su `meta.fields`.
8. Enum en Prisma + migración, espejo en `shared`, `ESTRATEGIAS_SOLO_ADMIN`, registro.
9. El worker la adopta; el backtest la avisa; la app la pinta; la documentación la cuenta.

## El orden importa

`REGISTRY` es un `Record<StrategyKind, …>` exhaustivo y la app tiene su propia unión escrita a mano
con **tres** `Record` encima más un mapeado `GuideOptions` con `-?`. **Añadir el valor del enum sin
sus entradas no compila.** Así que el enum, el registro y la app van juntos o no van.

## Riesgo principal

Que el motor no gane. Está escrito en el criterio de parada del spec y por eso este spec se mide
solo, antes de pagar por un modelo.
