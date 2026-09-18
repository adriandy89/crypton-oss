# 061 — El gráfico avisa de que está cargando, y deja encender indicadores

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/061-grafico-carga-e-indicadores` (desde `main`,
`651ced6`)

## Objetivo

Que la pantalla del gráfico diga siempre si está esperando datos, y que quien mira un bot pueda
encender sobre el precio los indicadores que necesita para juzgar lo que hace, sin que la elección
se pierda al salir.

Estará conseguido cuando: al entrar salga el esqueleto y no un lienzo vacío; al cambiar de intervalo
lo anterior se atenúe con un indicador de carga encima, en vez de quedarse enseñando las velas del
intervalo anterior; los cinco indicadores se enciendan y se apaguen desde la hoja de ajustes; y al
volver a la pantalla siga todo como se dejó.

## Contexto

- **La petición.** El usuario la hizo el 2026-09-17, después de mergear la cadena 057-060: «pudieras
  poner un loading mientras se esperan los datos de las graficas para que salgan? Ademas se pudiera
  poner en las opciones algunos indicadores como las bandas de bollinger? para poder agregar o
  quitarlos, con guardado en localstorage de las selecciones».
- **Lo de la carga es además un defecto.** `changeInterval()` (`chart.page.ts:1331-1343`) vacía las
  señales para no enseñar «velas de la resolución vieja bajo la etiqueta de la nueva», pero
  `applyCandles` sale de vacío sin tocar la serie (`price-chart.component.ts:750-756`): el lienzo
  conserva justo lo que ese comentario dice evitar, y sin ningún aviso. `loading`
  (`chart.page.ts:234`) es de un solo disparo y solo cubre las pestañas de abajo, y el esqueleto del
  motor (`price-chart.component.ts:100-107`) depende de `ready()`, que solo dice si el motor está
  montado.
- **Nada de la hoja se recuerda** (`chart.page.ts:226-247,267`).
- **Se revisa una decisión del 005.** El spec 005 dejó fuera los indicadores genéricos
  (`005-grafico-avanzado/spec.md:54`): «no contestan ninguna pregunta del operador de un bot y
  convertirían la pantalla en un terminal». Sigue siendo cierto para un terminal de trading, pero
  desde el 058 el motor del canal **decide** sobre estructura de precio —rango, bandas,
  sobrecompra—, y el dueño de un bot que opera a 25x quiere ver con sus ojos lo mismo que mira el
  motor. La franja de veredicto del 002 (ATR diario, rango de 30 d y eficiencia,
  `chart.page.ts:271-313`) sigue donde está: es la lectura del mercado en conjunto, no la del tramo
  que se está mirando.

## Alcance

| Área | Qué |
|---|---|
| `packages/strategy-core` | `indicadores-vista.ts`: catálogo de los cinco indicadores y sus líneas, con test; una línea más en el índice del paquete |
| `apps/app` · gráfico | Velo de carga sobre el lienzo, series de los indicadores de precio y panel propio para el de abajo |
| `apps/app` · hoja de ajustes | Sección «Indicadores» con cinco interruptores |
| `apps/app` · preferencias | `chart-prefs.service.ts`: lo que se recuerda del gráfico, en el dispositivo |

Los cinco indicadores, con parámetros fijos: **Bollinger (20, 2σ)**, **media 50**, **media
exponencial 20**, **RSI (14)** y **ATR (14)**. Los dos últimos ocupan panel propio y son
excluyentes entre sí.

## Fuera de alcance

- Parámetros configurables, dibujo a mano, MACD, estocástico, VWAP: lo que no está en la lista, no
  se hace.
- Los tres gráficos del backtest, que comparten componente: las entradas nuevas nacen con valor por
  defecto y allí no cambia nada.
- Guardar la preferencia en el servidor: es una preferencia de lectura, no un dato de la cuenta
  (mismo criterio que `favourites.service.ts:8-22`).
- El intervalo: se queda como está, viajando en la URL.
- Cambiar la franja de veredicto de mercado, las capas del bot o cualquier valor por defecto.

## Requisitos

- **R-1 Carga visible.** Sin velas —primera carga, cambio de par o de red— el lienzo enseña el
  esqueleto. Con velas ya pintadas y una petición en vuelo, se atenúan y sale un indicador de carga
  con `aria-live="polite"`. En ningún momento se ven velas de un intervalo bajo la etiqueta de otro.
- **R-2 La matemática no se duplica.** Los cinco indicadores salen de
  `packages/strategy-core/src/canal/estadistica.ts`, que es la que usa el motor del canal, envuelta
  en un módulo con test. La app no calcula nada.
- **R-3 Solo velas cerradas.** El indicador se calcula con las velas cerradas; la vela viva no entra,
  para que no baile con cada tick ni obligue a recalcular.
- **R-4 Catálogo cerrado.** El catálogo es un `Record` completo sobre la unión de claves: añadir un
  indicador sin etiqueta, sin explicación o sin color no compila.
- **R-5 Un solo panel de abajo.** RSI y ATR se excluyen. El orden de paneles es siempre precio,
  volumen, resultado, indicador, y al apagar el indicador su panel desaparece.
- **R-6 Se recuerda la hoja.** Indicadores, tipo de gráfico, volumen, resultado y capas del bot se
  guardan en el dispositivo con `@capacitor/preferences` (en web, `localStorage`), con el patrón que
  ya usan `favourites.service.ts` y `network.service.ts`. Una preferencia ilegible o de otra versión
  cae en los valores de fábrica sin romper la pantalla.
- **R-7 Sin regresión en el resto.** Los tres gráficos del backtest y el gráfico sin bot se pintan
  igual que hoy, y `price-chart` sigue siendo el único fichero que importa `lightweight-charts`.

## Criterios de aceptación

- **CA-1** `indicadores-vista.spec.ts` en verde, con cifras calculadas a mano, longitud igual a la de
  la entrada y `null` donde no hay datos suficientes.
- **CA-2** Tras tocar `strategy-core`: `pnpm test:strategies`, `pnpm --filter worker test`,
  `pnpm test:backtest` y el typecheck de la app, en verde.
- **CA-3** `pnpm --filter app build` dentro de presupuesto (2 MB inicial, 6 kB por hoja de
  componente) y `pnpm --filter app lint` limpio.
- **CA-4** *(a mano)* En el gráfico de **cualquier par**, con bot o sin él: al entrar sale el esqueleto; al
  cambiar de intervalo se atenúa lo anterior con el indicador de carga y no se ven velas viejas; los
  cinco indicadores se encienden y se apagan; RSI y ATR se excluyen; al salir y volver sigue todo
  igual; con el almacén borrado, todo vuelve a los valores de fábrica.
- **CA-5** *(a mano)* Los tres gráficos del backtest siguen pintando igual. Un backtest se lanza sin
  bot, así que esto no necesita ninguno.
- **CA-6** *(a mano, con un bot vivo)* Con el panel de resultado encendido y un indicador de panel
  propio, el orden de paneles es precio, volumen, resultado, indicador, y el resultado no se pinta
  dentro del panel del indicador. Es lo único que necesita un bot, y solo se tocan interruptores de
  dibujo: no manda ninguna orden.

## Riesgos

- **El índice de panel del resultado es posicional** (`hasVolume ? 2 : 1`): con un panel de
  indicador en medio, el resultado se pintaría dentro de él. Se arregla contando paneles y
  normalizando el orden.
- **Presupuesto de estilos**: `chart.page.scss` está a unos 640 bytes de su aviso de 6 kB. El CSS
  nuevo del velo va en el componente y el de la hoja, a `global.scss`.
- **Coste de cálculo** sobre series largas: se memoriza por la identidad del array de velas y no
  entra la vela viva.
- **La app no tiene tests**: por eso la lógica pura vive en un paquete y la comprobación de la
  pantalla es el guion a mano de CA-4.

## Referencias oficiales

Ninguna regla de venue. La API de paneles usada (`addSeries(def, opts, paneIndex)`, `addPane`,
`panes()`, `IPaneApi.moveTo`, `removePane`) es la de `lightweight-charts` 5.2.1, tal y como la
declaran sus tipos en `node_modules/lightweight-charts/dist/typings.d.ts`.
