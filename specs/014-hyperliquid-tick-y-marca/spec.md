# 014 — Hyperliquid: el precio que se planifica es el que se envía, y la marca es la marca

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/014-hyperliquid-tick-y-marca`

## Objetivo

Que en Hyperliquid el precio que planifica la estrategia y el que envía el adaptador se calculen con la misma
regla (cinco cifras significativas, enteros siempre válidos), para que el reconciliador deje de cancelar y
recolocar en cada tick las órdenes de la década superior; que `Ticker.mark` sea el precio de marca del venue
y no el punto medio del libro, y que un libro con un lado vacío no invente un precio; que un throttle enfríe
al adaptador como en los otros dos venues; que se avise al acercarse al tope de diez conexiones WebSocket por
IP; y que la comisión de builder tenga tope y el acuse se lea con guardas.

## Contexto

Hallazgos del spec 001 sobre Hyperliquid (`informes/C-hyperliquid.md`):

| F | Título | Sev. |
|---|---|---|
| F-04 | El tick se calcula sobre el mid del catálogo; por encima del siguiente salto de década el precio enviado deja de ser el planificado y la orden se cancela y recoloca en **cada** tick (el stop de un SHORT, sin red entre reemplazos) | Alta (candidata a Crítica) |
| F-25 | `Ticker.mark` lleva el punto medio del libro y no `markPx`, que es el que gobierna la liquidación | Alta |
| F-26 | Con un lado del libro vacío el precio queda a la mitad del otro lado, y nada lo rechaza | Alta |
| F-27 | Un WebSocket por cuenta frente a diez conexiones y diez usuarios por IP; nada cuenta ni avisa | Alta |
| F-28 | Único venue sin enfriamiento local tras un throttle | Media |
| F-16 | `builderFeeTenthBps` sin tope; `statuses[0]` sin guardas (parte Hyperliquid) | Media |

## Alcance

- `packages/shared/src/{market,precision}.ts`: `MarketSpec.maxSignificantDigits` y la regla en la única
  puerta de redondeo (`roundPriceForSide`/`normalizeOrder`).
- `packages/exchange-core/src/adapters/hyperliquid.ts`: `formatPrice` usa la misma puerta; `getTicker`
  y `streamTicker` llevan `markPx`; lado vacío → RETRYABLE; `VenueCooldown`; tope del builder; guardas del
  acuse.
- `apps/worker/src/engine/account-hub.service.ts`: aviso al abrir la décima cuenta de Hyperliquid.
- Tests: `shared/src/precision.spec.ts` (nuevo), `exchange-core/src/adapters/hyperliquid.spec.ts` (nuevo),
  `streams.spec.ts`, `paper-accounts.spec.ts`.

## Fuera de alcance

- Compartir un transporte WebSocket entre cuentas de Hyperliquid (la solución de fondo de F-27): cambia el
  modelo «un adaptador por cuenta» del `AccountHub`; aquí solo se cuenta y se avisa.
- La reconciliación con tolerancia distinta de medio tick: con desired y enviado calculados igual ya no
  hace falta.

## Requisitos

- **R-1** (F-04) `MarketSpec.maxSignificantDigits` (Hyperliquid: 5). `roundPriceForSide` aplica, tras la
  retícula, el recorte a cifras significativas **en la dirección del lado** (compra hacia abajo, venta hacia
  arriba) y respeta los enteros, que el venue admite siempre. `formatPrice` del adaptador usa exactamente esa
  función: `px()` de la estrategia y el precio enviado coinciden y el reconciliador no reemplaza.
- **R-2** (F-25) `getTicker` y `streamTicker` devuelven en `mark` el `markPx` del venue (`metaAndAssetCtxs`
  memoizado en REST; `activeAssetCtx` en WebSocket) y el mid en `last`.
- **R-3** (F-26) Con un lado del libro vacío, `getTicker` usa el `markPx`; si tampoco lo hay, lanza
  RETRYABLE. Nunca la mitad del otro lado.
- **R-4** (F-28) `VenueCooldown` cableado en `call()` y `callWrite()`: un THROTTLED enfría y, mientras dure,
  la mejor petición es la que no se manda.
- **R-5** (F-27) `AccountHub` avisa (WARN en el log) al abrir la décima cuenta real de Hyperliquid del
  proceso: «el venue admite diez conexiones y diez usuarios por IP».
- **R-6** (F-16, F-04b) `builderFeeTenthBps` fuera de (0, 100] (0,1 %, el máximo del venue en perps) se
  omite (el adaptador no adjunta builder); un acuse sin `statuses` lanza RETRYABLE en vez de reventar; y
  `modifyOrder` formatea el precio por la misma puerta y conserva el post-only (`Alo`) de la orden.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-6 en verde; `pnpm build:packages`; `strategy-core`, `worker`, `backtest`, `api`
  en verde tras tocar `shared`; `pnpm test`, `pnpm lint`.
- **CA-2** `grep -rn "F-04\|F-25\|F-26\|F-27\|F-28\|F-16" docs/` sin bloques «Limitación conocida» de los
  cerrados (F-27 se reescribe como aviso).

## Riesgos

- R-1 cambia el precio que se envía en Hyperliquid para los precios no enteros de la década superior: hasta
  ahora se redondeaba HALF_UP a cinco cifras; ahora se recorta hacia el lado seguro. La diferencia es de un
  tick de cinco cifras, siempre a favor del bot (paga menos, vende más caro), y es lo que el SDK oficial
  hace («truncates, does not round»).
- R-2 cambia el precio de las guardas de riesgo en Hyperliquid (marca en vez de mid): es lo que los otros
  dos venues ya hacen y lo que el tipo `Ticker` promete.

## Referencias oficiales

Hyperliquid docs, «Tick and lot size»: «Prices can have up to 5 significant figures, but no more than
MAX_DECIMALS - szDecimals decimal places … Integer prices are always allowed, regardless of the number of
significant figures»; «Rate limits and user limits»: «Maximum of 10 websocket connections … Maximum of 10
unique users across user-specific websocket subscriptions»; `metaAndAssetCtxs` devuelve `markPx`,
`oraclePx` y `midPx`; suscripción `activeAssetCtx`. Citas en `specs/001-revision-integral/informes/`.
