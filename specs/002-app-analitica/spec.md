# 002 — Analítica e interfaz de la app

Estado: `en curso` · Tipo: `revisión` · Rama: `spec/002-app-analitica` · Base: `8860625` (`main`, 2026-09-05)

## Objetivo

Que la app enseñe lo que ya sabe. Hoy persiste, sirve y tipa una serie temporal por bot que
ninguna pantalla dibuja, y las tres pantallas más miradas —cartera, lista de bots y detalle de
bot— son rejillas de números sin una sola serie. Este spec produce `findings.md` con lo que está
mal en la interfaz, un catálogo de propuestas priorizado, y corrige dentro de sí mismo la primera
tanda: la que no necesita persistir nada nuevo.

Estará conseguido cuando la distancia a liquidación —la métrica de riesgo número uno— dé el
**mismo número** en las cuatro pantallas que la muestran, y cuando el detalle de un bot conteste
«¿está ganando o solo está abierto?» sin salir de la pantalla.

## Contexto

Lo pide el usuario tras encargar una revisión de la interfaz y las gráficas. La exploración del 5
de septiembre de 2026 encontró tres cosas que cambian la naturaleza del spec:

1. **El trabajo caro ya está hecho y no llega a la pantalla.** `GET /bots/:id/snapshots` sirve
   equity, posición, precio medio, mark, PnL realizado y no realizado, margen usado, precio de
   liquidación y órdenes vivas, una fila por minuto. `GET /bots/:id/cycles` sirve los ciclos
   cerrados con su PnL y comisiones. Los dos métodos cliente están escritos
   (`bots.service.ts:283` y `:271`) y **ninguna página los llama**.
2. **La métrica de riesgo número uno está mal calculada.** `BotSummary.liquidationDistancePct`
   está declarada en el contrato compartido con el comentario «La métrica de riesgo nº 1» y la API
   no la rellena nunca. Por eso cada pantalla se inventa la suya, y dos de las tres la miden
   contra el precio de entrada en vez de contra el precio vivo.
3. **El motor gráfico es bueno y está casi sin usar.** `price-chart.component.ts` (1203 líneas)
   solo se instancia en el gráfico de mercado y en el backtest, que vive tras `adminGuard`.

Este spec no es cosmético: se abre por gráficas y se encuentra contabilidad de pantalla
equivocada.

**Relación con el spec 001.** El 001 dejó «la interfaz de la app» explícitamente fuera de alcance,
así que no hay solape. Del lado contrario, este spec no modifica ninguno de los ficheros que el
001 audita.

Decisiones del usuario que gobiernan este spec:

- Alcance: revisión **más** primera tanda implementada, la que no toca el backend.
- Prioridad: analítica del bot, cartera y gráfico de trading. El backtest queda para un spec
  posterior.
- Intervención autorizada en `apps/app`: **rediseño de las pantallas clave**, manteniendo rutas,
  servicios y contratos.

## Alcance

- `apps/app/src` entero: `features/{bots,portfolio,markets}`, `shared/{ui,chart}`,
  `core/{services,models,utils}`.
- `packages/shared/src/series.ts` y `market-features.ts`: ficheros **nuevos** —la aritmética de
  series con su `series.spec.ts` al lado, y la interfaz `MarketFeatures` promovida desde la API
  porque pasa a ser contrato—. De los ficheros que audita el 001 (`money`, `precision`,
  `liquidation`, `orders`, `bot`, `enums`) solo `bot.ts` cambia, y solo por adición: el campo
  opcional `spark` en `BotSummary`.
- `apps/api/src/modules/bots`: `metricsOf` (`bots.service.ts:643`) rellena los dos campos ya
  declarados en el contrato; `BotSeriesService` (**nuevo**, el primer SQL crudo de la API, solo
  lectura sobre `bot_snapshots`) da el rango temporal de `/snapshots` y la miniserie del listado.
- `apps/api/src/modules/market-data`: `GET /market-data/features`, que expone `buildFeatures` del
  advisor con sus mismas series. `advisor/market-features.ts` solo cambia para reexportar el tipo.
- `apps/app/src/app/shared/chart/price-chart.component.ts`: **una línea**, la que decide qué líneas
  llevan rótulo en el eje (`axisLabel`); el resto del motor gráfico no se toca.
- `packages/backtest/src/metrics.ts`: solo para que su muestreo pase a llamar a la versión
  promovida a `shared`, sin cambiar el comportamiento.

## Fuera de alcance

El backtest y su pantalla (spec propio), `strategy-core`, `exchange-core`, el worker,
`packages/db/prisma`, valores por defecto de estrategias, semántica de cualquier parámetro de
usuario, i18n, `apps/web`, el ranking, los planes, Telegram y la autenticación. Tampoco entra
ninguna persistencia nueva: la curva agregada de cartera necesita una tabla y un cron, y por eso
queda como spec de seguimiento.

## Requisitos

