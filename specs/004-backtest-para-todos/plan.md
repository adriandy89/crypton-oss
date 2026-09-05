# 004 — Plan

## Enfoque

Primero la verdad, después el acceso. La fase 1 arregla el simulador (F-45) con el test que falla
primero, porque abrir el backtest a todos con el stop roto multiplicaría el daño. Después la API
deja de ser de administrador y se acota al usuario; y al final la pantalla gana lo que le faltaba:
reabrir, operaciones, comparar.

Alternativas descartadas:

- **Corregir F-45 dentro del 001**: la constitución reserva ese protocolo a las Críticas; F-45 es
  Alta por el modificador «solo simulación» y va a un spec propio.
- **Mantener `admin/backtests` y añadir `backtests`**: dos rutas para lo mismo; la app es el único
  consumidor.
- **Cola de ejecución**: siete segundos de CPU por backtest grande caben en el interceptor de
  ochenta; el cupo por usuario acota el resto. Si se nota, spec de seguimiento.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/exchange-core/src/adapters/dry-run.ts` | Órdenes condicionales en reposo; disparo por marca; sentido por `intent` o por marca; estado con `triggerDir` opcional | `exchange-core.spec.ts` (bloque nuevo) |
| `packages/backtest/src/engine.spec.ts` | Test: un bot con stop no cierra en el acto y sí al cruzar | el propio test |
| `apps/api/src/modules/backtests/backtests.controller.ts` | `@Controller('backtests')`, sin `RolesGuard`; `user.id` en todos los handlers | `backtests.service.spec.ts` |
| `apps/api/src/modules/backtests/backtests.service.ts` | `run/list/detail/fills/remove` acotados al usuario | `backtests.service.spec.ts` |
| `apps/app/src/app/core/services/backtests.service.ts` | Base `backtests`; `detail()` tipado | typecheck |
| `apps/app/src/app/features/backtest/backtest.page.{ts,html,scss}` | Movida desde `admin/`; reabrir, operaciones, comparar | build |
| `apps/app/src/app/app.routes.ts`, `account.page.ts`, `bot-detail.page.html` | Ruta `/backtest` con `authGuard`; enlaces para todos | build |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama, línea base | Rojos conocidos anotados |
| 1 | F-45: test que falla → corrección → suite igual que la línea base + test nuevo del backtest | CA-1, CA-2, CA-3 |
| 2 | API para todos, acotada al usuario | CA-4 |
| 3 | App: ruta, reabrir, operaciones, comparar | CA-6; CA-5 a mano |
| 4 | Cierre: F-45 anotado en el 001, índice, memoria | Estado `hecho` cuando CA-5 esté comprobado |

## Verificación

```bash
pnpm --filter @crypton/exchange-core test   # tres rojos deliberados del 001 y ninguno nuevo
pnpm test:backtest
pnpm --filter worker test                    # dos rojos deliberados del 001
pnpm build:packages && pnpm --filter api test && pnpm --filter api lint
pnpm --filter app build && pnpm --filter app lint
```

Desde Git Bash. A mano: con una cuenta sin rol ADMIN, lanzar un backtest sobre un bot simulado con
`stopLossPct`, comprobar que las operaciones no muestran un cierre en el primer tick tras cada
entrada, guardar, salir, reabrir desde la lista y comparar con otra ejecución.
