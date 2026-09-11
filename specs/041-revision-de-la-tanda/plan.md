# 041 — Plan

## Enfoque

Un test que falla por cada defecto, el arreglo, y el test en verde. Sin refactor y sin mandos
nuevos: los cuatro son correcciones de lógica dentro de código escrito ayer.

El orden lo manda el riesgo: primero la entrada duplicada (Crítica), luego las dos que rompen la
promesa de riesgo acotado, y al final la medida contaminada.

## Ficheros afectados

| Fichero | Qué | Tests |
|---|---|---|
| `strategies/trend-follow.ts` | F-01 (bandera fuera), F-02 (stop anclado en la entrada), F-03 y F-05 (techo de nocional) | `trend-follow.spec.ts` |
| `strategies/mm-shared.ts` | F-04 (markout rancio) | `mm-inteligencia.spec.ts` |
| `docs/trend-follow.md` | Lo que el usuario tiene que saber del techo | — |

## Fases

| Fase | Qué | Salida |
|---|---|---|
| 0 | Línea base sobre `main` con 037-040 dentro | 6.146 tests verdes |
| 1 | Seis tests que fallan, con la salida anotada | Fallan por el motivo declarado |
| 2 | Los cuatro arreglos | Los seis en verde |
| 3 | Cierre: `findings.md`, docs, índice | CA-7 |

## Verificación

```bash
pnpm build:packages
pnpm test:strategies · pnpm --filter worker test · pnpm test:backtest · pnpm --filter api test
pnpm lint · pnpm test
pnpm --filter app exec ng build
```

Cada arreglo se comprobó **quitándolo** con `git stash` y viendo fallar su test. La salida más
elocuente es la de F-04: sin el arreglo, un markout de −1000 bps entra en la media como si fueran
treinta segundos.
