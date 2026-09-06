# 015 — Liquidaciones y streams por venue: una liquidación se reconoce, la marca viaja y el stream no se queda mudo

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/015-liquidaciones-y-streams-por-venue`

## Objetivo

Que una liquidación del venue se reconozca como tal en Lighter y en Aster (el motor pausa, avisa y no la
cuenta como ejecución propia), que el ticker por WebSocket de Aster lleve el precio de marca, que la
caducidad del `listenKey` de Aster reabra el stream en vez de dejarlo abierto y mudo, y que el barrido de
ejecuciones de Aster respete la ventana de siete días de `userTrades`.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-05 | Lighter ignora `Trade.type` y nunca marca `Fill.liquidation` | Alta |
| F-70 | Aster busca `LIQUIDATION` en el tipo de orden, pero la doc marca las liquidaciones con `autoclose-` en el id de cliente, `x: CALCULATED` y `X: NEW_INSURANCE`/`NEW_ADL` | Alta |
| F-72 | Aster: `mark = mid` en el ticker por WebSocket aunque el venue publica `<symbol>@markPrice@1s` | Media |
| F-73 | Aster: `listenKeyExpired` se ignora y el socket queda abierto y mudo hasta el corte de 24 h | Media |
| F-74 | Aster: `userTrades` con `startTime` sin `endTime` ni tope de siete días | Media |

## Alcance

- `packages/exchange-core/src/adapters/lighter.ts` (`getRecentFills`), `adapters/aster.ts`
  (`handleUserEvent`, `streamTicker`, `getRecentFills`), `ws.ts` (`ReconnectingSocket.reconnect`).
- Tests: `lighter-transport.spec.ts`, `adapters/aster.spec.ts`, `streams.spec.ts`.

## Fuera de alcance

- Qué hace el motor DESPUÉS de reconocer la liquidación: ya existe (`afterLiquidation`, `liquidationAction`)
  y no cambia.
- Confirmar con una lectura firmada el valor real de `Trade.type` en una liquidación de Lighter y el
  `-1127` de Aster: prohibido por las reglas del agente. Se implementa lo que dicen el SDK y la doc.

## Requisitos

- **R-1** (F-05) Un `Trade` de Lighter con `type` distinto de `trade` (`liquidation`, `deleverage`,
  `market-settlement`) se entrega con `liquidation: true`: los tres son cierres forzados por el venue y el
  motor los tiene que tratar como tales.
- **R-2** (F-70) Un `ORDER_TRADE_UPDATE` de Aster se marca como liquidación si el tipo es `LIQUIDATION`, si
  el id de cliente empieza por `autoclose-` o `adl_autoclose`, si `x` es `CALCULATED` o si `X` es
  `NEW_INSURANCE` o `NEW_ADL`; y una ejecución con `x: CALCULATED` emite su fill igual que un `TRADE`.
- **R-3** (F-72) El ticker por WebSocket de Aster abre el flujo combinado `bookTicker` + `markPrice@1s` y
  cada ticker lleva en `mark` la última marca recibida (hasta que llegue, el mid).
- **R-4** (F-73) `listenKeyExpired` fuerza la reconexión del socket de usuario, que pide un `listenKey`
  nuevo.
- **R-5** (F-74) `getRecentFills` de Aster acota `startTime` a ahora − 7 días y manda `endTime`.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-5 en verde; `pnpm --filter exchange-core test`; build; worker en verde;
  `pnpm test`, `pnpm lint`.
- **CA-2** `grep -rn "F-05\|F-70\|F-72\|F-73\|F-74" docs/`: los bloques de F-05 y F-70 (liquidación no
  reconocida) se reescriben.

## Riesgos

- R-1 y R-2 activan en Lighter y Aster el camino de liquidación que hasta ahora solo corría en Hyperliquid:
  el bot pausa y avisa donde antes seguía operando a ciegas. Es la conducta que la guía de riesgo describe.
- R-3 cambia el precio que ven las guardas de riesgo en Aster entre ticks (marca en vez de mid).

## Referencias oficiales

Lighter SDK 1.3.0 `Trade.type: 'trade' | 'liquidation' | 'deleverage' | 'market-settlement'`. Aster V3:
`ORDER_TRADE_UPDATE` (`x: CALCULATED - Liquidation Execution`, `X: NEW_INSURANCE`/`NEW_ADL`, `c:
autoclose-…`, `adl_autoclose`), `<symbol>@markPrice@1s`, flujos combinados `/stream?streams=a/b`,
`listenKeyExpired` («No more user data event will be updated after this event received until a new valid
listenKey used»), `userTrades` («The time between startTime and endTime cannot be longer than 7 days»).
