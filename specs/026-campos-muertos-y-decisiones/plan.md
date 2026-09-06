# 026 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero (cuatro tests nuevos en `strategies.spec.ts`), diff
mínimo, un commit de código (los cambios comparten ficheros y responden a la misma decisión) y otro de
cierre. Criterio para cada decisión: el camino que no añade complejidad ni cambia la conducta de ningún bot
en marcha.

Decisiones de diseño tomadas aquí:

- **Retirar del formulario, no del JSON guardado.** Los campos desaparecen de `meta.fields`, de las
  interfaces y de `defaults()`; las configuraciones existentes conservan sus claves y `diffConfig` no las
  toma por cambio porque no cambian. Nada que recargar, nada que migrar.
- **GridMart oculta `takeProfitPct` y `tpMode` sin quitarlos del contrato de la escalera.**
  `validateLadderConfig` los espera, así que `defaults()` los sigue fijando y la app, que siembra el
  formulario con los `defaults()`, los manda igual. Cero código nuevo en la validación compartida.
- **`targetLeverage` fuera del contrato.** Sin consumidor en el motor ni en el backtest: doce líneas menos
  en las siete estrategias y un campo menos en `DesiredState`.
- **Valores de fábrica solo para bots nuevos.** `defaults()` se lee al crear; los bots existentes conservan
  su configuración. GridMart 1 min (como Martingala); MM V2 2 bps (la comisión maker típica, la que la
  propia guía pone de ejemplo). El aviso con 0 bps se conserva.
- **Avisar en vez de subir el mínimo.** Un mínimo nuevo de `takeProfitPct` haría fallar `validateMeta` al
  recargar la configuración de un bot existente por debajo de él; un WARN no rompe nada.
- **F-11: rotular, no rehacer.** La semántica actual es válida y hay bots con el umbral puesto; medir la
  caída desde el máximo exigiría guardar el pico de cada bot.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `shared/src/bot.ts` | `DesiredState` sin `targetLeverage` | `strategies.spec.ts` | `de7bd3d` |
| `strategy-core/src/strategies/grid-classic.ts` | sin `preloadInventory` (campo, interfaz, default, aviso) | `strategies.spec.ts` | `de7bd3d` |
| `strategy-core/src/strategies/gridmart.ts` | sin `fullCycleCooldownMinutes`; `takeProfitPct`/`tpMode` fuera del formulario; `cooldownMinutes: 1`; aviso del TP satélite | `strategies.spec.ts` | `de7bd3d` |
| `strategy-core/src/strategies/neutral-grid.ts` | sin `reanchorOnDrift`/`reanchorThresholdPct` ni su aviso | `strategies.spec.ts` | `de7bd3d` |
| `strategy-core/src/strategies/martingale.ts` | `TP_MINIMO_RENTABLE_PCT`, `avisoDeTpCorto`, WARN en `validateLadderConfig` | `strategies.spec.ts` | `de7bd3d` |
| `strategy-core/src/strategies/{market-maker,market-maker-v2,tdca}.ts` | sin `targetLeverage`; MM V2 `feeEstimateBps` 2 | `strategies.spec.ts` | `de7bd3d` |
| `api/src/modules/advisor/build.ts` | no propone los campos retirados | `pnpm --filter api test -- advisor` | `de7bd3d` |
| `app/.../field-labels.ts`, `*.guide.ts`, `account/risk.page.ts` | etiquetas y fichas fuera; «Pérdida acumulada que pausa el bot» | typecheck, lint, `ng build` | `de7bd3d` |
| `docs/` (7 guías), fichas y preguntas abiertas del 001 | sin los campos; kill-switch rotulado; TP corto avisado; F-11/F-12/F-54 decididos | `comprobar-parametros`, `verificar-ejemplos`, enlaces | cierre |

## Verificación

```bash
pnpm test:strategies && pnpm --filter worker test && pnpm test:backtest && pnpm --filter api test -- advisor
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit && pnpm --filter app lint && pnpm --filter app build
node scratchpad/comprobar-parametros.cjs && node scratchpad/verificar-ejemplos.cjs
pnpm build:packages && pnpm test && pnpm lint && pnpm check:env
```
