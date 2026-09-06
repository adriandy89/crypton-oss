# 025 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, dos commits (servidor y app). Ninguna
orden cambia: es información que ya existía y no se enseñaba.

Decisiones de diseño tomadas aquí:

- **La suma la hace el servidor, con `shared`.** El capital actual, el valor de la posición y la
  rentabilidad sobre el margen se calculan en `packages/shared/src/capital.ts` con `Decimal` y test, y la
  API los sirve en `BotSummary`; la app solo pinta. Calcularlo en la app habría roto la regla de la casa
  («la app no suma dinero») y habría dejado lista y detalle con dos cifras distintas.
- **Capital actual = patrimonio; resultado = PnL.** El vocabulario de la cartera (spec 002, R-7) no cambia:
  la curva del detalle sigue siendo «resultado acumulado». El bloque nuevo dice «capital» solo para la cifra
  que lo es.
- **El inicial sale de la revisión 1**, no de un campo nuevo en `bots`: ya está guardado, y se enseña solo
  cuando difiere del asignado para no repetir la misma cifra dos veces.
- **Valor de la posición al precio más fresco**, el mismo que ya usa la distancia a liquidación (tickers en
  caché; si no, el snapshot). Sin precio no se inventa: `null` y la app pinta «—».
- **Sin moneda junto a las cifras**: la app no la pinta en ninguna pantalla y `BotSummary` no trae la
  quote; se mantiene la convención (cifras sin unidad, coma decimal).

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `shared/src/capital.ts` (nuevo), `bot.ts`, `index.ts` | `capitalActual`, `valorDePosicion`, `retornoSobreMargen`; `BotSummary.currentCapital/positionValue/marginUsed` | `capital.spec.ts` (nuevo, 6) | `08d9f50` |
| `api/src/modules/bots/bots.service.ts` | `metricsOf` calcula los tres; `detail` añade `initialInvestment` (revisión 1) | `bots-summary.spec.ts` (nuevo, 2) | `08d9f50` |
| `app/.../shared/ui/ui-stat.component.ts` | `hint`: línea secundaria opcional | — | `6752a42` |
| `app/.../core/models/index.ts` | `BotDetail.initialInvestment` | — | `6752a42` |
| `app/.../features/bots/bots-list.page.{ts,scss}` | «Capital actual» con «de X asignados»; línea de datos (posición ≈ valor, margen, activo) | typecheck, lint, `ng build` | `6752a42` |
| `app/.../features/bots/bot-detail.page.{html,ts}`, `global.scss` | bloque «Capital»; precio de marca y apalancamiento en la ficha | typecheck, lint, `ng build` | `6752a42` |

## Verificación

```bash
pnpm --filter shared test && pnpm --filter api test -- bots-summary
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit && pnpm --filter app lint && pnpm --filter app build
pnpm build:packages && pnpm test && pnpm lint && pnpm check:env
```
