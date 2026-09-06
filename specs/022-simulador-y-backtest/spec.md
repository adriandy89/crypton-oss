# 022 — Simulador y backtest: los huecos de paridad, declarados y contados

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/022-simulador-y-backtest`

## Objetivo

Que un backtest de market maker diga en sus avisos lo que **no** reproduce (un `plan()` por vela deja sin
sentido el refresco, la espera tras fill y la ventana de volatilidad; una caducidad de órdenes menor que la
vela cotiza en vela alterna; el precio de referencia externo es la propia serie); que el aviso de guardas no
prometa guardas por bot que el replay no ejecuta; y que los rechazos del simulador **se cuenten y se
avisen** en vez de tragarse.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-65 | Backtest: huecos de paridad no declarados para los market makers; un `plan()` por vela; `orderMaxAgeSeconds` frente a la vela; el encabezado promete guardas por bot; los rechazos del simulador se tragan | Media |

La tabla del 001 pedía además «un backtest a cadencia real para medir F-81». F-81 se corrigió en el spec 017
por otro camino (histéresis por línea) y su test unitario es la medida; un replay a cadencia de quince
segundos dentro de cada vela inventaría precios que las velas no traen. Queda fuera, con razón anotada.

## Alcance

- `packages/backtest/src/{engine,warnings}.ts`; `apps/api/src/modules/backtests/backtests.service.ts` (pasa la
  estrategia y la configuración a los avisos).
- Tests: `warnings.spec.ts` (nuevo), `engine.spec.ts`.
- `docs/simulacion-y-backtest.md`, `docs/neutral-grid.md`.

## Fuera de alcance

- Planificar en cada sub-tick o a cadencia real: multiplicaría el coste por veinte (velas de 5 m) para
  ejecutar contra un recorrido intra-vela **inventado** (apertura → extremo → extremo → cierre). El backtest
  declara la hipótesis; no la disfraza.
- Rechazar por saldo insuficiente en el simulador: hoy el simulador acepta cualquier orden en reposo y solo
  liquida por la tasa de mantenimiento; es otro hueco declarado (aviso 8).

## Requisitos

- **R-1** (F-65) `fidelityWarnings` recibe la estrategia y la configuración: para los market makers añade que
  se recotiza **una vez por vela** (refresco, espera tras fill y volatilidad no se reproducen), que el precio
  de referencia externo es la propia serie, y —si `orderMaxAgeSeconds` es menor que la vela— que las órdenes
  caducan en cada vela.
- **R-2** (F-65) El aviso de guardas dice que **ninguna** guarda de riesgo se simula salvo el stop-loss y la
  liquidación: ni las de cuenta ni las del bot (pérdida diaria, kill-switch, acción al acercarse la
  liquidación).
- **R-3** (F-65) Los rechazos del simulador al colocar se cuentan y salen en los avisos con sus motivos, en vez
  de perderse en un `catch` vacío.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-3 en verde; `pnpm test:backtest`, `pnpm --filter api test`, `pnpm test`, `pnpm lint`.
- **CA-2** El bloque de F-65 sale de `docs/simulacion-y-backtest.md` y de `docs/neutral-grid.md`; la fila de
  F-65 en el 001 lleva la decisión.

## Riesgos

Ninguno operativo: cambian textos de avisos y se añade un contador; el resultado numérico del replay no
cambia.

## Referencias oficiales

Ninguna: contratos internos del backtest.
