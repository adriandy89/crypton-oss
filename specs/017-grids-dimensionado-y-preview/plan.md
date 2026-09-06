# 017 — Plan

## Enfoque

Protocolo de `specs/README.md`: cada hallazgo con su test en rojo primero, diff mínimo y un commit por
corrección (los que comparten fichero van juntos y lo dicen en el mensaje). Cinco commits: GridMart
(F-82, F-89), Grid Classic (F-03, F-87, F-88), Neutral Grid (F-81), vista previa (F-14) y la API (F-90).

Decisiones de diseño tomadas aquí, documentadas en las fichas del 001:

- **F-81**: histéresis por línea memorizada en el scratch del ciclo **por precio** (sobrevive a un cambio de
  forma). La línea vive hasta que el precio la cruza; la cruzada queda sin orden medio escalón y vuelve con
  el lado que toque. `onFill` la marca cruzada en el acto: con `reusesOrderSlots` el motor recolocaría la
  misma compra encima de la que acaba de ejecutarse si el mark aún estuviera un pelo del lado bueno.
- **F-82**: bandera de estrategia (`rebuysOffLevelIndexes`) en vez de un espacio de índices nuevo para las
  recompras: no cambia el formato del `clientOrderId` (invariante 3 de `CLAUDE.md`).
- **F-03**: el precio de referencia BASE se fija en el **primer plan del ciclo** (`scratch.sizingRef`), no en
  la revisión de configuración: es lo que hace que un ciclo nuevo se dimensione con el precio de ese momento
  y que la vista previa (precio de creación) coincida salvo por la deriva hasta el arranque.
- **F-87**: recorte por notional proyectado **de la línea más cercana hacia fuera y sin huecos** (la primera
  que no cabe corta): la rejilla que se tiende es un tramo contiguo, como en las escaleras.
- **F-88**: todas las líneas son entrada en la vista previa (el precio puede subir por encima del rango y
  recorrerlo entero); el tipo y el lado de cada línea siguen diciendo su papel inicial.
- **F-14**: la liquidación «cruzada» real no se calcula (depende del saldo de toda la cuenta); se avisa de que
  la aislada es una cota. En la neutral, la liquidación enseñada es la del lado largo y la del corto va como
  aviso: la media de las dos mitades no era el precio de ninguna posición posible.
- **F-90**: **rechazar** (409 `RESHAPE_WITH_INVENTORY`) en vez de remapear: remapear exige decidir qué venta
  corresponde a cada compra tras mover las líneas, y rechazar es seguro y reversible (cerrar la posición o
  esperar al fin del ciclo). La comprobación va antes de pedir la confirmación WARM.

Alternativas descartadas: una banda muerta más pequeña en la neutral (misma cancelación, más tarde); un
espacio de índices propio para las recompras (rompe el `clientOrderId`); remapear `filledLevelIndexes`.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `strategy-core/src/types.ts`, `cycle-accounting.ts`, `strategies/gridmart.ts` | `rebuysOffLevelIndexes`; trozos que suman; resto al último escalón | `cycle-accounting.spec.ts`, `strategies.spec.ts` | `539d3c3` |
| `worker/src/engine/bot-store.ts`, `bot-runner.ts`, `backtest/src/engine.ts` | la bandera llega a la contabilidad y a la reparación desde el venue | worker 298, backtest 26 | `539d3c3` |
| `strategy-core/src/strategies/grid-classic.ts` | `scratch.sizingRef`; recorte proyectado; `isEntry: true` en el preview | `strategies.spec.ts` | `3433c39` |
| `strategy-core/src/strategies/neutral-grid.ts` | `lineSides` con histéresis; `onFill` | `strategies.spec.ts` | `bac95d6` |
| `strategy-core/src/common.ts`, `strategies/tdca.ts` (+ `marginMode` en las siete) | avisos de cruzado y lado corto; sin avisos repetidos | `strategies.spec.ts` | `4bb2353` |
| `shared/src/config-meta.ts`, cuatro estrategias, `api/.../bots.service.ts` | `FieldMeta.reshapes`; 409 con inventario | `bots-reshape.spec.ts` (nuevo) | `77cca8a` |
| `docs/*.md`, `apps/app/.../{common-options,neutral-grid.guide}.ts`, `field-labels.ts` | bloques de los ocho hallazgos fuera; números de las guías regenerados | `verificar-ejemplos`, `comprobar-enlaces`, `comprobar-parametros` | cierre |

## Verificación

```bash
pnpm --filter strategy-core test && pnpm build:packages
pnpm --filter worker test -- --forceExit && pnpm test:backtest && pnpm --filter api test
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm test && pnpm lint && pnpm check:env
grep -rn "F-81\|F-82\|F-89\|F-03\|F-87\|F-88\|F-90\|F-14" docs/
```
