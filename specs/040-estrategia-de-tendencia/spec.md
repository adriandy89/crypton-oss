# 040 — Una estrategia que gane cuando el precio se va en línea recta

Estado: `hecho` (falta CA-14, manual) · Tipo: `cambio` · Rama: `spec/040-estrategia-de-tendencia`

## Objetivo

Añadir `TREND_FOLLOW`: ruptura de rango con stop por ATR, tamaño por objetivo de volatilidad y el
funding como filtro de amontonamiento. Es la primera estrategia de la plataforma que **gana en el
único régimen en el que pierden las otras siete**.

## Contexto

Las siete estrategias actuales son de rango, reversión a la media o acumulación:

| Estrategia | Qué hace | Qué le pasa en una tendencia |
|---|---|---|
| `GRID_CLASSIC`, `NEUTRAL_GRID` | Compran abajo y venden arriba dentro de un rango | El precio se sale del rango y deja inventario sin cerrar |
| `TDCA`, `MARTINGALE`, `GRIDMART` | Promedian a la baja | Promedian contra una caída que no vuelve |
| `MARKET_MAKER`, `MARKET_MAKER_V2` | Cotizan los dos lados | Solo ejecuta un lado, y acumulan todo el inventario del lado equivocado |

Lo dice la guía de la V1 con todas las letras: *«el problema aparece cuando el precio no va y
viene, sino que se va en línea recta»*. Todo el arsenal de riesgo de los market makers —sesgo,
modos defensivos, topes, y el filtro de tendencia que acaba de añadir el spec 039— existe para
**limitar el daño** en ese régimen. Ninguna estrategia lo aprovecha.

Y el spec 038 dejó la puerta abierta: `Strategy.candles` sirve velas cerradas de una caché
compartida a quien las declare. Ninguna de las siete lo declara; esta sí.

### Por qué esta y no las otras dos candidatas

- **Cosecha de funding delta-neutral** (largo spot + corto perpetuo) es la estrategia cripto de
  moda y sería el primer rendimiento neutral de mercado de la plataforma. Exige **soporte de spot
  en el adaptador** —y solo Hyperliquid lo tiene de los tres— más contabilizar el funding en
  `cycle-accounting`, que el spec 036 dejó fuera a propósito. Es un spec propio y grande.
- **Pares cointegrados** es neutral de mercado de verdad, pero `BotContext` tiene **un** ticker y
  **una** posición, y el índice único de `bots` es «un bot real por par y cuenta». Es un cambio
  arquitectónico, no una estrategia.

Esta no necesita venue nuevo, ni spot, ni tocar el modelo de datos más allá de un valor de enum.

## Alcance

- `packages/strategy-core/src/strategies/trend-follow.ts` y su registro
- `packages/strategy-core/src/indicadores.ts` — `atr()` y `donchian()`, puros
- `packages/shared/src/enums.ts` y **`packages/db/prisma`** (valor de enum + migración)
- `apps/app`: unión de tipos, etiquetas, guía
- `apps/api`: gating por plan y asesor
- `docs/trend-follow.md`, `docs/README.md`, `README.md`

> **Este spec autoriza explícitamente tocar `packages/db/prisma`**, que `CLAUDE.md` prohíbe sin un
> spec que lo pida. Es un valor nuevo en un enum y su migración: no altera ninguna fila existente.

## Fuera de alcance

- **Pirámide** (añadir a una posición ganadora). Multiplica los estados posibles del ciclo por no
  cambiar la tesis. Campo declarado, pero fijo en 1 nivel.
- **Objetivo de beneficio fijo.** Una ruptura acierta el 40 % de las veces y vive de que los
  ganadores sean mucho mayores que los perdedores; un objetivo fijo corta justo lo que da de
  comer. La salida es el stop que sigue.
- **Backtest con cadencia real.** El replay ya declara que corre `plan()` una vez por vela; para
  esta estrategia eso es casi exacto, no un hueco. Se declara igual.
- **Cambiar nada de las siete existentes.**

## Requisitos

- **R-1 — Entra por ruptura de rango.** Con velas cerradas del intervalo configurado: largo si el
  cierre supera el máximo de las `breakoutPeriod` anteriores, corto si pierde el mínimo. **La vela
  de la ruptura no cuenta en su propio rango.**

- **R-2 — No entra en lateral.** Filtro por **eficiencia de Kaufman** —la misma función de
  `shared` que usan el asesor y el market maker desde el 039— sobre los cierres de la ventana. Por
  debajo de `entryEfficiency` no se abre: una ruptura en un mercado que va y viene es una ruptura
  falsa.

