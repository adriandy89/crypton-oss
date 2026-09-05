# 005 — Gráfico avanzado

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/005-grafico-avanzado` · Base: `498c2b1` (punta de `spec/003-cartera-agregada`, que incluye el 002; aprobado por el usuario el 2026-09-05)

## Objetivo

Que el gráfico de un bot conteste, sin salir de él, las tres preguntas que hoy obligan a cambiar
de pantalla: **cuándo** empezó a doler este movimiento, **qué hizo el bot** en cada tramo, y
**qué puedo hacer ahora**. Y que lo haga sin degradar lo que ya funciona: el motor gráfico está
afinado y su gesto de eje depende de la estructura interna de la librería.

Estará conseguido cuando en un gráfico con bot cargado se vean los sucesos del bot sobre el eje de
tiempo, el precio medio como serie y no como línea fija, el resultado acumulado bajo el precio con
la misma escala temporal, y las acciones del bot en una hoja que no abandona el gráfico; y cuando
el gráfico sin bot se pinte exactamente igual que hoy.

## Contexto

Seguimiento **005** propuesto por `specs/002-app-analitica/findings.md`. El 002 dejó el gráfico con
la jerarquía de rótulos del eje, la barra de liquidación y la franja de veredicto de mercado
(`GET /market-data/features`). Quedan las cuatro propuestas del bloque C de su catálogo que
necesitan más que una capa de líneas:

- **C4** — marcar los sucesos del bot (recentrado de la rejilla, guarda disparada, margen aportado)
  sobre el eje de tiempo: son los instantes que explican por qué la escalera de hoy no se parece a
  la de ayer.
- **C6** — el precio medio como serie temporal (`snapshots.average_entry`), no como línea
  horizontal: en una martingala lo interesante es cómo se ha movido mientras se llenaban niveles.
- **C3** — actuar sobre el bot sin salir del gráfico: hoy las dos acciones del gráfico navegan fuera
  (`chart.page.html`, franja del bot), justo cuando el precio se acerca a la liquidación, que es el
  momento para el que existe la capa de liquidación.
- **C5** — un panel de resultado acumulado bajo el precio, con el bucketeo del servidor del 002
  casado al intervalo del gráfico. Es la única propuesta que toca `price-chart.component.ts` más
  allá de una línea, y por eso va la última.

## Alcance

- `apps/app/src/app/shared/chart/bot-overlay.ts`: `buildEventMarkers(events, …)` por la misma
  tubería que `buildFillMarkers`; una capa más en la leyenda-interruptor.
- `apps/app/src/app/shared/chart/price-chart.component.ts`: **dos ampliaciones acotadas**: una
  serie de línea adicional en el panel 0 (`averageSeries`) y un tercer panel opcional de área
  (`pnlSeries`) con su reparto de alturas. Nada más del motor se toca: ni el gesto del eje, ni la
  paginación, ni la cruceta.
- `apps/app/src/app/features/bots/`: extraer la hoja de comandos (`openCommands`/`runCommand`,
  con `DESTRUCTIVE_COMMANDS` y sus confirmaciones) y la hoja de margen a componentes compartidos
  en `shared/ui`, y que `bot-detail` y `chart.page` usen los mismos.
- `apps/app/src/app/features/markets/chart.page.{ts,html,scss}`: las capas nuevas, el panel de
  resultado y el acceso a la hoja de comandos desde la franja del bot.
- `apps/api`: **nada nuevo**. El rango de `/snapshots` del 002 ya sirve `average_entry` y `equity`
  por cubo; los eventos ya se sirven.

## Fuera de alcance

Indicadores técnicos genéricos (medias, RSI, MACD: no contestan ninguna pregunta del operador de un
bot y convertirían la pantalla en un terminal), herramientas de dibujo, profundidad de libro y
funding (no entran en el sistema por ningún adaptador), el backtest, cambiar la semántica o los
valores por defecto de ningún comando.

## Requisitos

- **R-1** Línea base registrada (build, tests por paquete con los rojos conocidos del 001, lint).
- **R-2 Sucesos.** Solo severidad `WARN` o superior más `GRID_REANCHORED`, `SAFETY_ADDED`,
  `MARGIN_ADJUSTED` y `CONFIG_RELOADED`; agrupados por vela como las ejecuciones (un market maker
  llenaría el gráfico); con rótulo de `eventLabel()`; capa apagable; forma distinta de las
  ejecuciones (círculo frente a flecha) para que no se confundan.
- **R-3 Precio medio como serie.** Sale de `average_entry` de la serie del bot en el rango del
  gráfico, con los huecos rotos (un bot parado no escribe). La línea horizontal `MEDIO` actual se
  conserva cuando no hay serie —bot recién arrancado— y desaparece cuando la hay: nunca las dos.
- **R-4 Acciones desde el gráfico.** La hoja de comandos es **el mismo componente** que la del
  detalle, con las mismas confirmaciones para los destructivos (`DESTRUCTIVE_COMMANDS`): extraerlo
  es lo que impide que se olviden. Tras un comando, el gráfico recarga el bot por el mismo camino
  agrupado que ya usa (`BOT_COALESCE_MS`).
- **R-5 Panel de resultado.** Área bajo el precio, con el cero visible, alimentada por el rango del
  servidor del 002 con `points` casado al número de velas visibles; comparte eje de tiempo con el
  precio y **no** tiene eje de precio propio interactivo. Solo con bot cargado; sin bot, el gráfico
  es idéntico al de hoy (mismos paneles, misma altura).
- **R-6** `price-chart` sigue siendo el único fichero que importa `lightweight-charts`, y los
  cuatro consumidores actuales (gráfico, backtest ×3) compilan y se comportan igual: ningún input
  existente cambia de tipo ni de valor por defecto.
- **R-7** Todo lo que se pinta lleva su rótulo honesto: el panel de resultado se llama
  «resultado acumulado», y con `descartados > 0` o huecos lo dice.

## Criterios de aceptación

- **CA-1** `buildEventMarkers` tiene test junto a los de `bot-overlay` (si no existen, se crean en
  `packages/shared` siguiendo el precedente de `candle-paging`): agrupación por vela, filtro por
  severidad y tipo, rótulo traducido.
- **CA-2** Con un bot de doce niveles y cien eventos, el gráfico pinta como mucho un marcador de
  suceso por vela y lado, y la capa se apaga desde la leyenda.
- **CA-3** El gráfico **sin** bot es idéntico al actual: misma altura de paneles, mismo número de
  series (se comprueba con el inspector: dos series con volumen, una sin).
- **CA-4** Un `PANIC` lanzado desde el gráfico pide la misma confirmación, con el mismo texto, que
  desde el detalle; un `REPAIR` no pide ninguna. Se comprueba a mano con un bot simulado.
- **CA-5** El panel de resultado y el precio comparten el eje de tiempo: al arrastrar uno se
  desplaza el otro (es lo que da la librería con paneles; se verifica que no se ha roto).
- **CA-6** `pnpm --filter app build` dentro de presupuesto; `chart.page.scss` y
  `bot-detail.page.scss` no crecen (el CSS nuevo va a `global.scss`); lint limpio.

## Riesgos

- **`price-chart.component.ts`.** `rebuild()`, `applyScale()` y `teardown()` asumen una serie
  principal y un panel de volumen opcional; el tercer panel toca `rebuild()` y el reparto de
  alturas. Se hace al final, detrás de un input nuevo con valor por defecto «apagado», y con la
  regla de que **sin ese input el código que se ejecuta es exactamente el de hoy**.
- **Acciones destructivas desde una pantalla nueva.** El riesgo es de diseño, no técnico: replicar
  las confirmaciones a mano las desalinearía tarde o temprano. La extracción a un componente
  compartido es el requisito, no una mejora.
- **Ruido de marcadores.** Sin filtro por severidad y sin agrupación, un market maker convierte el
  gráfico en una nube. R-2 es lo que lo impide, y CA-2 lo comprueba.
- **La franja del bot en apaisado** esconde su propia cabecera: el acceso a la hoja tiene que caber
  también ahí.

## Decisiones

Las dos preguntas abiertas se cerraron el 2026-09-05 con la aprobación general del usuario, con
las propuestas del borrador:

1. **Panel de resultado (C5)**: entra, en la última fase y detrás de un ajuste apagado por defecto
   («Resultado bajo el precio», en la hoja de ajustes del gráfico). Sin él, `price-chart` ejecuta
   exactamente el código de hoy.
2. **Sucesos**: además de `WARN` y superiores se pintan cuatro tipos informativos —recentrado de la
   retícula, orden de seguridad añadida, margen ajustado y configuración recargada—, porque son los
   instantes que explican por qué la escalera de hoy no se parece a la de ayer. La lista vive en
   `@crypton/shared` (`SUCESOS_INFORMATIVOS`) con su test.

## Referencias oficiales

Ninguna. Referencias internas: `price-chart.component.ts` (paneles: `addSeries(…, paneIndex)`,
`panes()[n].setHeight`), `bot-overlay.ts` (`buildFillMarkers`, `bucketOf`), `bot-detail.page.ts`
(`openCommands`, `runCommand`, `DESTRUCTIVE_COMMANDS`), `bot-series.service.ts` del 002 (rango).
