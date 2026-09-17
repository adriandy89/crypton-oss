# 061 — Plan

## Enfoque

Cuatro fases pequeñas y verificables por separado, en este orden: primero la matemática (donde hay
tests), luego la carga (que además arregla un defecto), luego los indicadores y por último el
recuerdo de la hoja.

- **La matemática no se escribe: se envuelve.** `bollinger`, `sma`, `ema`, `rsi` y `atrSerie` ya
  existen en `packages/strategy-core/src/canal/estadistica.ts`, probadas con cifras a mano, y son
  las que usa el motor del canal para decidir. El módulo nuevo solo elige, convierte `NaN` en hueco
  y pone nombres.
- **Vive en `strategy-core` y no en la app** porque la app no tiene un solo test
  (`apps/app/package.json:12`), y no en `shared` porque la estadística está en `strategy-core` y
  `shared` no puede depender de él. Precedentes de sacar la decisión de la vista:
  `packages/shared/src/candle-paging.ts` y `lineasDelCanal` de `ia-canal-vistas.ts`.
- **Alternativas descartadas.** Calcular en el componente (sin test, y la app no tiene runner);
  exportar la estadística cruda desde el índice del paquete (colisiona con `./indicadores`, como
  avisa `index.ts:61-62`); parámetros configurables (más mandos, más estado y más que explicar, para
  algo que casi nadie cambia); recordar también el intervalo (viaja en la URL y tiene consecuencias
  de caudal).

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/strategy-core/src/indicadores-vista.ts` | **Nuevo**: catálogo y cálculo de las líneas | `indicadores-vista.spec.ts` |
| `packages/strategy-core/src/index.ts` | Exporta el catálogo, la función y sus tipos | el typecheck de la app y del worker |
| `apps/app/src/app/shared/chart/price-chart.component.ts` | Entrada `cargando`, velo, series de indicador y panel propio; orden de paneles | `pnpm --filter app build` y el guion a mano |
| `apps/app/src/app/shared/chart/chart-theme.ts` | Paleta de los indicadores, `Record` completo | typecheck |
| `apps/app/src/app/features/markets/chart.page.ts` | `cargandoVelas`, selección de indicadores memorizada y cableado de preferencias | guion a mano |
| `apps/app/src/app/features/markets/chart.page.html` | Sección «Indicadores» en la hoja | guion a mano |
| `apps/app/src/app/features/markets/chart-prefs.service.ts` | **Nuevo**: lo que se recuerda | guion a mano |
| `apps/app/src/global.scss` | Estilos de la sección nueva, colgados de `ion-modal.opts` | presupuesto del build |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama desde `main`, y la verificación completa que ya quedó en verde al cerrar el 060 | Anotada |
| 1 | `indicadores-vista.ts` con su test, y el índice del paquete | `pnpm test:strategies`, worker, backtest y typecheck de la app en verde |
| 2 | Carga visible: entrada `cargando`, velo y esqueleto con velas vacías; `cargandoVelas` en la página | El guion de carga de CA-4 |
| 3 | Indicadores: series de precio, panel propio con su orden, colores y la sección de la hoja | El guion de indicadores de CA-4 |
| 4 | `chart-prefs.service.ts` y el cableado de la hoja | El guion de recuerdo de CA-4 |
| 5 | Cierre: verificación completa, índice de specs, memoria | Estado `hecho` |

## Verificación

```bash
pnpm build:packages
pnpm test:strategies                 # el módulo nuevo
pnpm --filter worker test            # dependiente de strategy-core
pnpm test:backtest                   # dependiente de strategy-core
pnpm --filter app lint
pnpm --filter app build              # presupuestos: 2 MB inicial, 6 kB por hoja de componente
pnpm lint && pnpm check:env          # al cerrar
```

El typecheck de la app va dentro de su build. Después, el guion a mano de CA-4 y CA-5 sobre un bot
simulado del canal con IA, con la infraestructura levantada.
