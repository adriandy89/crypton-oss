# 011 — Plan

## Enfoque

Tres correcciones con el protocolo de `specs/README.md`. F-34 y F-71 en la misma fase: primero el veto de
`HEDGE` en Aster (strategy-core, con test), después reexponer las operaciones en `AccountHandle` (worker),
después la API. F-08 al final.

Alternativa descartada: implementar `positionSide` en Aster antes de reexponer nada. Es más trabajo, exige
sonda firmada para confirmar el comportamiento real (fuera del alcance de cualquier spec sin autorización)
y nadie lo ha pedido.

## Ficheros afectados

| Fichero | Qué cambia | Tests |
|---|---|---|
| `packages/strategy-core/src/strategies/mm-shared.ts` o `validateCommon` | ERROR si `positionMode: HEDGE` con venue Aster | `strategies.spec.ts` |
| `apps/worker/src/engine/account-hub.service.ts` | `AccountHandle.adjustIsolatedMargin`, `setPositionMode` | `paper-accounts.spec.ts` |
| `apps/worker/src/engine/bot-runner.ts` (`adjustMargin`, aplicación de `positionMode`, marcado de comandos) | usar el handle; idempotencia | `bot-runner.spec.ts` |
| `apps/api/src/modules/bots/bots.service.ts` (comando `ADJUST_MARGIN`) | no subir `total_investment` sin acuse | `bots.service.spec.ts` |
| `docs/comandos-guardas-y-eventos.md`, `riesgo-y-liquidacion.md`, `venues-y-minimos.md`, guías MM | bloques F-34, F-71, F-08 | grep |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama, build, baterías | verde |
| 1 | Veto `HEDGE` en Aster (test rojo → diff → commit) | test verde |
| 2 | `AccountHandle` reexpone; `adjustMargin` y `positionMode` lo usan | `paper-accounts.spec.ts`, `bot-runner.spec.ts` |
| 3 | API: `total_investment` tras acuse | `bots.service.spec.ts` |
| 4 | F-08 idempotencia | `bot-runner.spec.ts` |
| 5 | Cierre: docs, fichas, índice | CA-3 |

## Verificación

```bash
pnpm build:packages && pnpm --filter strategy-core test && pnpm --filter worker test && pnpm --filter api test
pnpm test && pnpm lint
grep -rn "F-34\|F-71\|F-08" docs/
```
