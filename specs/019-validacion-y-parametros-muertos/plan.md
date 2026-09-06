# 019 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, tres commits por capa (`shared` y
adaptadores; `strategy-core`; API). Lo que exige una decisión de producto no se toca y queda anotado en las
fichas del 001 (F-11 entero; parte de F-12).

Decisiones de diseño tomadas aquí:

- **F-13**: la validación genérica vive en `common.ts` (`validateMeta`) y se aplica en el **registro**
  (`getStrategy` devuelve la estrategia envuelta), el único sitio por el que la API, el worker y la app
  resuelven estrategias. Solo mira valores presentes, salvo los obligatorios sin valor por defecto; un error
  que la estrategia ya dé para el mismo campo no se repite. Los dos multiplicadores de GridMart se validan
  explícitamente porque tienen valor por defecto y su ausencia reventaba con un `DecimalError`. Se descartó
  poner el validador en cada `validate()` (siete sitios que olvidar) o en los DTO de la API (la app corre la
  misma validación en cliente).
- **F-93**: sin columna nueva en `markets`. `maintenanceMarginRateOf` deriva la tasa del apalancamiento
  máximo con la regla de Hyperliquid cuando la ficha no la trae (fichas leídas de la base, Aster); Lighter la
  publica y el adaptador la pasa. El simulador sigue con la tasa plana: su opción es por adaptador, no por
  mercado.
- **F-44**: se mantiene el 5 % (no hubo decisión en contra); lo que cambia es que las tres puertas
  (formulario, API, asistente) usan la misma función y la misma tasa, y dicen el tope exacto del mercado.
- **F-42**: `excludeBotId` opcional en vez de un método aparte: `create()` no lo pasa y sigue igual.
- **F-43**: `startOfDay` a `shared` con `now` inyectable para poder probarlo; el worker lo importa.
- **F-12**: `cooldownMinutes` y `maxNotionalCap` se implementan porque su semántica está definida por el
  formulario y por las estrategias que ya los respetaban; el resto (`preloadInventory`,
  `fullCycleCooldownMinutes`, `reanchorOnDrift`, `targetLeverage`) exige decidir semántica o retirada.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `shared/src/{market,liquidation,time,index}.ts`, `exchange-core/src/adapters/{hyperliquid,lighter}.ts`, `worker/.../bot-store.ts` | `maintenanceMarginRate`, `maintenanceMarginRateOf`, `maxLeverageWithinDistance`, `MIN_LIQUIDATION_DISTANCE_PCT`, `startOfDay` | `liquidation.spec.ts`, `time.spec.ts` | `9a4faa2` |
| `strategy-core/src/{common,registry}.ts`, `strategies/{grid-classic,neutral-grid,tdca,gridmart,martingale}.ts` | `validateMeta` + envoltura; tope por mercado; mmr en la vista previa y la cobertura; cooldown y tope común; TP del satélite; avisos | `strategies.spec.ts` | `8edbd8c` |
| `api/.../{risk.service,bots.service,advisor.service}.ts` | `excludeBotId`; regla del 5 % compartida; medianoche del usuario | `risk.spec.ts`, `bots-reshape.spec.ts` | `65de2b1` |
| `docs/*.md`, textos in-app | bloques fuera; conducta nueva; números de liquidación regenerados | verificador de ejemplos, enlaces, parámetros | cierre |

## Verificación

```bash
pnpm --filter shared test && pnpm --filter shared build && pnpm --filter strategy-core test
pnpm build:packages && pnpm --filter api test && pnpm test:adapters && pnpm --filter worker test -- --forceExit
pnpm test:backtest && pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm test && pnpm lint && pnpm check:env
grep -rn "F-13\|F-93\|F-42\|F-43\|F-44" docs/
```
