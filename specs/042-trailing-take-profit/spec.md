# 042 — El take profit puede seguir al precio

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/042-trailing-take-profit`

## Objetivo

Que el objetivo de beneficio de TDCA y Martingala deje de ser un precio fijo y pueda **seguir al
máximo**: se activa al llegar al objetivo, y a partir de ahí el bot solo vende si el precio
retrocede el porcentaje que el usuario diga.

Se sabrá que está hecho cuando un bot con el trailing encendido, ante un precio que sube al +20 %
y retrocede al +19 %, salga **ahí** y no antes ni después — y cuando el mismo bot con la
configuración de fábrica produzca exactamente las mismas órdenes que hoy.

## Contexto

Se llama **Trailing Take Profit**, y lo primero que hay que decir es que **no es un bot en ninguna
plataforma que lo tenga**: en Binance y en Aster es un tipo de orden (`TRAILING_STOP_MARKET`, con
`activationPrice` y `callbackRate`), y en 3Commas es una casilla del bot DCA.

CRYPTON ya tiene las dos mitades sin conectar:

- **TDCA** ([tdca.ts:270](../../packages/strategy-core/src/strategies/tdca.ts#L270)) y
  **Martingala** ([martingale.ts:421](../../packages/strategy-core/src/strategies/martingale.ts#L421))
  calculan su salida con `takeProfitPrice()` sobre el precio medio real del venue.
- La **estrategia de tendencia** del spec 040
  ([trend-follow.ts:445-507](../../packages/strategy-core/src/strategies/trend-follow.ts#L445))
  tiene un trailing ya revisado en el spec 041: máximo implícito en `cycle.scratch`, orden
  condicional nativa, y umbral para no recolocar por ruido.

Y la activación se configura en todas partes **como porcentaje de beneficio**, que es justo lo que
ya es `takeProfitPct`. Así que con el trailing encendido ese campo **no cambia de unidad ni de
sitio: cambia de papel**, de «precio al que salgo» a «precio al que empiezo a seguir». El usuario
no aprende un concepto nuevo.

## Alcance

- `packages/shared/src/bot.ts` — `DesiredOrder.intent` y `BotContext.extremos`
- `packages/strategy-core/src/trailing-take-profit.ts` — las funciones puras, nuevas
- `packages/strategy-core/src/strategies/{tdca,martingale}.ts` — los campos y el cableado
- `packages/strategy-core/src/strategies/gridmart.ts` — sacarlos de su formulario, ver R-9
- `packages/backtest/src/engine.ts` — la misma precedencia del `intent` que el motor
- `apps/worker/src/engine/bot-runner.ts` — el `intent` explícito y la marca de agua
- Las guías: `docs/{tdca,martingale}.md` y `apps/app/src/app/core/content/*.guide.ts`

## Fuera de alcance

- **La estrategia dedicada** (`TRAILING_PROFIT`): es el spec 043 y se apoya en este.
- **GridMart.** No usa `takeProfitPct` —lo tiene filtrado como muerto en
  [gridmart.ts:176](../../packages/strategy-core/src/strategies/gridmart.ts#L176)— y tiene **dos
  salidas a la vez**, el satélite y la rejilla del núcleo. Cuál de las dos debería seguir al máximo
  es otro diseño, no un interruptor.
- **El `TRAILING_STOP_MARKET` nativo de Aster.** Ver R-2.
- **`modifyOrder` en Lighter**, que reduciría a la mitad el coste de recolocar. Sigue en la cola
  como spec propio.
- Cambiar cualquier valor de fábrica existente.

## Requisitos

- **R-1 — El sentido del disparo lo declara quien pide la orden. (Precondición de todo lo demás)**

  Un trailing take profit es, mecánicamente, **un stop**: para un largo es una venta que dispara
  **al BAJAR** el precio, aunque esté muy por encima de la entrada. Pero hoy el motor lo deriva del
  `levelKind` ([bot-runner.ts:1086](../../apps/worker/src/engine/bot-runner.ts#L1086)):

  ```ts
  intent: order.levelKind === 'TAKE_PROFIT' ? 'TP' : 'SL',
  ```

  Emitirlo como `TAKE_PROFIT` con disparador lo armaría **al revés**: con la condición ya cierta al
  colocarlo, el venue cerraría la posición al instante. Es el fallo 001/F-80, documentado ya dos
  veces en el repo.

  Y emitirlo como `STOP_LOSS` —lo que hace la estrategia de tendencia— **dejaría al bot sin el
  stop-loss del usuario**, porque `withStopLoss` se calla si la estrategia ya emitió uno
  ([stop-loss.ts:51](../../packages/strategy-core/src/stop-loss.ts#L51)). Cambiar una red de
  seguridad por una mejora de beneficio no es aceptable.

  `DesiredOrder` gana `intent?: 'TP' | 'SL'` y el motor pasa a
  `order.intent ?? (levelKind === 'TAKE_PROFIT' ? 'TP' : 'SL')`. Compatible hacia atrás: ninguna
  estrategia actual lo declara.

- **R-2 — Lo gestiona el motor en los tres venues por igual.** Solo Aster tiene trailing nativo;
  Hyperliquid y Lighter no, **verificado en los tipos de sus SDK**: el de Hyperliquid es una unión
  cerrada de `limit | trigger` con `tpsl: "tp"|"sl"` validada con valibot, y el de Lighter enumera
  `ORDER_TYPE_*` de 0 a 6 sin huecos.

  Usar el nativo solo en Aster daría dos conductas que probar, y además su `callbackRate` está
  capado en 5 % —un usuario pidiendo 8 % se lo encontraría recortado en silencio—.

  Lo que **no** se pierde: la orden que se coloca sigue siendo **condicional nativa**, así que
  dispara aunque el worker esté caído y aunque la caída ocurra entre dos revisiones. El motor solo
  decide dónde ponerla.

- **R-3 — Tres campos, apagados de fábrica.** Descriptores compartidos, una sola vez, para que no
  puedan divergir entre las dos estrategias:

  | Campo | Mut. | Rango | Fábrica |
  |---|---|---|---|
  | `trailingTakeProfit` | HOT | bool | **`false`** |
  | `trailingCallbackPct` | HOT | 0,1–10 | **1** |
  | `trailingRepriceBps` | HOT, avanzado | 1–200 | **20** |

- **R-4 — Antes de activar no hay salida de beneficio.** Por debajo del objetivo no hay nada que
  asegurar, y el `stopLossPct` nativo sigue cubriendo la bajada. Al cruzar el objetivo se anota
  `ttpArmed` en `scratch` y el armado es **irreversible dentro del ciclo**, como el
  `activationGate` del market maker V2: un precio que vuelve a bajar no desarma un bot que ya tiene
  inventario que proteger.

- **R-5 — El máximo nunca retrocede**, y se mide del precio de **marca**. El disparador es
  `extremo × (1 − callback)` para un largo y el espejo para un corto.

  De la marca y no del último negociado porque es el que los venues suavizan: un mal print no puede
  inventar un máximo y, con él, un disparador ya por debajo del mercado que cerraría la posición al
  instante.

- **R-6 — El máximo se ve también entre revisiones.** El motor planifica cada quince segundos pero
  recibe precios varias veces por segundo. El runner guarda el máximo y el mínimo **desde la última
  planificación** y los entrega en `BotContext.extremos`; la estrategia los fusiona con el máximo
  persistido.

  En memoria y sin persistir a propósito: lo que se persiste es el máximo del ciclo, y el peor caso
  de un reinicio del worker es perder el pico de los últimos quince segundos — **el bot sale un
  poco más abajo, nunca más arriba**.

- **R-7 — No se recoloca por ruido.** Solo cuando el disparador avanza más de
  `trailingRepriceBps`. Cada patch de `scratch` es un `UPDATE` en la base sin amortiguar
  ([bot-runner.ts:777](../../apps/worker/src/engine/bot-runner.ts#L777)), y en **Lighter** el cupo
  son 60 peticiones por minuto **de toda la IP**: unas 25 recolocaciones.

- **R-8 — Apagado, nada cambia.** Un test comprueba que `plan()` con `defaults()` produce
  exactamente las mismas órdenes que antes del spec.

- **R-9 — Los tres campos NO aparecen en GridMart.** *(Apareció al implementar: `GridMartConfig`
  extiende `MartingaleConfig`, así que los hereda por tipo, y su `META` reparte
  `MARTINGALE_FIELDS`.)* Sin esto habrían salido tres casillas en su formulario que no gobiernan
  ninguna orden — exactamente lo que el spec 026 ya corrigió con `HEREDADOS_SIN_EFECTO`, donde
  entran ahora los tres. La guía sí lleva ficha para los tres, porque `GuideOptions<C>` la exige
  por tipo, y dice que no hacen nada.

## Criterios de aceptación

- **CA-1** Un `TAKE_PROFIT` con `intent: 'SL'` llega al simulador como disparador **a la baja**
  (`triggerDirOf`) y **no** cierra la posición al colocarlo.
- **CA-2** Con el trailing activado, el `stopLossPct` del usuario **sigue estando** entre las
  órdenes deseadas.
- **CA-3** Por debajo del objetivo no hay orden de beneficio, y la nota lo dice.
- **CA-4** Al cruzar el objetivo aparece el disparador en `objetivo × (1 − callback)`.
- **CA-5** El disparador **sube** con el precio y **nunca baja**, ni con el precio desplomándose.
- **CA-6** Un avance pequeño del máximo **no** produce orden nueva ni escritura en `scratch`
  (`scratchPatch` `undefined`).
- **CA-7** El armado es irreversible: una vez cruzado el objetivo, volver por debajo no desarma.
- **CA-8** En corto es el espejo exacto: mínimo en vez de máximo, disparador por encima.
- **CA-9** `BotContext.extremos` se fusiona con el máximo persistido, y un pico visto solo en el
  stream **sí** cuenta.
- **CA-10** Camino multi-tick determinista: sube al +20 %, retrocede al +19 % ⇒ sale ahí, no antes
  ni después.
- **CA-11** **R-8**: con `defaults()`, las mismas órdenes que en `main`.
- **CA-12** `pnpm test` verde, `pnpm lint` limpio, `ng build` sin errores.
- **CA-14** Los tres campos **no** están en `meta.fields` de GridMart (R-9).
- **CA-13** *(manual, usuario)* Un TDCA simulado con activación 2 % y retroceso 0,5 %: la orden
  condicional aparece en el venue **solo** tras cruzar el 2 %, su precio sube con el mercado y
  nunca baja, y el stop-loss sigue ahí.

## Riesgos

- **R-1 toca un tipo de `shared` que consume todo el monorepo.** El campo es opcional y el motor
  mantiene la deducción anterior como respaldo, así que ningún consumidor cambia de conducta.
- **Un trailing no es una mejora gratis.** En marcos cortos baja la tasa de acierto un 8-12 %
  frente a un objetivo fijo, porque los retrocesos normales del 1-3 % de una cripto lo disparan
  antes de tiempo. Va en la guía sin adornos, junto al cálculo de que con 15 % y 1 % lo mínimo que
  se cobra es **+13,85 %**.
- **La marca de agua toca el runner**, que es la pieza más delicada del motor. Se acota a dos
  campos en memoria actualizados en el mismo sitio donde ya se actualiza `lastTicker`, y a una
  lectura en `buildContext`.

## Referencias oficiales

| Fuente | Regla | Cita | Consultado |
|---|---|---|---|
| `asterdex/api-docs` V3 EN | Condición de disparo de un trailing de venta | *«the highest price after order placed >= `activationPrice`, and the latest price <= the highest price × (1 − `callbackRate`)»* | 2026-09-11 |
| `asterdex/api-docs` V3 EN | Rango del retroceso | *«`callbackRate`: min 0.1, max 5 where 1 for 1%»* | 2026-09-11 |
| SDK `@nktkas/hyperliquid` 0.33.3 | No hay trailing: la unión de tipos es cerrada | `t: limit \| trigger`, con `tpsl: "tp" \| "sl"` | 2026-09-11 |
| SDK `zklighter-sdk` 1.3.0 | No hay trailing: el enum va de 0 a 6 | `ORDER_TYPE_LIMIT=0 … ORDER_TYPE_TWAP=6` | 2026-09-11 |

---

## Lo que apareció por el camino

**El worker no compilaba en `main`.** `CandleSourceLike` usa `Venue` sin importarlo
([bot-runner.ts:245](../../apps/worker/src/engine/bot-runner.ts#L245)), de un descuido del spec 040:
`tsc -p tsconfig.build.json` fallaba con `TS2304: Cannot find name 'Venue'`. No lo cazó nada porque
**ni los tests ni el lint compilan el worker entero** —ts-jest transpila fichero a fichero y ESLint
no exige que el proyecto enlace—, y `nest build` no está en ninguna comprobación.

Se arregla aquí, en un commit aparte, porque es una línea y porque es el fichero que este spec toca.
Queda anotado como lo que es: **`pnpm build` del worker debería estar en la lista de comprobaciones**
junto a `pnpm test` y `pnpm lint`. Eso es spec propio.