- **R-3 — El tamaño sale del riesgo, no del capital.** Objetivo de volatilidad:

  ```
  qty = (totalInvestment × riskPerTradePct / 100) / (atrStopMultiplier × ATR)
  ```

  Posición pequeña cuando el mercado está nervioso y grande cuando está quieto, de modo que **el
  dinero arriesgado por operación sea constante**. Acotado por `maxNotionalCap` y por el margen
  disponible.

- **R-4 — El stop es una orden condicional NATIVA del venue y sigue al precio.** Inicial en
  `entrada ∓ atrStopMultiplier × ATR`. Después, para un largo,
  `stop = max(stop_anterior, precio − atrStopMultiplier × ATR)`: **nunca se mueve en contra**. Vive
  en `cycle.scratch` y se emite como `DesiredOrder` de tipo `STOP_LOSS` con `triggerPrice`, que es
  lo que `withStopLoss` respeta cuando la estrategia trae el suyo. Sobrevive a que el worker muera
  (invariante 6).

- **R-5 — El stop no se recoloca por cualquier cosa.** Solo cuando se mueve más de
  `stopRepriceBps`. Un trailing que se reescribe cada tick es una orden cancelada y repuesta cada
  quince segundos contra el cupo del venue.

- **R-6 — La salida es el stop.** No hay objetivo fijo. Ver «fuera de alcance».

- **R-7 — El funding filtra el lado amontonado.** Con `maxAdverseFundingBps > 0`, no se abre del
  lado que paga funding por encima de ese umbral: un funding extremo y sostenido dice que todo el
  mundo ya está ahí. Reutiliza `fundingAdverso()` del spec 039.

- **R-8 — Un ciclo por operación.** `keepCycleOnFlat` **no** se declara: entrar y salir es un ciclo
  completo, que es lo que hace legible la analítica que ya existe.

- **R-9 — Sin velas suficientes no opera.** `plan()` devuelve cero órdenes con una nota que lo
  dice, igual que hace la V2 cuando su fuente externa no responde.

- **R-10 — `atr()` y `donchian()` son puras y llevan sus propios tests** contra series calculadas
  a mano, no contra la implementación.

## Criterios de aceptación

- **CA-1** `atr()` sobre una serie conocida da el valor calculado a mano, incluido el primer
  periodo (donde no hay cierre previo).
- **CA-2** `donchian()` excluye la vela en curso del rango que ella misma rompe.
- **CA-3** Un cierre por encima del máximo de las N anteriores y eficiencia suficiente ⇒ una orden
  de entrada y su `STOP_LOSS` con `triggerPrice`.
- **CA-4** Con eficiencia por debajo del umbral ⇒ **cero órdenes**, con nota.
- **CA-5** El tamaño con ATR el doble es la mitad. Con el ATR a cero no se divide por cero.
- **CA-6** Con posición larga y el precio subiendo, el stop sube; con el precio bajando, **no
  baja**.
- **CA-7** Un movimiento del stop menor que `stopRepriceBps` **no** produce una orden nueva.
- **CA-8** Sin velas, o con menos de las pedidas, cero órdenes y nota.
- **CA-9** Con funding adverso por encima del umbral no se abre ese lado.
- **CA-10** `preview()` enseña la entrada, el stop y el riesgo en dinero de la operación.
- **CA-11** La estrategia entra sola en las baterías genéricas (`listStrategies()`), incluida la
  del asesor, sin excepciones añadidas.
- **CA-12** El motor le sirve velas —es la primera que las declara— y el test genérico del spec 038
  («ninguna de las siete pide velas») se actualiza para decir «ninguna de las de reconciliación».
- **CA-13** `pnpm test` verde, `pnpm lint` limpio, `ng build` sin errores, `prisma:migrate` aplica.
- **CA-14** *(manual, usuario)* Un bot simulado sobre un par con movimiento: el stop aparece como
  orden condicional en el venue y el trailing nunca se mueve en contra.

## Riesgos

- **Es la primera estrategia que depende de un dato que puede no llegar.** Sin velas no opera, y lo
  dice. Peor sería operar con una ventana corta: un ATR de catorce velas calculado sobre tres es un
  número con toda la pinta de ser válido.
- **La migración de Prisma toca un enum que usa la columna `strategy` de `bots`.** Añadir un valor
  no altera filas existentes, pero es la primera vez en varios specs que se toca el esquema.
- **Una ruptura acierta poco.** ~40 % de operaciones ganadoras es lo normal, y el usuario tiene que
  saberlo **antes**: la guía lo dice en la primera pantalla, no en una nota al pie.
- **El asesor tiene que saber configurarla** o la recomendará mal. Entra en la batería exhaustiva
  que ya existe, que es la que sostiene la promesa de que toda recomendación se puede aplicar.

## Referencias oficiales

Ninguna de venue. Las fuentes del diseño (Donchian, ATR, objetivo de volatilidad) van en la guía.
