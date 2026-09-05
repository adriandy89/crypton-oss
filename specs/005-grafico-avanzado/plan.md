# 005 — Plan

## Enfoque

De fuera hacia dentro: primero lo que no toca el motor gráfico (sucesos como marcadores, hojas
compartidas), después la serie de precio medio (una serie más en un panel que ya existe), y al final
el tercer panel, detrás de un input apagado por defecto. Cada fase deja la app en un estado
entregable, y si la última se descarta —pregunta abierta 1— las tres anteriores valen solas.

La regla que lo gobierna: **sin bot cargado, `price-chart` ejecuta exactamente el código de hoy.**
Los inputs nuevos tienen valor por defecto vacío o apagado, y las cuatro instancias actuales no los
pasan.

Alternativas descartadas:

- **Indicadores genéricos** (medias, RSI): no contestan ninguna pregunta del operador de un bot y
  convierten la pantalla en un terminal; el veredicto de mercado del 002 ya da la lectura que hace
  falta.
- **Duplicar la hoja de comandos en el gráfico**: dos copias de las confirmaciones de los comandos
  destructivos se desalinean con el primer cambio.
- **Pintar el resultado en el mismo panel que el precio**: dos escalas en un eje es el error de
  gráfico número uno; la librería tiene paneles precisamente para esto.
- **Meter los sucesos como `price lines`**: un suceso ocurre en un instante, no en un precio; es un
  marcador de tiempo, no una línea horizontal.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `apps/app/src/app/shared/chart/bot-overlay.ts` | `buildEventMarkers(events, {bucketMs, barsMs})`; `OverlayMarker` gana `shape: 'arrow' \| 'circle'` con valor por defecto | la lógica pura de agrupación y filtro, en `packages/shared` si hace falta runner (precedente `candle-paging`) |
| `apps/app/src/app/shared/ui/ui-bot-commands.component.ts` | **Nuevo.** La hoja de comandos con `DESTRUCTIVE_COMMANDS` y sus confirmaciones, extraída de `bot-detail.page.ts` | manual (CA-4) |
| `apps/app/src/app/shared/ui/ui-margin-sheet.component.ts` | **Nuevo.** La hoja de margen, extraída | manual |
| `apps/app/src/app/features/bots/bot-detail.page.{ts,html}` | Usa los dos componentes; no cambia de conducta | manual |
| `apps/app/src/app/shared/chart/price-chart.component.ts` | `averageSeries: input<SeriePunto[]>([])` en el panel 0; `pnlSeries: input<CuboSerie[]>([])` con tercer panel; sin cambiar ningún input existente | CA-3 (idéntico sin bot) |
| `apps/app/src/app/features/markets/chart.page.{ts,html}` | Capa «sucesos», serie de precio medio, panel de resultado, hoja de comandos desde la franja | manual |
| `apps/app/src/global.scss` | Estilos nuevos de la leyenda y del panel, por el presupuesto de 6 kB | build |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Aprobación, rama, línea base | Preguntas abiertas contestadas |
| 1 | Sucesos como marcadores + capa en la leyenda | CA-1, CA-2 |
| 2 | Hojas de comandos y margen extraídas; el detalle las usa; el gráfico las abre | CA-4 |
| 3 | Precio medio como serie (panel 0) con huecos rotos | Manual sobre una martingala simulada |
| 4 | Tercer panel de resultado, detrás de input apagado | CA-3, CA-5 |
| 5 | Cierre: índice, memoria | Estado `hecho` |

## Verificación

```bash
pnpm --filter @crypton/shared test      # si la agrupación de sucesos va a shared
pnpm --filter app build                 # presupuestos 2 MB / 6 kB
pnpm --filter app lint
```

A mano, con un bot simulado de doce niveles y recorrido: abrir su gráfico, comprobar que los sucesos
aparecen agrupados y apagables, que el precio medio se mueve al llenarse niveles y se rompe donde el
bot estuvo parado, que el panel de resultado arrastra con el precio, y que un `PANIC` desde el
gráfico pide exactamente la misma confirmación que desde el detalle. Después abrir un gráfico **sin**
bot y comprobar con el inspector que el número de series y la altura de los paneles son los de hoy.
