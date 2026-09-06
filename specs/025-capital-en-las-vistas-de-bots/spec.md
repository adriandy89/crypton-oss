# 025 — Capital en las vistas de bots: cuánto dinero hay ahora, cuánto se puso y qué hay en juego

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/025-capital-en-las-vistas-de-bots`

## Objetivo

Que la lista de bots diga **cuánto dinero tiene ahora cada bot**, y que el detalle diga **cuánto se puso al
principio, cuánto hay asignado hoy y cuánto vale ahora**, con la información que un exchange profesional
pone al lado de una posición: valor de la posición a precio de marca, margen usado, PnL abierto con su
rentabilidad sobre el margen, precio de marca junto al precio medio y a la liquidación.

## Contexto

Petición del usuario (2026-09-06). Hoy la tarjeta enseña «PnL total», «ROI», «Órdenes» y «Activo», y el
resumen del detalle «Resultado acumulado» con su curva. Ninguna de las dos pantallas dice el capital: el
usuario tiene que sumar de cabeza lo que puso y lo que lleva ganado. `BotSummary` trae `totalInvestment`,
`realizedPnl` y `unrealizedPnl`; el snapshot trae `margin_used`, `mark_price` y `position_qty`; la
revisión 1 de la configuración guarda lo que se puso al crear el bot. Todo existe y no se enseña.

Vocabulario, fijado aquí para no chocar con el de la cartera (spec 002, R-7):

- **Capital asignado**: `totalInvestment` vigente. Lo que el usuario tiene puesto hoy (puede haber
  cambiado con «Aportar margen» contando como capital o editando la configuración).
- **Capital inicial**: `totalInvestment` de la revisión 1. Lo que puso al crear el bot.
- **Capital actual**: asignado + realizado + abierto. Es patrimonio, no resultado: la curva del detalle
  sigue llamándose «resultado acumulado» porque `bot_snapshots.equity` es PnL.
- **Valor de la posición**: |cantidad| × precio de marca. **Margen usado**: el del snapshot.
- **PnL abierto sobre el margen**: `unrealizedPnl / marginUsed × 100` (el «ROE» de los exchanges).

## Alcance

- `packages/shared/src/capital.ts` (nuevo) con test: la aritmética vive en `shared`, la app no suma dinero.
- `packages/shared/src/bot.ts`: `BotSummary.currentCapital`, `positionValue`, `marginUsed`.
- `apps/api/src/modules/bots/bots.service.ts`: `metricsOf` calcula los tres; `detail` añade
  `initialInvestment` (revisión 1). Test nuevo `bots-summary.spec.ts`.
- `apps/app`: `ui-stat` gana `hint`; tarjeta de la lista; bloque «Capital» del resumen; modelo `BotDetail`.

## Fuera de alcance

- Moneda junto a las cifras: la app no la pinta en ninguna pantalla y `BotSummary` no trae la quote; se
  mantiene la convención de la casa (cifras sin unidad, coma decimal).
- La cartera (`portfolio`): ya enseña «Capital asignado» agregado; no se toca.
- Cambiar qué guarda el snapshot o el motor.

## Requisitos

- **R-1** `capitalActual(asignado, realizado, abierto)`, `valorDePosicion(qty, mark)` y
  `retornoSobreMargen(abierto, margenUsado)` en `shared`, con `Decimal` y test.
- **R-2** `BotSummary` trae `currentCapital`, `positionValue` (null sin precio) y `marginUsed`; la API los
  calcula en `metricsOf` con el precio vivo si lo hay (el mismo que usa la distancia a liquidación) y, si
  no, con el del snapshot. Lista y detalle comparten el cálculo.
- **R-3** El detalle trae `initialInvestment` (revisión 1; si no existe, el asignado).
- **R-4** La tarjeta de la lista enseña «Capital actual» con «de X asignados» debajo, «PnL total», «ROI» y
  «Órdenes», y una línea de datos con la posición y su valor, el margen usado y el tiempo activo.
- **R-5** El resumen del detalle abre con un bloque «Capital»: capital actual en grande, asignado, inicial (si
  difiere) y resultado; debajo valor de la posición, margen usado y PnL abierto con su rentabilidad sobre
  el margen. El precio de marca acompaña al precio medio en la ficha de métricas.
- **R-6** `ui-stat` admite una línea secundaria (`hint`) sin cambiar a quien no la usa.

## Criterios de aceptación

- **CA-1** `pnpm --filter shared test`, `pnpm --filter api test -- bots-summary`, `pnpm test`, `pnpm lint`;
  typecheck, lint y `ng build` de la app.
- **CA-2** Con la API y la app levantadas, un bot con posición enseña capital actual = asignado + PnL total
  en la tarjeta y en el resumen, y el resumen enseña inicial y asignado — comprobación manual del usuario.

## Riesgos

- Ninguno operativo: la API añade campos a una respuesta existente y la app los pinta. Un servidor sin
  actualizar deja los campos nuevos en `undefined`: la app los trata como «—».

## Referencias oficiales

Ninguna: contratos internos.
