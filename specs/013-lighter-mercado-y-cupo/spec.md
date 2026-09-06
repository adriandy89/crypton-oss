# 013 — Lighter: mercado con holgura, cupo de órdenes y errores con nombre

Estado: `hecho` (2026-09-06; F-54 sigue abierto como fase aparte) · Tipo: `cambio` · Rama: `spec/013-lighter-mercado-y-cupo`

## Objetivo

Que en Lighter una orden a mercado cruce (y no se dé por ejecutada sin serlo), que un corte por cupo no se
reintente, que las lecturas de cuenta vayan firmadas, que el tope de treinta órdenes por mercado se avise
antes de crear el bot, que los rechazos del venue se clasifiquen por su vocabulario real, que un fallo al
cargar el nonce no deje firmar con cero, que la edad de las órdenes sea la real y que una reconexión no
reenvíe suscripciones en ráfaga. Estará hecho cuando los tests nuevos pasen y los dependientes sigan en
verde.

## Contexto

Hallazgos del spec 001 sobre Lighter (`informes/C-lighter.md` §4, LT-3 a LT-14):

| F | Título | Sev. |
|---|---|---|
| F-47 | Órdenes a mercado con el mark como tope **sin holgura**, y acuse `FILLED` por decreto | Alta |
| F-48 | Un 429 en una escritura llega como texto, cae en RETRYABLE y se reintenta tres veces sin enfriamiento | Alta |
| F-49 | Las lecturas de cuenta del SDK salen sin la cabecera `authorization` y gastan el cupo de IP | Alta |
| F-50 | 30 órdenes activas por mercado (Standard): nadie lo modela ni lo avisa | Alta |
| F-51 | `safely()` no reconoce «given order is not an active order» y compañía | Media |
| F-52 | Clasificación: 21728, 21507/21508, 21733-21735, 21601, 21108/21109, 21132 | Media |
| F-53 | El `.catch` de `signerReady` es inalcanzable: se firma con nonce 0 | Media |
| F-55 | `createdAt = Date.now()` en cada sondeo (la caducidad por edad de los MM nunca dispara), y otros mapeos | Media |
| F-56 | Resuscripción en ráfaga tras reconectar frente a «200 mensajes por minuto» | Media |
| F-16 | `timeInForce` de la petición se ignora (parte Lighter) | Media |
| F-54 | Sin stream de cuenta: sondeo cada 12 s por símbolo | Media (fase aparte) |

## Alcance

- `packages/exchange-core/src/adapters/lighter.ts`, `errors.ts`, `ws.ts` si hace falta; `packages/shared`
  (`MarketSpec.maxActiveOrders`); `packages/strategy-core/src/common.ts` (`buildPreview` avisa del tope);
  `apps/worker/src/engine/bot-runner.ts` (`safely`).
- Tests: `lighter-signer.spec.ts`, `lighter-transport.spec.ts`, `errors.spec.ts`, `strategies.spec.ts`,
  `bot-runner.spec.ts`.

## Fuera de alcance

- **F-54**, el stream de cuenta (`account_all/*`): es una función nueva del adaptador cuya forma de
  mensaje no está confirmada sin una conexión autenticada; queda como fase aparte de este spec, sin fecha.
- Confirmar con sonda firmada los umbrales de 21734/21735, la unidad de `initial_margin_fraction` y si el
  secuenciador ejecuta parcialmente una IOC que no cruza: prohibido por las reglas del agente.
- `Position.markPrice = last_trade_price` (F-55): exige otra fuente de precio de marca; se anota.

## Requisitos

- **R-1** (F-47, F-16) Una `MARKET` sin disparador sale con **5 % de holgura** en contra (compra ×1,05,
  venta ×0,95), la misma que Hyperliquid y que ya aplica el adaptador a los disparadores a mercado; su
  acuse es `PENDING`, no `FILLED`: la ejecución la confirma el sondeo de `trades` (y si el secuenciador la
  cancela, la fila vence a los cinco minutos por F-37 y el nivel se recoloca). `req.timeInForce = 'IOC'`
  en una `LIMIT` sale como IOC.
- **R-2** (F-48) La tupla del SDK con «Too Many Requests!» (23000) o una página del cortafuegos se convierte
  en `THROTTLED`, registra el enfriamiento y **no** se reintenta.
- **R-3** (F-52, F-50, F-51) Clasificación: 21108/21109 → AUTH; 21507/21508 → INSUFFICIENT_FUNDS;
  21733/21734/21735, 21717-21720 y 21132 → RULES; 21601 → RETRYABLE. Un 21728 («client order index already
  exists») tras un acuse perdido se resuelve buscando la orden que **ya está** y devolviendo su acuse. La
  regex de `safely()` reconoce «not an active», «is inactive», «order is empty», «not owner».
- **R-4** (F-49) Antes de cada llamada al SDK se renueva la cabecera `authorization` (el SDK la lee en cada
  petición): las lecturas de cuenta salen firmadas y cuentan por cuenta, no por IP.
- **R-5** (F-53) Si tras `initialize()` el contador de nonce sigue a cero, `signerReady` lo trata como
  fallo: no firma, deja reintentar la carga en la siguiente escritura y lanza RETRYABLE.
- **R-6** (F-50) `MarketSpec.maxActiveOrders` (Lighter 30, Aster 200) y `buildPreview` añade un WARN cuando
  la configuración tiende más niveles que el tope: «Lighter admite 30 órdenes activas por mercado con
  cuenta Standard; esta configuración tiende N».
- **R-7** (F-55) `createdAt` de una orden viva sale de la marca del venue (`timestamp`), no de `Date.now()`.
- **R-8** (F-56) Al reconectar, la resuscripción se envía en lotes espaciados por debajo de 200 mensajes por
  minuto (los primeros cincuenta de golpe, el resto cada 350 ms).

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-8 en verde en sus specs; `pnpm --filter exchange-core test`, `pnpm test`,
  `pnpm lint` en verde; `pnpm build:packages` y worker en verde tras tocar `shared` y `strategy-core`.
- **CA-2** `grep -rn "F-47\|F-48\|F-49\|F-50\|F-5[1-6]\|F-16" docs/`: los bloques de F-47, F-50 y F-55 se
  reescriben (R-1, R-6, R-7); F-54 sigue citado como abierto.

## Riesgos

- R-1 cambia la conducta de los bots de Lighter: una MARKET que hoy se cancelaba por no cruzar pasará a
  ejecutarse hasta un 5 % peor. Es lo que ya hace Hyperliquid y lo que la ayuda de la app describe.
- R-6 es un aviso, no un veto: una cuenta Premium tiene topes más altos y no se conoce el tier desde aquí.

## Referencias oficiales

`docs/trading` («worst price you're willing to accept … the order is cancelled»; «code=200 … does not
guarantee the execution»), `docs/rate-limits` (2026-08-30: 60/min Standard; «Active Orders — Per Market
30»; «Max Messages Sent By Client Per Minute: 200»; firewall 60 s), `docs/data-structures-constants-and-errors`
(mensajes 21xxx literales), `reference/accountActiveOrders` (`authorization` required), SDK `signer.js`
(`OptimisticNonceManager.initialize` traga el fallo). Citas completas en
`specs/001-revision-integral/informes/C-lighter.md`.
