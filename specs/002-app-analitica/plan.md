# 002 — Plan

## Enfoque

Primero mirar, luego dibujar, luego tocar. La revisión produce `findings.md` y un catálogo; las
maquetas se aprueban antes de escribir una línea de pantalla; y la implementación empieza por lo
que ya tiene dato servido y sin pedir nada al backend.

La decisión que ordena todo lo demás es **dónde vive la aritmética**. Va a
`packages/shared/src/series.ts`, no a la app, siguiendo un precedente ya escrito y razonado en la
casa: `packages/shared/src/candle-paging.ts:3-17` explica que la lógica pura de la app vive en
`shared` porque «`apps/app` no tiene ni un solo test […] y montar TestBed para esto sería
desproporcionado. Sacando la DECISIÓN de la vista, lo único que queda sin cubrir es el cableado».
Tiene su `candle-paging.spec.ts` al lado. Es el mismo problema y se resuelve igual.

La segunda decisión es **cuántos motores gráficos**. Dos y medio, con frontera mecánica:

| Motor | Qué es | Cuándo |
|---|---|---|
| `app-price-chart` | el que ya existe, intacto | eje de tiempo manipulable, cruceta, líneas de precio, o más de ~600 puntos |
| `ui-spark` (nuevo) | SVG en línea, sin dependencias | serie de solo lectura dentro de una tarjeta, ≤400 puntos |
| `ui-meter` (nuevo) | una barra CSS | escalares sobre un techo y repartos de 2-4 partes |

El motivo no es estético: cada instancia de `lightweight-charts` monta 7 lienzos (11 con el panel
de volumen) y la librería pide un `ResizeObserver` por lienzo. Veinte miniseries en la lista de
bots serían ~140 lienzos en un WebView de Android, además de meter los ~190 kB del motor en la ruta
caliente de la pestaña de aterrizaje. La propia librería lleva un `releaseCanvas()` cuyo comentario
cita el límite de memoria de lienzos de iOS Safari: el problema es conocido por sus autores.

Alternativas descartadas:

- **Una librería de gráficos más** (chart.js, apexcharts): 20-40 kB y un sistema de temas propio
  que no leería los tokens Aurora y casi seguro computaría colores; `color-mix()` no está
  garantizado en el WebView que la app soporta. Sería la segunda paleta que `chart-theme.ts`
  documenta haber evitado a propósito.
- **Instanciar `price-chart` también para lo pequeño**: medido arriba, no cabe.
- **Añadir jest a `apps/app`**: exige `jest-preset-angular` o equivalente, TestBed y zone.js —una
  cadena de herramientas entera— para cubrir lo que queda después de extraer las decisiones a
  funciones puras, que es casi nada. Se sigue el precedente de `candle-paging.ts` en vez de
  inventar uno. Si algún día un componente contiene una decisión que no se puede extraer, será un
  spec propio.
- **Formalizar una entrada `series` en `price-chart`**: obligaría a que `candles` dejara de ser
  `input.required`, que hoy es una guarda real. En su lugar, el disfraz de vela que está duplicado
  en `backtest.page.ts:143-163` se convierte en un tipo de transporte (`CuboSerie`) más un
  adaptador de una línea, y el motor no se toca.
