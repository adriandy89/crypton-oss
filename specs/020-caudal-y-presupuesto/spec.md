# 020 — Caudal y presupuesto: escrituras con reserva, cupo de órdenes de Aster y realimentación

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/020-caudal-y-presupuesto`

## Objetivo

Que la reserva de escritura del presupuesto proteja lo que debe proteger: cancelaciones, apalancamiento y
margen salen con prioridad de **escritura** en los tres adaptadores (hoy van por el cupo de lectura y un
pánico compite con las lecturas de los demás bots). Que el presupuesto de Aster cuente también las
**órdenes** (1 200 por minuto y 300 cada 10 segundos), no solo el peso, y se **realimente** con las cabeceras
que el venue devuelve en cada respuesta. Y que Lighter no pueda gastar tres minutos de cupo de toda la IP en
una sola llamada.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-10 | Cancelaciones por el cupo de lectura; `SignerClient` de Lighter fuera del limitador; `getOpenOrders()` sin símbolo en Lighter | Alta |
| F-24 | Aster: los límites `ORDERS` (1 200/min y 300/10 s) no existen en el presupuesto, que solo modela el peso | Media |
| F-76 | Aster: las cabeceras `X-MBX-USED-WEIGHT-*` y `X-MBX-ORDER-COUNT-*` se ignoran | Media |

## Alcance

- `packages/exchange-core/src/{venue-budget,venue-weights}.ts`; adaptadores `hyperliquid`, `aster`, `lighter`.
- Tests: `exchange-core.spec.ts` (presupuesto), `adapters/aster.spec.ts`, `adapters/hyperliquid.spec.ts`,
  `lighter-transport.spec.ts`.
- `docs/venues-y-minimos.md`.

## Fuera de alcance

- Cambiar los cupos publicados o el margen (`QUOTA_HEADROOM`).
- Contar por cuenta en vez de por IP el cupo `ORDERS` de Aster («counted against each account»): el
  presupuesto es por IP y red; contar por IP es más conservador y basta.
- El limitador propio del `SignerClient` de Lighter: cada escritura ya descuenta una petición al enviar
  (`sendTx`); aquí se añade la del `nextNonce` que el SDK hace al releer el contador.

## Requisitos

- **R-1** (F-10) Cancelar (una, las propias, todas), fijar apalancamiento, ajustar margen y fijar el modo de
  posición toman presupuesto con prioridad `write` en Hyperliquid, Aster y Lighter. Colocar y modificar ya
  lo hacían.
- **R-2** (F-10) Lighter: `getOpenOrders()` sin símbolo se rechaza con un error claro (216 peticiones firmadas
  contra un cupo de 60 por minuto); ningún consumidor lo usa así. La relectura del nonce descuenta su
  petición del presupuesto.
- **R-3** (F-24) `VenueBudget.takeOrders(venue, n, testnet)`: un segundo depósito para Aster derivado de sus
  dos límites de órdenes con el margen de seguridad (caudal 1 200/min × 0,85 → 17 por segundo; capacidad tal
  que ninguna ventana de 10 s pase de 300 × 0,85). Colocar y modificar una orden en Aster lo consumen.
  En los otros venues es un no-op.
- **R-4** (F-76) `VenueBudget.observe(venue, testnet, lectura)`: Aster entrega `X-MBX-USED-WEIGHT-1M` y
  `X-MBX-ORDER-COUNT-1M`/`-10S` de cada respuesta y los depósitos se recortan a lo que el venue dice que
  queda (nunca se amplían). El presupuesto local deja de ir a ciegas frente a otros clientes de la misma IP.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-4 en verde; `pnpm test:adapters`, `pnpm --filter worker test`, `pnpm test`,
  `pnpm lint`, `pnpm check:env`.
- **CA-2** `docs/venues-y-minimos.md` cuenta el cupo de órdenes de Aster y la realimentación; la ficha de
  F-10, F-24 y F-76 en el 001 lleva la decisión.

## Riesgos

- R-1 hace que una cancelación pueda esperar menos y una lectura más: es el propósito de la reserva.
- R-3 puede frenar a un market maker de muchas capas en Aster: 17 órdenes por segundo por IP es más de lo
  que cualquier despliegue razonable coloca; si frena, es porque el venue habría devuelto 429 y después 418.

## Referencias oficiales

- Aster, `GET /fapi/v3/exchangeInfo` → `rateLimits[]`: `REQUEST_WEIGHT` 2400/MINUTE, `ORDERS` 1200/MINUTE y
  300/10 SECONDS; cabeceras `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` y
  `X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)` (documentación v3, «Limits»).
- Lighter, «Rate limits»: «Standard accounts: 60 requests per rolling minute».
