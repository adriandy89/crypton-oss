# 029 — El market maker cotiza contra el libro

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/029-market-maker-contra-el-libro`

## Objetivo

Que ninguna cotización de un market maker salga cruzando el libro del venue, que un bot cargado que
no consigue reducir inventario lo diga, y que los avisos de Telegram no mezclen dinero simulado con
dinero real. Se sabrá conseguido cuando exista un test que compare el precio de cada cotización
contra el BBO —hoy no hay ninguno— y esté en verde.

## Contexto

Un bot simulado (`m v1`, LIT, Lighter) mandó por Telegram avisos de rechazo post-only en **ventas**.
El usuario preguntó si era normal. El rechazo lo es como evento —la documentación lo dice
(`docs/grid-classic.md:240`)—, pero lo que lo provocaba no.

El precio de una cotización se construye como `centro × (1 ± bps)` y **en ningún punto del sistema
se comparaba con el mejor bid/ask**:

- En todo `strategy-core` el libro se lee en cuatro líneas, todas dentro de `bookMid` y
  `bookSpreadBps` (`mm-shared.ts:42-55`). Ninguna estrategia comparaba el precio de una orden con el
  BBO.
- `revisarOrden`, la última puerta antes del venue, no recibe el ticker (`order-gate.ts:44-57`):
  estructuralmente no puede detectar un cruce.
- No existía en ningún fichero el clamp `ask = max(ask, bestBid + tick)`.

Y el centro no es el mid: es `skewedMid`, desplazado en proporción al inventario
(`market-maker.ts:774`), sin tope relativo al libro. Con los valores de fábrica, perfil agresivo e
inventario largo al tope, la venta sale ≈6 bps **por debajo** del mid vivo. `minAllowedDistanceBps`
no protege: es una distancia mínima respecto al centro ya desplazado, no respecto al mid.

En alto riesgo el lado comprador se apaga (`REGIME_DISTANCE.HIGH_RISK.adding = 0`), así que **sólo
salen ventas**: justo el síntoma observado.

Qué cuesta: con `postOnly` (el defecto) el venue rechaza, el bot deja de cotizar y **no puede
reducir inventario** cuando va cargado; sin `postOnly`, vende por debajo del mejor bid pagando
taker. Y no había red: un rechazo `RULES` no incrementa ningún contador (`bot-runner.ts:1067` sólo
cuenta los `RETRYABLE`), entre el 90 % y el 100 % del tope no hay ninguna acción, y el MM v1 no trae
`stopLossPct` en `defaults()`.

## Alcance

- `packages/strategy-core`: `mm-shared.ts`, `market-maker.ts`, `market-maker-v2.ts`, `testing.ts`.
- `apps/worker`: `bot-runner.ts` (cortacircuitos de rechazos, cuarentena, avisos de stream) y
  `notifications/notifier.service.ts`.
- `packages/exchange-core`: `venue-budget.ts` y adaptadores (prioridad crítica del stop-loss).
- `apps/app`: etiquetas de eventos y guías de las dos estrategias.
- `docs/`: market maker v1 y v2, comandos y eventos, simulación.

## Fuera de alcance

- Una **guarda de divergencia** entre la fuente externa de precio y el libro del venue: se anota
  como seguimiento. El clamp ya impide el daño (la orden no cruza); avisar de que Binance y el venue
  no coinciden es un aviso nuevo, con su parámetro, y merece su propio spec.
- Reescribir el sesgo por inventario. Se deja como está: el clamp lo contiene.
- `packages/db` y cualquier migración.

## Requisitos

- **R-1** Ninguna cotización de MM v1 o v2 puede colocarse en el toque contrario o más allá: una
  venta nunca en el mejor bid o por debajo, una compra nunca en el mejor ask o por encima.
- **R-2** El clamp se aplica antes de dimensionar la orden, para que el nocional corresponda al
  precio que se envía.
- **R-3** Sin los dos lados del libro (`bid > 0` y `ask > 0`) el market maker no cotiza, y la nota
  dice por qué.
- **R-4** Un rechazo por reglas del lado que reduce inventario deja de ser invisible: cuenta, y
  superado un umbral se avisa en CRITICAL.
- **R-5** La cuarentena no puede congelar una orden que reduce inventario por una rechazada antes
  como entrada.
- **R-6** La nota del bot cuenta las cotizaciones colocadas, no las deseadas.
- **R-7** El stop-loss tiene prioridad sobre una recotización al repartir el presupuesto del venue.
- **R-8** El resumen diario de Telegram no suma el PnL de bots simulados al de los reales, y todo
  aviso de un bot simulado va marcado como tal.
- **R-9** `STREAM_ERROR` no se repite sin cooldown y avisa cuando el stream se restablece.

## Criterios de aceptación

- **CA-1** `pnpm test:strategies` incluye tests que comparan el precio de cada cotización contra el
  BBO con inventario al tope, con `inventorySkewFactor: 3`, en corto, y con el centro congelado;
  todos en verde. Cada uno falla en la línea base.
- **CA-2** `pnpm test:backtest`, `pnpm --filter worker test` y el typecheck de la app en verde.
- **CA-3** Un test del worker demuestra que N rechazos del lado que reduce producen un CRITICAL.
- **CA-4** Un test demuestra que una orden `reduceOnly` no queda bloqueada por la cuarentena de su
  versión de entrada.
- **CA-5** `notifier.service.spec.ts` demuestra que un ciclo simulado no entra en la cifra del
  resumen diario y que la etiqueta de un bot simulado lo dice.
- **CA-6** Un test demuestra que una orden con disparador adelanta a una cotización cuando el
  presupuesto está seco.
- **CA-7** `pnpm test` y `pnpm lint` completos en verde.
- **CA-8** (manual, usuario) Un MM simulado en un par de spread estrecho no produce rechazos
  post-only en bucle en la bitácora.

## Riesgos

- **Los precios de los market makers cambian.** Es el objeto del spec, pero afecta a bots en marcha:
  a partir del despliegue, una cotización que antes se rechazaba ahora se coloca pegada al toque.
  Nunca empeora la ejecución (una compra clampada compra más barato; una venta, vende más cara),
  pero el bot pasa a tener órdenes donde antes no tenía ninguna.
- **El backtest de un MM da otro resultado.** Antes daba por colocadas órdenes que un venue real
  habría rechazado. Se compara antes/después y se deja constancia.
- **Recotización más frecuente mientras el bot está pegado al toque**: el precio clampado sigue al
  libro. Se mitiga con el recotizado por capa y se vigila con la cuota de Lighter.
- Cambiar `defaults()` de una estrategia lo prohíbe `CLAUDE.md` sin decisión explícita del usuario:
  el stop por defecto se decide con él y sólo afecta a bots nuevos.

## Referencias oficiales

- Lighter, `rate-limits` (consultado 2026-08-30): «Standard: 60 requests/minute per IP»; «Active
  Orders — Per Market 30».
- El resto de reglas de venue en las que se apoya el spec ya están citadas en `specs/001` (F-49,
  F-50) y no se repiten aquí.
