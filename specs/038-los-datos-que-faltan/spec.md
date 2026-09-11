# 038 — Los datos que el motor no tiene

Estado: `hecho` (falta CA-11, manual) · Tipo: `cambio` · Rama: `spec/038-los-datos-que-faltan`

## Objetivo

Que a `plan()` lleguen tres datos que hoy no llegan y que son la puerta de casi toda la
inteligencia posible en un market maker: **el tamaño en el toque**, **la tasa de funding** y
—solo para quien lo declare— **las velas**.

Se sabrá que está hecho cuando `BotContext` los ofrezca, los tres adaptadores los rellenen con lo
que ya descargan, y ninguna de las siete estrategias cambie de conducta.

## Contexto

Investigando cómo hacer más inteligentes los dos market makers salió que casi todo lo que la
literatura recomienda está bloqueado por **datos que el sistema ya tiene delante y tira**:

- **El tamaño del toque.** Los dos MM cotizan alrededor del punto medio `(bid+ask)/2`, que ignora
  cuánta cantidad hay a cada lado. El microprecio de Stoikov —`(ask·Q_bid + bid·Q_ask)/(Q_bid+Q_ask)`—
  predice mejor el medio futuro que el propio medio y es martingala por construcción; el
  desequilibrio `I = (Q_bid−Q_ask)/(Q_bid+Q_ask)` es el indicador de microestructura más usado de
  la industria. Cotizar al medio con `I = +0,8` es poner la venta justo donde el precio va a subir.
  **Hyperliquid ya descarga `l2Book` con los tamaños y se queda solo con el precio del nivel 0**
  ([`hyperliquid.ts:586`](../../packages/exchange-core/src/adapters/hyperliquid.ts#L586)).
- **El funding.** Un inventario en un perpetuo no solo tiene riesgo de precio: **cobra o paga cada
  hora**. Un market maker neutral no puede hoy inclinarse hacia el lado que cobra, ni usar un
  funding extremo y persistente como señal de posicionamiento amontonado. **Hyperliquid ya pide
  `assetCtx`, que trae `funding`, y Aster ya pide `/premiumIndex`**: las dos peticiones se hacen
  hoy, en la misma llamada, y el dato se descarta.
- **Las velas.** El motor no las usa a propósito —*«reconcilia contra el libro, no contra un
  gráfico»*, [`account-hub.service.ts:748`](../../apps/worker/src/engine/account-hub.service.ts#L748)—
  y ese principio se mantiene para las estrategias que reconcilian. Pero una estrategia de
  tendencia necesita el gráfico, y `MarketFeatures` (ATR, eficiencia de Kaufman, tendencia) hoy
  solo existe en la API, para configurar el bot **antes** de arrancarlo.

Este spec **no usa** ninguno de los tres: solo los pone en el contexto. Quien los use es el 039
(inteligencia de los MM) y el 040 (estrategia de tendencia).

## Alcance

- `packages/shared/src/market.ts` — `Ticker` gana cuatro campos **opcionales**
- `packages/shared/src/bot.ts` — `BotContext.candles`
- `packages/strategy-core/src/types.ts` — `Strategy.candles`, la declaración
- Los tres adaptadores y el simulador: `hyperliquid.ts`, `aster.ts`, `lighter.ts`, `dry-run.ts`
- `packages/backtest/src/ticks.ts` y `packages/strategy-core/src/testing.ts`
- `apps/worker/src/marketdata/market-data.service.ts` (caché de velas compartida)
- `apps/worker/src/engine/bot-runner.ts` (`buildContext`) y `account-hub.service.ts`

## Fuera de alcance

- **Usar los datos.** Ni microprecio, ni sesgo por funding, ni filtro de tendencia: eso es el 039.
- **Contabilizar el funding cobrado o pagado** en `cycle-accounting`. El spec 036 lo dejó fuera a
  propósito y sigue mereciendo el suyo. Aquí el funding es **señal**, no contabilidad.
- **Pedir el libro de Lighter.** `market_stats` no publica tamaños, y sacarlos costaría una
  petición de `orderBookOrders` por símbolo y tick contra un cupo de **60 peticiones por minuto y
  IP**. Lighter reporta `undefined` y los consumidores caen al punto medio.
- **Profundidad más allá del toque**, libro L2 completo, flujo de trades público y open interest.
- `packages/db/prisma` y cualquier cambio de conducta de las siete estrategias.

## Requisitos

- **R-1 — `Ticker` lleva el tamaño del toque.** Dos campos **opcionales**, `bidSize` y `askSize`,
  en la misma unidad que `qty` (base, cadena decimal). Ausente significa **«el venue no lo
  publica»**, nunca cero: un cero es un libro vacío, que es otra cosa.

- **R-2 — `Ticker` lleva el funding.** `fundingRate` (fracción por periodo, con signo: positivo =
  los largos pagan) y `nextFundingAt` (**instante absoluto** en epoch ms), los dos opcionales.

  Absoluto y no «cuánto falta»: el ticker se cachea, se republica por Redis y lo lee un tick
  posterior, así que un delta llegaría caducado. Es además lo que publica el venue
  (`nextFundingTime`).

- **R-3 — Coste cero en peticiones.** Ningún adaptador hace una llamada nueva ni cambia su peso.
  Solo se leen campos de respuestas que ya se piden:

  | Venue | Tamaños | Funding |
  |---|---|---|
  | Hyperliquid | `l2Book.levels[i][0].sz` (REST) y `bbo` (WS) | `assetCtx.funding`, memoizado |
  | Aster | `bookTicker.bidQty`/`askQty` (REST), `B`/`A` (WS) | `premiumIndex.lastFundingRate`/`nextFundingTime` (REST), `r`/`T` del stream `markPrice@1s` (WS) |
  | Lighter | **no los publica** → `undefined` | **no** en `market_stats` → `undefined` |

- **R-4 — Un campo que el venue no manda queda `undefined`, y nada se rompe.** Ni excepciones, ni
  ceros, ni valores inventados. Es la regla que permite que Lighter siga funcionando igual y que
  un cambio de forma en la respuesta de un venue degrade en vez de tumbar al bot.

- **R-5 — El simulador y el backtest los ofrecen.** `DryRunAdapter` los arrastra de su fuente; el
  backtest deja `undefined` lo que no simula, y `packages/backtest/src/warnings.ts` lo declara,
  como ya hace con el resto de huecos de paridad.

- **R-6 — Una estrategia puede pedir velas, y solo la que las pida las recibe.** `Strategy` gana
  `readonly candles?: { interval: CandleInterval; bars: number }`; `BotContext` gana
  `candles?: Candle[]`, **cerradas y de más antigua a más reciente**. Las siete estrategias
  actuales no lo declaran, así que para ellas no cambia nada ni se pide una vela.

- **R-7 — Las velas se sirven de una caché compartida.** N bots del mismo símbolo e intervalo son
  **una** petición, igual que el ticker y que `assetCtx`. Se refrescan cada
  `CANDLE_REFRESH_EVERY_TICKS` y no en cada tick.

- **R-8 — Solo velas cerradas.** La vela en curso cambia dentro del mismo minuto, así que
  entregarla rompería la pureza de `plan()`: dos llamadas con el mismo estado darían planes
  distintos. Se descarta la última si su ventana no ha terminado.

- **R-9 — Sin velas suficientes, la estrategia no opera.** Si el contexto no trae al menos las
  `bars` pedidas, el motor lo anota y `plan()` puede devolver cero órdenes con nota, igual que
  hace hoy la V2 cuando su fuente externa no responde.

## Criterios de aceptación

- **CA-1** `getTicker` de Hyperliquid devuelve `bidSize`/`askSize` del `l2Book` y `fundingRate` de
  `assetCtx`, con respuestas grabadas. Test en `hyperliquid.spec.ts`.
- **CA-2** Lo mismo para el stream `bbo` + `activeAssetCtx`.
- **CA-3** Aster: `bidQty`/`askQty` de `bookTicker` y `lastFundingRate`/`nextFundingTime` de
  `premiumIndex`, REST y WS.
- **CA-4** Lighter devuelve `undefined` en los cuatro y **sigue pasando todos sus tests**.
- **CA-5** Un venue que deja de mandar el campo (respuesta sin él) da `undefined` y no lanza.
- **CA-6** `plan()` de las siete estrategias produce **exactamente las mismas órdenes** que antes
  del spec. Es la garantía para los bots en marcha.
- **CA-7** Las siete estrategias reales **no** declaran `candles`, así que el motor no pide una
  sola vela por ellas. Test genérico sobre `listStrategies()`.

  > Que una estrategia que **sí** las declare las reciba de extremo a extremo no se prueba aquí:
  > haría falta una en el registro que las pida, y esa es el spec 040. Lo que sí queda probado son
  > las dos mitades: la ventana compartida (CA-8, CA-9) y que ninguna de las siete la pide.
- **CA-8** Dos bots del mismo símbolo e intervalo consumen **una** petición de velas.
- **CA-9** La última vela entregada está cerrada: su `closeTime` es anterior a `now`.
- **CA-10** `pnpm test` en verde, `pnpm lint` limpio, `ng build` de la app sin errores.
- **CA-11** *(manual, usuario)* Con la infra levantada, un bot simulado en Hyperliquid enseña
  tamaños y funding en su contexto; uno en Lighter funciona igual que antes.

## Riesgos

- **`Ticker` es un tipo de `shared`, que lo consume todo.** Los cuatro campos son **opcionales**,
  así que ningún consumidor existente deja de compilar y ninguno cambia de conducta. Aun así,
  `shared → todo`: la verificación recorre los seis paquetes.
- **Los nombres de campo de Aster salen de su documentación oficial, no de una sonda.** Están
  citados literalmente abajo, con fecha. R-4 sigue siendo la red: un nombre equivocado daría
  `undefined`, nunca una excepción ni un número inventado. La suscripción de WS que hace falta
  —el stream combinado `bookTicker` + `markPrice@1s`— **ya existe** en el adaptador, así que
  tampoco ahí hay conexión nueva.
- **Las velas en el motor rompen un principio declarado.** Se acota: solo las recibe quien las
  declara, solo cerradas, de caché compartida y con tope de `bars`. Las siete estrategias actuales
  no las declaran, así que el principio sigue valiendo para todas ellas.

## Referencias oficiales

| Fuente | Regla | Cita | Consultado |
|---|---|---|---|
| SDK `@nktkas/hyperliquid` 0.33.3 | El contexto de activo trae la tasa de funding | `funding: string` — *«Funding rate»*, `api/info/_methods/_base/_schemas.d.ts` | 2026-09-11 |
| SDK `@nktkas/hyperliquid` 0.33.3 | Los niveles del libro traen la cantidad | `sz: string` en los niveles de `bbo` y `l2Book` | 2026-09-11 |

| `asterdex/api-docs` V3 EN | `bookTicker` trae la cantidad de cada lado | `"bidPrice": "4.00000000", "bidQty": "431.00000000", "askPrice": "4.00000200", "askQty": "9.00000000"` | 2026-09-11 |
| `asterdex/api-docs` V3 EN | `premiumIndex` trae el funding y el próximo pago | `"lastFundingRate": "0.00038246", "nextFundingTime": 1597392000000` | 2026-09-11 |
| `asterdex/api-docs` V3 EN | El stream `<symbol>@bookTicker` lleva las cantidades | *«`B`: best bid quantity · `A`: best ask quantity»* | 2026-09-11 |
| `asterdex/api-docs` V3 EN | El stream `<symbol>@markPrice@1s` lleva el funding | *«`r`: Funding rate · `T`: Next funding time»* | 2026-09-11 |

URL: `https://raw.githubusercontent.com/asterdex/api-docs/master/V3(Recommended)/EN/aster-finance-futures-api-testnet.md`

**Hyperliquid no publica el instante del próximo pago** en `assetCtx`, así que allí
`nextFundingAt` queda `undefined`: el funding es horario, pero deducir la hora en punto sería
inventarse un dato que el venue no da.
