# 068 — El «Bot de IA»: el motor, medible sin gastar una llamada

Estado: `cerrado sin desplegar` (CA-5 y CA-6 se cumplen, CA-4 no; ver `findings.md`) · Tipo: `cambio` · Rama: `spec/068-bot-de-ia-motor`

## Objetivo

Una estrategia nueva, `AI_TRADER`, con **motor propio** —no reutiliza la detección de canal— cuyo
espacio de decisión es una matriz pequeña de operaciones **ya valoradas y ejecutables**, y con un
**juez de reglas determinista** que las elige.

Se sabrá conseguido cuando el walk-forward sobre doce pares y ciento noventa días dé **≥ 2
operaciones al mes y par**, **R medio positivo con t > 2** y **≥ 4 de 6 ventanas positivas**.

Este spec **no habla con ningún modelo**. El proveedor llega en el 069, y solo si este cumple.

## Por qué existe

El bot de IA que hay hoy, `AI_CHANNEL`, quedó medido en los specs 066 y 067: R medio **+0,205** con
**t = 0,90** y 5 de 6 ventanas positivas, tras dos specs enteros de trabajo. Está en `main` y sin
desplegar. Lo que el 066 dejó demostrado es que **el problema no era ninguna puerta**: el mercado
está en un canal de giros el 3,7 % del tiempo y aflojar sus puertas no lo cambia.

La decisión del usuario es hacer un bot de IA **nuevo**, con motor propio, y que sea él quien se
llame «Bot de IA». Este spec construye ese motor y lo mide **antes** de pagar por un modelo.

Que el brazo determinista vaya primero no es prudencia decorativa: es que **el backtest no puede
medir a un modelo**. El motor lo dice él mismo cuando replica una estrategia con IA —«la IA no se
consulta en el backtest: decide el juez de reglas»—, así que el juez es lo único que un
walk-forward puede juzgar, y además es el brazo de control contra el que se medirá el modelo.

## Alcance

Estrategia nueva **`AI_TRADER`**, **solo administradores**, visible como **«Bot de IA»**.

`AI_CHANNEL` pasa a verse como **«Canal»**: solo etiquetas, guía y documentación. **No se toca su
valor de enum, ni Prisma, ni una sola fila.**

### Lo que NO se toca

- El enum `AI_CHANNEL` ni sus datos. El renombrado es de cadenas visibles.
- `openrouter.client.ts` y sus tres cargas (asesor, supervisor, canal).
- El stop y los objetivos: **órdenes nativas del venue**, para que sobrevivan a que el worker muera.
- `apalancamientoPorStop`, el vigilante del stop y el motor de reconciliación.

## Requisitos

- **R-1 — Motor propio, con la matemática que ya existe.** `packages/strategy-core/src/trader/`.
  Régimen de 1 h (`canal/regimen.ts`), señal de 15 min y frescura de 5 min. Toda la estadística sale
  de `canal/estadistica.ts`: *la matemática se envuelve, no se escribe*.
- **R-2 — Cadencia de 15 minutos.** Una evaluación por vela cerrada de 15 min, no por tick. Son 96
  al día como mucho, y es lo que hace que un presupuesto diario de llamadas signifique algo cuando
  llegue el 069.
- **R-3 — Espacio de acciones de 3 × 3, cerrado y ejecutable.** La dirección **no se elige**: la
  fija el borde tocado. El apalancamiento **tampoco**: `apalancamientoPorStop` da `[lMin, lMax]` y
  el generador toma siempre `lMin`, la liquidación más lejana.

  | Stop, en ATR(15m) | Objetivo, en fracción entrada→media |
  |---|---|
  | `CENIDO` 1,25 · `MEDIDO` **2,00** · `HOLGADO` 3,00 | `CORTO` 0,70 · `EN_LA_MEDIA` **1,00** · `LARGO` 1,50 |

  `MEDIDO` y `EN_LA_MEDIA` son los valores que el 067 midió como ganadores y son el defecto.
  **El borde opuesto no es una opción**: el 067 midió que hundía el R medio de +0,28 a −0,21.
- **R-4 — Cada celda se valida antes de ofrecerse**, con los mismos códigos de rechazo que
  `opcionDeStop`. Lo que se ofrece es ejecutable por construcción.
- **R-5 — Un solo camino de enumeración a número.** `construirOperacionTrader()`, calcado de
  `construirOperacion()`. Todo precio cruza a `Decimal` una vez y pasa por `precision.ts`.
- **R-6 — El juez de reglas devuelve la MISMA estructura** que devolverá el proveedor en el 069, de
  modo que solo cambien las respuestas y no el camino.
- **R-7 — Arranca apagado dos veces.** `decisionMode` por defecto `REGLAS` y `observeOnly` por
  defecto `true`: un bot recién creado no llega al mercado hasta que su dueño lo diga dos veces.

## Criterios de aceptación

- **CA-1** Tests deterministas: la señal, la matriz 3 × 3, cada código de rechazo, las direcciones
  de redondeo, y una prueba de propiedad de que **la liquidación queda siempre detrás del stop**.
- **CA-2** `construirOperacionTrader` es total: ninguna respuesta produce un plan fuera de las
  celdas viables ofrecidas.
- **CA-3** Batería completa, `worker`, `backtest`, typecheck de la app, `lint` y `check:env`.
- **CA-4 — Cadencia.** ≥ 2 operaciones al mes y par.
- **CA-5 — Ventaja.** R medio > 0 con **t > 2**.
- **CA-6 — Estabilidad.** ≥ 4 de 6 ventanas temporales positivas.
- **CA-7 — Venue.** CA-4..6 con costes de Lighter; con los de Hyperliquid, R medio ≥ 0 o `validate()`
  lo advierte.
- **CA-8 — Robustez.** CA-5 sobrevive a subir el deslizamiento de 2 a 4 puntos básicos; el resultado
  a 6 se reporta salga lo que salga.
- **CA-9 — Operativo.** En todo el replay: 0 posiciones huérfanas, 0 entradas sin stop nativo al
  tick siguiente, 0 planes por encima de `maxMarginPct`.
- **CA-10 (manual, usuario)** Un bot simulado por par antes de cualquier plan de dinero real.

## Criterio de parada

Si CA-4, CA-5 o CA-6 no se cumplen, el motor no vale: el spec se cierra **sin desplegar**, con el
resultado en `findings.md`, y **el spec 069 no se escribe**. No se afloja ninguna puerta para
fabricar el número; el 066 ya demostró que por ahí no se sale.

Lo digo por delante: `AI_CHANNEL` llegó a +0,205 con t = 0,90 después de dos specs. Empezar de cero
no garantiza mejorarlo.
