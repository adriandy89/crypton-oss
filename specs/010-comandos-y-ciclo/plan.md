# 010 — Plan

## Enfoque

Cinco correcciones independientes con el protocolo de `specs/README.md`: test rojo, diff mínimo,
aprobación viendo el diff, commit por corrección. Orden por daño: F-80 (bucle de pérdidas activable desde
el formulario), F-84 (duplica exposición), F-85, F-86, F-92.

Alternativas descartadas:

- F-80 retirando la opción `MARKET` del formulario: cambia `meta.fields` (decisión de producto) y deja sin
  salida a quien la quería; la condicional es lo que la ayuda siempre prometió.
- F-84 recentrando también Grid Classic (remapear `filledLevelIndexes` a las líneas nuevas): exige definir
  qué venta corresponde a cada compra tras mover las líneas; es el spec 017. Rechazar es seguro hoy.
- F-86 pasando `cooldownMinutes` a WARM: no hace falta; basta leer la config vigente al cerrar el ciclo.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/strategy-core/src/strategies/martingale.ts:380-389` | `tpMode === 'MARKET'` → `type: 'MARKET'` + `triggerPrice` | `strategies.spec.ts`, `bot-runner.strategies.spec.ts` |
| `apps/worker/src/engine/bot-runner.ts:1357-1374` | `REANCHOR_GRID` por estrategia (rechazo / confirm / recentrado real) | `bot-runner.spec.ts` |
| `apps/api/src/modules/bots/bots.service.ts` (`command`) | `REANCHOR_GRID` exige `confirm` y se rechaza fuera de las escaleras | `bots-reanchor.spec.ts` |
| `apps/app/src/app/shared/bot/bot-commands.service.ts:17-29` | ocultar `REANCHOR_GRID` en TDCA y MM; `ADD_SAFETY_NOW` solo en escaleras | `pnpm --filter app build` |
| `apps/worker/src/engine/bot-runner.ts:1401-1424` | `ADD_SAFETY_NOW` al mark; evento según acuse | `bot-runner.spec.ts` |
| `apps/worker/src/engine/bot-store.ts` (`applyFillToCycle` → `cycleAfterFill`) | `opts.cooldownMinutes` de la config vigente | `bot-runner.spec.ts` |
| `packages/strategy-core/src/strategies/martingale.ts:314-327`, `gridmart.ts:391-401` | base LIMIT: precio fijado, caducidad, sin persecución | `strategies.spec.ts` |
| `apps/app/src/app/core/content/{ladder-options,neutral-grid.guide}.ts`, `field-labels.ts` | fichas vuelven a la conducta nueva | build |
| `docs/*.md`, `specs/001-revision-integral/findings.md` | bloques F-NN; fichas «Decisión» | grep |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama desde `spec/009-protecciones-y-cierre`; build; baterías | verde |
| 1 | F-80 → build → worker, backtest, app | CA-1 |
| 2 | F-84 (worker + API + app) → worker, api, app typecheck | CA-2 |
| 3 | F-85 | CA-3 |
| 4 | F-86 | CA-4 |
| 5 | F-92 → build → worker, backtest | CA-5 |
| 6 | Cierre: docs, fichas in-app, fichas del 001, índice, memoria | CA-6, CA-7 |

## Verificación

```bash
pnpm build:packages
pnpm --filter strategy-core test
pnpm --filter worker test
pnpm --filter @crypton/backtest test
pnpm --filter app build
pnpm test && pnpm lint
grep -rn "F-80\|F-84\|F-85\|F-86\|F-92" docs/
```

Manual (usuario, bot simulado): Martingala con `tpMode: MARKET` → la salida aparece en la pestaña
Escalera como condicional y no cierra hasta tocar el objetivo; «Recentrar» en una rejilla clásica con
inventario → `ACTION_FAILED` con motivo; «Adelantar seguridad» → `FILL` y `SAFETY_ADDED`, o WARN.
