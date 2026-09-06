# 016 — Plan

## Enfoque

Protocolo de `specs/README.md`. Dos commits: la parte pura (reconciliación y contabilidad del ciclo, en
`strategy-core`, con sus tests) y el cableado del motor (`recordFill`, `applyFillToCycle`, contexto de
`onFill`). El contrato elegido para el parcial —«la orden viva coincide si lo deseado es el resto o la
original; el escalón se toma al completarse la orden»— cubre los dos casos de la ficha sin que ninguna
estrategia tenga que declarar nada.

Alternativas descartadas:

- Que el plan pida explícitamente el resto de la línea: exigiría que cada estrategia supiera del parcial.
- Reponer exactamente el resto (cancelar y colocar lo que falta): pierde el sitio en la cola por nada.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `strategy-core/src/reconcile.ts` | cantidad = resto **o** original | `apps/worker/src/engine/reconcile.spec.ts` | `81fe4ab` |
| `strategy-core/src/cycle-accounting.ts` | `levelComplete` (por defecto verdadero) | `cycle-accounting.spec.ts` | `81fe4ab` |
| `worker/src/engine/bot-store.ts` | `recordFill` suma el ledger; `applyFillToCycle` calcula `levelComplete` | (sin arnés de Prisma; typecheck y lectura) | `b575a62` |
| `worker/src/engine/bot-runner.ts` | contexto de `onFill` con posición real | — | `b575a62` |
| `docs/{grid-classic,martingale,neutral-grid,gridmart}.md` | bloques de F-83 | grep | cierre |

## Verificación

```bash
pnpm --filter strategy-core test && pnpm build:packages && pnpm --filter worker test -- --forceExit
pnpm test && pnpm lint && pnpm check:env
grep -rn "F-83\|F-17" docs/
```