- **Sumar la curva de cartera en el cliente**: no es que sea caro, es que es imposible.
  `/snapshots` no acepta rango ni `offset`, así que el techo son 500 filas ≈ 8 h 20 min, y sumar
  series de bots vivos perdería a los borrados. Va como spec de seguimiento con su tabla.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/shared/src/series.ts` | **Nuevo.** `vistaDeSerie`, `muestreoPorExtremos`, `puntosAPath`, `alineaYSuma`. Única frontera `string`→`number` del rasgo | `packages/shared/src/series.spec.ts` (nuevo) |
| `packages/shared/src/index.ts` | Exporta `series.ts` | el build de los consumidores |
| `packages/backtest/src/metrics.ts` | Su muestreo pasa a llamar al de `shared` | sus specs actuales, **sin modificar** |
| `apps/app/src/app/shared/ui/ui-spark.component.ts` | **Nuevo.** Motor SVG | `puntosAPath` en `series.spec.ts` |
| `apps/app/src/app/shared/ui/ui-meter.component.ts` | **Nuevo.** Barra y reparto | — (sin decisión propia) |
| `apps/app/src/app/shared/ui/index.ts` | Exporta los dos | typecheck de la app |
| `apps/app/src/app/shared/chart/bot-series.ts` | **Nuevo.** `BotSnapshot[]`/`BotCycle[]` → serie | `series.spec.ts` cubre la aritmética |
| `apps/app/src/app/shared/chart/series-to-candles.ts` | **Nuevo.** Puente con `price-chart` | typecheck |
| `apps/app/.../features/bots/bot-detail.page.{ts,html,scss}` | Resumen rediseñado, curva, ciclos, comisiones, causa de parada | manual con bot simulado |
| `apps/app/.../features/portfolio/portfolio.page.{ts,scss}` | Capital frente a exposición, riesgo agregado, reparto | manual |
| `apps/app/.../features/bots/bots-list.page.ts` | Distancia a liquidación desde el servidor; orden | manual |
| `apps/app/.../features/bots/bot-create.page.html` | Formateo y acumulados en la revisión | manual |
| `apps/app/.../shared/chart/bot-overlay.ts` | Jerarquía de etiquetas del eje | manual sobre un bot con 12 niveles |
| `apps/app/.../core/{models,services}/index.ts`, `bots.service.ts` | `BotSummary` alineado; `cycles()` tipado | typecheck |
| `apps/api/src/modules/bots/bots.service.ts` | `metricsOf` rellena `liquidationDistancePct` y `totalInvestment` | `apps/api` unitarios |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, build, tests, lint | Verde o rojos conocidos anotados |
| 1 | Revisión U-1…U-10 → `findings.md` + catálogo | Todo ítem con veredicto y evidencia |
| 2 | Maquetas de las pantallas clave, en el lenguaje Aurora | Aprobadas por el usuario |
| 3 | Aritmética en `shared` con sus tests, y los dos componentes nuevos | `pnpm test` entero en verde |
| 4 | Arreglar lo que miente (U-1…U-5) | La distancia a liquidación da un solo número |
| 5 | Rediseño: detalle, cartera, lista, gráfico. Una pantalla, un commit | `pnpm --filter app build` dentro de presupuesto |
| 6 | Backend de apalancamiento: `spark` y rango en `/snapshots` | Con test; ninguna lista con N peticiones |
| 7 | Cierre: índice de specs, docs, memorias, specs de seguimiento | Estado `hecho` |

Las fases 3 y 4 pueden ir en paralelo con la 2: no comparten ficheros con las maquetas.

## Verificación

```bash
pnpm build:packages
pnpm --filter @crypton/shared test        # series.spec.ts
pnpm test                                  # shared cambió -> worker, backtest y api, por constitución
pnpm --filter app build                    # typecheck de la app y presupuestos (2 MB / 6 kB)
pnpm lint
```

Jest se ejecuta desde Git Bash, no desde PowerShell.

Lo que prueban los tests nuevos, y por qué cada uno:

- **El que justifica `muestreoPorExtremos`**: serie plana con una única punta profunda; la punta
  sobrevive con `max` = 8, 40, 200 y 1000. Un muestreo cada N la borra en casi todos los casos, y
  esa punta es justo el peor momento que el usuario ha abierto la pantalla para ver.
- `t` estrictamente creciente y sin repetidos: el motor gráfico **lanza** con tiempos repetidos
  (`price-chart.component.ts:692-696`).
- **El de dinero**: `['0.1','0.2']` da `delta === '0.3'` exacto. Una tubería de `number` devuelve
  `0.30000000000000004`. Se asertan cadenas, no números.
- `peorCaida` sobre pico-valle-pico es el recorrido de pico a valle, no `max − min`.
- `y` invertida en `puntosAPath`: el error de signo pinta la curva del revés y **nadie lo nota** en
  una miniserie de 16 px.
- Tras promover el muestreo, los specs de `packages/backtest` pasan **sin tocarlos**. Si no pasan,
  la versión de `shared` está mal.

No se aserta el atributo `d` literal de un `<path>`: es asertar píxeles, se rompe con cada retoque
y no atrapa nada.

A mano, con la infraestructura levantada y **un bot simulado**, nunca uno real: dejarlo operar
hasta tener snapshots y un ciclo cerrado, y comprobar que la curva, los ciclos y las comisiones
cuadran con `GET /bots/:id/{snapshots,cycles,fills}` leídos directamente. La comprobación que
cierra la fase 4 es que la distancia a liquidación dé **el mismo número** en cartera, lista,
detalle y gráfico; hoy no lo da.