- **R-1** Línea base registrada antes de tocar nada: `pnpm build:packages`, `pnpm test` (sin e2e),
  `pnpm lint`, `pnpm check:env`.
- **R-2** Toda evidencia de `findings.md` lleva `fichero:línea`. Este spec no contradice a ningún
  venue, así que no hay citas de documentación oficial que aportar; las referencias normativas son
  los comentarios del propio repositorio.
- **R-3 Revisión de la interfaz.** Se dictamina, con evidencia, sobre:
  - U-1 Coherencia de la métrica de riesgo entre cartera, lista, detalle y gráfico.
  - U-2 Campos declarados en `packages/shared/src/bot.ts` que la API no rellena.
  - U-3 Deriva entre las tres definiciones de `BotSummary` (shared, API, app).
  - U-4 Formateo de cifras de dinero: dónde se pinta crudo y dónde pasa por `format.ts`.
  - U-5 Aritmética de dinero en la app frente al invariante 1 (`Decimal`, nunca `number`).
  - U-6 Coste de refresco por evento SSE en cada pantalla suscrita.
  - U-7 Constantes del motor pintadas sin traducir.
  - U-8 Vocabulario de niveles y estados entre pantallas.
  - U-9 Datos servidos por la API que ninguna pantalla consume.
  - U-10 Jerarquía y densidad de las pantallas clave: qué pregunta contesta cada cifra.
- **R-4 Catálogo de propuestas.** Cada una con: pantalla, pregunta del operador que contesta,
  endpoint o tabla exactos, coste (solo app / app más endpoint / app más persistencia) y riesgo
  sobre lo existente. Ordenado por valor entre coste. Separado de los hallazgos: una propuesta no
  es un defecto.
- **R-5 Arquitectura de visualización decidida y escrita** antes de tocar una pantalla: qué motor
  gráfico se usa para qué, con criterio mecánico y no estético.
- **R-6 Primera tanda implementada**: lo que no necesita backend nuevo, con la aritmética en
  funciones puras probadas y las pantallas rediseñadas de una en una.
- **R-7** Ninguna cifra nueva se pinta sin que su rótulo diga lo que de verdad es. En concreto,
  `bot_snapshots.equity` es PnL acumulado y no patrimonio: no se rotula «equity» ni «capital».
- **R-8** Ningún rango temporal se ofrece si el dato no llega. Mientras `/snapshots` no acepte
  rango, la curva se rotula por la ventana real que cubre.

## Criterios de aceptación

- **CA-1** Cada ítem U-n tiene veredicto (`OK`, `hallazgo F-NN` o `no aplica`) con evidencia en
  `findings.md`.
- **CA-2** `findings.md` tiene la tabla resumen ordenada por severidad y una ficha por hallazgo.
- **CA-3** La distancia a liquidación se calcula en **un solo sitio** y devuelve el mismo número en
  cartera, lista, detalle y gráfico. Se comprueba a mano con un bot simulado con posición abierta.
- **CA-4** `packages/shared/src/series.ts` tiene su `series.spec.ts` al lado y `pnpm test` entero
  queda en verde, incluidos worker, backtest y api.
- **CA-5** Los tests existentes de `packages/backtest/src/metrics.ts` pasan **sin haber sido
  modificados** después de promover el muestreo a `shared`.
- **CA-6** `pnpm --filter app build` en verde, sin superar los presupuestos de `angular.json`
  (2 MB inicial, 6 kB por hoja de componente).
- **CA-7** Ninguna pantalla instancia `lightweight-charts` dentro de una lista.
- **CA-8** Catálogo de propuestas entregado, con la tabla de specs de seguimiento.
- **CA-9** `pnpm test` y `pnpm lint` en verde al cerrar.

## Riesgos

- Tocar `packages/shared` obliga a pasar todos los tests del monorepo. El fichero es nuevo, así que
  el riesgo es de tiempo, no de regresión.
- `price-chart.component.ts` está muy afinado y su gesto de eje depende de la estructura interna de
  `lightweight-charts`. Se toca en una sola línea, con caída a la conducta anterior si el dato falta.
- Rediseñar tres pantallas es mucha superficie de revisión. Se hace de una en una, con un commit
  por pieza y la maqueta delante.
- El presupuesto `anyComponentStyle` de 6 kB ya lo rozan `bot-detail.page.scss` y
  `chart.page.scss`. El CSS de página de las secciones nuevas va a `global.scss`, como ya se hizo
  con `.legend` y `.mm-tiles`.
- Hay bots en marcha. Ningún cambio de este spec altera lo que el motor hace: todo es lectura,
  presentación y campos que ya estaban declarados.

## Referencias oficiales

Ninguna. Este spec no se apoya en la documentación de ningún venue ni SDK: revisa código propio y
contratos internos. Lo que cita son los comentarios normativos del propio repositorio, con
`fichero:línea`, en `findings.md`.
