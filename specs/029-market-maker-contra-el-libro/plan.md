# 029 — Plan

## Enfoque

Se corrige de dentro afuera: primero la causa (el precio que cruza), luego lo que la hacía
invisible (rechazos que no cuentan, nota que miente), luego lo que la agrava (cuota del venue) y por
último el canal por el que llegó la queja (los avisos).

El clamp vive en `strategy-core`, junto al conocimiento del libro, y **no** en `order-gate.ts`:
cambiar la firma de `revisarOrden` obligaría a tocar las siete estrategias para un problema que hoy
sólo tienen las dos de market making. Si más adelante hace falta la misma red para las rejillas, se
sube ahí con su propio spec.

Descartado durante la fase 2: acotar también el **centro** al BBO. Rompía la congelación de
`quotedMid` —que existe justo para no perseguir al precio— y habría recotizado en cada tick,
disparando el churn que la fase 5 intenta reducir. El clamp por lado es suficiente: sólo actúa
cuando la orden cruzaría de verdad.

## Ficheros

| Fase | Ficheros |
|---|---|
| C-1 | `strategies/mm-shared.ts`, `market-maker.ts`, `market-maker-v2.ts`, `testing.ts`, `strategies.spec.ts` |
| C-2 | `apps/worker/src/engine/bot-runner.ts` y su `.spec.ts` |
| C-3 | `market-maker.ts` (`buildNote`, `defaults`), `market-maker-v2.ts` |
| C-4 | `packages/exchange-core/src/venue-budget.ts`, adaptadores, `cooldown.ts` |
| C-5 | `apps/worker/src/notifications/notifier.service.ts` (+ spec nuevo), `bot-runner.ts`, `apps/app/.../labels.ts` |
| C-6 | `notifier.service.ts` |
| Docs | `docs/market-maker*.md`, `docs/comandos-guardas-y-eventos.md`, `docs/simulacion-y-backtest.md`, guías de la app |

## Verificación

`pnpm build:packages` antes de nada. Por fase: los tests del paquete tocado y los de sus
dependientes (`strategy-core → backtest, worker y typecheck de la app`). Al cierre, `pnpm test` y
`pnpm lint` completos. Jest desde Git Bash, no desde PowerShell.

Comprobación manual del usuario, con la infra levantada: un MM simulado en un par de spread
estrecho sin rechazos post-only en bucle; cortar el socket y ver un solo `STREAM_ERROR` y su
`STREAM_RECOVERED`; y el resumen de las 21:00 sin PnL simulado.
