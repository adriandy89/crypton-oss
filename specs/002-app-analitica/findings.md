# 002 — Hallazgos

Commit base: `8860625` · Fecha de apertura: 2026-09-05 · Angular 21.2.18 · Ionic 8 ·
Capacitor 8.4.2 · `lightweight-charts` 5.2.1 · `decimal.js` 10.6.0 (declarado en `apps/app`, no
importado) · Sin sondas: este spec no habla con ningún venue.

La severidad sigue la escala de `specs/README.md`. Los identificadores `F-NN` de este fichero son
**locales al spec 002**; cuando se cite un hallazgo del 001 se escribirá `001/F-NN`.

La confirmación aquí no puede ser «un test que falla»: `apps/app` no tiene runner y este spec
explica en `plan.md` por qué no se le añade uno. Un hallazgo se da por **confirmado** cuando la
evidencia es una lectura directa del código que no admite otra interpretación —una fórmula, un
campo que no se rellena, una llamada que no existe— y se marca `por confirmar` cuando depende de
verlo en ejecución.

## Línea base

Medida el 2026-09-05 sobre `8860625` (`main` tras el avance directo desde el 001), paquete a
paquete y desde Git Bash, **antes** de tocar nada:

| Paquete | Resultado |
|---|---|
| `shared` | 14 tests en verde |
| `strategy-core` | 222 en verde, **1 en rojo a propósito**: el test de confirmación de 001/F-15 (`strategies.spec.ts`) |
| `exchange-core` | 265 en verde, **3 en rojo a propósito**: confirmación de 001/F-68 (`write-retry.spec.ts`) y de 001/F-46 y 001/F-01 (`lighter-signer.spec.ts`) |
| `backtest` | 24 en verde |
| `worker` | 254 en verde, **2 en rojo a propósito**: confirmación de 001/F-31 (`paper-accounts.spec.ts`) y del stop rechazado (`bot-runner.spec.ts`) |
| `api` | 4169 unitarios en verde |
| `app`, `web`, `db` | sin tests |

Los seis rojos son los tests que el spec 001 dejó en rojo deliberadamente para confirmar sus
hallazgos (protocolo de la constitución: «un test que falla por el motivo declarado»), y por eso
`pnpm test` desde la raíz se detiene en `strategy-core` y no llega a ejecutar los paquetes
siguientes: **la suite entera hay que pasarla paquete a paquete mientras el 001 esté abierto.**
Lint: 0 errores en los nueve paquetes. `apps/app` no aporta ningún test: su script es literalmente
`echo "sin tests de UI por ahora"`, y el objetivo `test` de `angular.json:136` apunta a cuatro
ficheros de los que **faltan dos** (F-11).

Al cierre de la primera tanda: `shared` 41 (27 nuevos), `backtest` 24 intactos, `api` 4173 (4
nuevos), el resto igual que la línea base; build de la app dentro de presupuesto; lint limpio.

Tras la revisión de código de esa tanda (sección propia más abajo): `shared` 54 (40 en
`series.spec.ts`), `backtest` 24 intactos, `worker` 254 más los dos rojos del 001, `api` 4184 (11 más
que al cierre de la tanda); `ng build` sin errores —persiste el aviso previo al spec de
`bot-detail.page.scss` (7,68 kB de 6 kB, fichero sin cambios desde `8860625`)—; lint limpio en la
app y en la API.

## Referencias oficiales

Ninguna. Este spec no se apoya en la documentación de ningún venue ni SDK. Lo que cita como norma
son comentarios del propio repositorio, que en este proyecto tienen valor normativo porque
documentan el incidente que motivó cada decisión.

| Fuente interna | Regla que fija | Dónde |
|---|---|---|
| Invariante 1 de `CLAUDE.md` | «Solo `Decimal` […] Nunca `number`, nunca `parseFloat`» | `CLAUDE.md` |
| Contrato compartido | «% de caída que aguanta antes de liquidar. La métrica de riesgo nº 1» | `packages/shared/src/bot.ts:235` |
| Contrato compartido | «los acumulados hasta este nivel incluido: es el número que importa de verdad» | `packages/shared/src/bot.ts:191` |
| Precedente de tests | «`apps/app` no tiene ni un solo test […] Sacando la DECISIÓN de la vista, lo único que queda sin cubrir es el cableado» | `packages/shared/src/candle-paging.ts:6-16` |
| Semántica de `equity` | `equity = realized_pnl_acc + unrealized_pnl` | `apps/worker/src/engine/bot-store.ts:857` |

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | `liquidationDistancePct` está en el contrato con el rótulo «la métrica de riesgo nº 1» y la API no la rellena nunca: red de seguridad documentada que es código muerto | App / API | **Alta** | corregido en 002 | `packages/shared/src/bot.ts:235`; `apps/api/.../bots.service.ts:663-675` | S |
| F-02 | Tres implementaciones de la distancia a liquidación y **dos semánticas**: dos pantallas miden contra el precio de entrada y una contra el precio vivo | App | **Alta** | corregido en 002 | `portfolio.page.ts:273-278`; `bots-list.page.ts:440-446`; `chart.page.ts:486-492` | S |
| F-03 | «Capital asignado» de la portada es el nocional de las posiciones abiertas; `totalInvestment` está en el contrato y la API tampoco lo envía | App / API | Media | corregido en 002 | `portfolio.page.ts:245-249`; `packages/shared/src/bot.ts:227` | S |
| F-04 | Tres definiciones divergentes del mismo `BotSummary`: la compartida, la que devuelve la API y una tercera mantenida a mano en la app | App / API | Media | corregido en 002 | `packages/shared/src/bot.ts:218`; `bots.service.ts:560-580`; `core/models/index.ts:104` | M |
| F-05 | El detalle del bot recarga con cada evento SSE sin agrupar —3 o 4 peticiones por evento— y un comentario del gráfico afirma una paridad que no existe | App | Media | corregido en 002 | `bot-detail.page.ts:304-313`; `chart.page.ts:634-644` | S |
| F-06 | La revisión del asistente pinta precio, cantidad y distancia crudos de la API, y omite los acumulados que el contrato llama «el número que importa de verdad» | App | Media | corregido en 002 | `bot-create.page.html:355-367`; `packages/shared/src/bot.ts:191` | S |
| F-07 | La aritmética de dinero de la app se hace con `Number`; `decimal.js` es dependencia declarada y no se importa en ninguna parte | App | Media | corregido en 002 | `bots-list.page.ts:436`; `portfolio.page.ts:248` | M |
| F-08 | La pestaña Eventos pinta las constantes crudas del motor en la única pantalla que existe para mirar cuando algo no cuadra | App | Media | corregido en 002 | `bot-detail.page.html:506` | S |
| F-09 | Los mismos niveles se llaman de dos maneras según la pantalla, teniendo el traductor ya escrito | App | Baja | corregido en 002 | `bot-detail.page.html:391-394`; `bot-overlay.ts:79-92` | S |
| F-10 | `snapshots()` y `cycles()` llevan meses escritos y no los llama nadie; `cycles()` es además el único sin tipar y a `BotCycle` le falta `exit_avg` | App | Baja | corregido en 002 | `core/services/bots.service.ts:271,283`; `core/models/index.ts:164` | S |
| F-11 | El objetivo `test` de `angular.json` apunta a un `karma.conf.js` y un `src/test.ts` que no existen | App | Baja | corregido en 002 | `apps/app/angular.json:136-143` | S |
| F-12 | El muestreo de la curva del backtest —la función que decide si el peor momento sobrevive al dibujo— no tenía ningún test propio | Backtest | Baja | corregido en 002 | `packages/backtest/src/metrics.ts:142-175`; `engine.spec.ts` solo prueba `runReplay` | S |

## Fichas

### F-01 — `liquidationDistancePct` es una red de seguridad documentada que nunca se rellena

- **Síntoma**: ninguna respuesta de la API trae la distancia a liquidación, aunque el contrato compartido la declara y la señala como la métrica más importante del producto.
- **Evidencia**: `packages/shared/src/bot.ts:234-235` declara `liquidationDistancePct: string | null` precedido del comentario «`/** % de caída que aguanta antes de liquidar. La métrica de riesgo nº 1. */`». El único constructor de esas métricas en la API es `metricsOf` (`apps/api/src/modules/bots/bots.service.ts:643-676`), y su objeto de retorno tiene ocho campos —`dryRun`, `realizedPnl`, `unrealizedPnl`, `roiPct`, `positionQty`, `averageEntry`, `liquidationPrice`, `openOrders`, `uptimeSeconds`— **entre los que no está**. Se usa en los dos caminos que sirven bots (`:575` para el listado, `:619` para el detalle), así que no lo rellena ninguno. El dato para calcularlo sí está a mano: el mismo `snapshot` del que salen los otros campos trae `mark_price` (`packages/db/prisma/schema.prisma`, modelo `BotSnapshot`).
- **Impacto**: al no llegar el campo, cada pantalla se lo calcula por su cuenta, y de ahí sale F-02. El contrato compartido describe una garantía que el sistema no da, que es exactamente el patrón «red de seguridad documentada que es código muerto» que la escala de `specs/README.md` tipifica como **Alta**. Atenuante: la guarda que de verdad pausa un bot por cercanía a liquidación vive en el worker y se evalúa en cada tick (`liquidationAlertPct` en `risk_limits`), así que el usuario no queda desprotegido; lo que falla es el aviso visual con el que decide si intervenir a mano.
- **Reproducción / test**: `apps/api` — unitario sobre `metricsOf` con un snapshot de `mark_price: '100'` y `liquidation_price: '80'` en un bot LONG: debe devolver `liquidationDistancePct: '20.00'`. Hoy la propiedad no existe en el resultado.
- **Propuesta**: calcular en `metricsOf` `|mark − liq| / mark × 100` con `Decimal`, devolver `null` cuando falte cualquiera de los dos, y añadir el campo a la interfaz de la app. Arreglo S. Va junto con F-02: rellenarlo sin borrar los cálculos locales dejaría cuatro números en vez de tres.
- **Decisión**: corregido en 002 (`83b01f2`): `metricsOf` devuelve `liquidationDistancePct` con `Decimal` contra el `mark_price` del snapshot; test en `bots-metrics.spec.ts`.

### F-02 — Tres implementaciones de la distancia a liquidación, y dos significados distintos

- **Síntoma**: el mismo bot enseña una distancia a liquidación distinta según la pantalla desde la que se mire, y en dos de ellas el número no cambia aunque el precio se acerque a la liquidación.
- **Evidencia**: tres cálculos independientes, ninguno compartido.
  - `portfolio.page.ts:273-278` — `near()`: `Math.abs(entry - liq) / entry * 100 < 10`, con `entry = averageEntry`. El comentario de `:270-272` lo dice explícitamente: «Liquidación a menos del 10 % **del precio de entrada**».
  - `bots-list.page.ts:440-446` — `liqDistance()`: `Math.abs((liq - ref) / ref * 100)` con `ref = averageEntry`. El comentario de `:439` promete otra cosa: «Distancia porcentual **del precio actual** a la liquidación».
  - `chart.page.ts:486-492` — `liqDistance`: `Math.abs((last - liq) / last * 100)` con `last` del ticker en vivo. Esta es la correcta, y su comentario la llama «LA métrica de riesgo».

  Las dos primeras miden la separación entre la entrada y la liquidación, que es una propiedad estática de la posición —esencialmente el apalancamiento— y **no se mueve con el mercado**. La tercera mide el riesgo de ahora. Que la etiqueta de `bots-list.page.ts:439` diga «precio actual» mientras el código usa `averageEntry` indica que la divergencia no es deliberada.
- **Impacto**: un bot cuya entrada quedó lejos y cuyo precio se ha pegado a la liquidación **no se marca** ni en la cartera ni en la lista: las dos siguen enseñando la distancia del día que abrió. Justo el caso en el que el aviso debería aparecer es el caso en el que no aparece. Al revés también: un bot recién abierto con apalancamiento alto sale en rojo permanente aunque el precio no se haya movido, y un aviso que está siempre encendido se deja de leer. El propio repositorio ya tropezó con la fragilidad de esta métrica: `chart.page.ts:630-632` documenta el incidente de cruzar «el precio EN VIVO con la liquidación congelada», que devuelve «un número que no es ninguno de los dos».
- **Reproducción / test**: bot simulado LONG a 3× con entrada en 100 y liquidación en 68. Con el precio en 100, cartera y lista dicen ~32 %. Se deja caer el precio a 72: el gráfico pasa a ~5,6 % y **cartera y lista siguen diciendo 32 %**.
- **Propuesta**: borrar los tres cálculos y leer `liquidationDistancePct` de F-01 en las cuatro pantallas. Con el campo en el servidor, el número lo produce el mismo `mark_price` que ya alimenta el resto de métricas y deja de haber ocasión de que difieran. Arreglo S una vez hecho F-01.
- **Decisión**: corregido en 002 (`83b01f2`): los tres cálculos locales se borran y cartera, lista, detalle y gráfico leen el campo del servidor. El gráfico pierde la actualización contra la vela viva a cambio de dar el mismo número que las demás.

### F-03 — «Capital asignado» es en realidad el nocional de las posiciones abiertas

- **Síntoma**: la cifra «Capital asignado» de la pestaña Cartera no coincide con la suma de lo que el usuario puso en sus bots.
- **Evidencia**: `portfolio.page.ts:245-249`:
  ```ts
  readonly deployed = computed(() =>
    this.reales().filter((b) => this.isLive(b.status))
      .reduce((a, b) => a + Number(b.positionQty) * Number(b.averageEntry ?? 0), 0),
  );
  ```
  `positionQty × averageEntry` es el nocional de la posición abierta, no el capital. El capital es `total_investment`, que `packages/shared/src/bot.ts:227` declara en `BotSummary` y la API no envía (misma raíz que F-01: `metricsOf` no lo incluye, `bots.service.ts:643-676`), así que la pantalla no puede leerlo aunque quiera.
- **Impacto**: la cifra miente en las dos direcciones y en la portada de la app. Un bot vivo con la escalera tendida y sin ninguna orden ejecutada todavía **cuenta cero**, aunque tenga todo su capital comprometido. Un bot a 3× con posición abierta **cuenta el triple** de lo que su dueño puso. Con una cartera mixta el número no significa nada concreto: ni capital, ni exposición, porque solo suma los que tienen posición. No alimenta ninguna guarda ni ninguna orden —de ahí Media y no Alta—, pero es una de las cuatro cifras que se leen al abrir la aplicación.
- **Reproducción / test**: dos bots simulados de 100 USDC cada uno, uno con la escalera tendida sin ejecutar y otro a 3× con posición abierta por 300 de nocional. «Capital asignado» dice 300; el capital asignado es 200.
- **Propuesta**: exponer `totalInvestment` en `metricsOf` y separar dos tiles: **Capital asignado** = `Σ totalInvestment` de los bots vivos, y **Exposición** = `Σ positionQty × averageEntry`. Son dos preguntas distintas y las dos se quieren contestar. Arreglo S.
- **Decisión**: corregido en 002 (`83b01f2`): `totalInvestment` viaja en el listado; la cartera separa «Capital asignado» (Σ `totalInvestment` de los vivos) de «Exposición» (Σ nocional abierto).

### F-04 — Tres definiciones divergentes del mismo `BotSummary`

- **Síntoma**: el contrato compartido, lo que la API devuelve y lo que la app declara no coinciden, y nada lo detecta.
- **Evidencia**:
  - `packages/shared/src/bot.ts:218-240` declara `BotSummary` con `totalInvestment` y `liquidationDistancePct`.
  - `apps/api/src/modules/bots/bots.service.ts:560-580` construye el objeto del listado a mano, sin anotación de tipo que lo ate al contrato: no envía ninguno de esos dos y sí envía `testnet`, `paper`, `note` y `lastError`, que el contrato no declara.
  - `apps/app/src/app/core/models/index.ts:104-137` declara una **tercera** interfaz con el mismo nombre, que refleja lo que la API manda de verdad —incluidos `testnet`, `paper` y `dryRun`— y omite los dos campos del contrato.

  Es decir: el contrato compartido no gobierna a ninguno de sus dos extremos, y el tipo que la app usa está mantenido a mano contra la implementación, no contra el contrato.
- **Impacto**: F-01 y F-03 son consecuencias directas: campos declarados que nadie rellena pasan desapercibidos indefinidamente porque no hay ningún punto donde el compilador compare las tres. Cada campo nuevo hay que acordarse de añadirlo en tres sitios, y olvidarse no rompe la compilación de nada. Es la «deriva entre app, API y advisor» que la escala tipifica como Media.
- **Reproducción / test**: no hay test posible sin atar los tipos; la evidencia es la lectura de los tres ficheros.
- **Propuesta**: anotar el retorno del listado y del detalle con el tipo compartido en `apps/api` —lo que convierte los campos que faltan en error de compilación— y que la app importe `BotSummary` de `@crypton/shared` en vez de redeclararlo, extendiéndolo si necesita campos extra. Arreglo M: hay que reconciliar primero los campos que la API manda de más, y eso conviene hacerlo después de F-01 y F-03, que ya añaden dos.
- **Decisión**: parcial en 002 (`83b01f2`) y atado entero en `e64f065` (2026-09-05, con la aprobación general del usuario): el contrato compartido gana los cinco campos que la API ya devolvía y la app ya leía (`testnet`, `paper`, `dryRun`, `note`, `lastError`); `BotsService.list` se declara `Promise<BotSummary[]>` y la app importa el tipo en vez de mantener su copia. No destapó más campos divergentes que los conocidos; sí que las fechas viajaban como `Date` en el tipo y como ISO en el cable, y ahora el tipo dice la verdad.

### F-05 — El detalle del bot recarga sin agrupar, y un comentario afirma una paridad que no existe

- **Síntoma**: con un market maker abierto en la pantalla de detalle, la app dispara peticiones continuamente.
- **Evidencia**: `bot-detail.page.ts:304-313` se suscribe al flujo de eventos y llama a `load(false)` con **cada** evento del bot, sin ventana de agrupación. Cada `load()` hace `detail` más `orders(60)` más `events(60)` en paralelo (`:327-336`) y añade `mmStats` si el bot es market maker (`:343`): tres o cuatro peticiones por evento. El `README` dice que «un market maker genera decenas de eventos por minuto». La pantalla del gráfico sí agrupa, con `throttleTime(1500, { leading: true, trailing: true })` (`chart.page.ts:636-644`), y su comentario razona la elección de `throttleTime` frente a `debounceTime` (`:149-153`) y termina diciendo «**Mismo patrón que `bot-detail.page.ts`**, con la ventana de agrupación que explica `BOT_COALESCE_MS`» (`:634-635`). Esa afirmación es falsa: el patrón compartido es el filtro por bot y `takeUntilDestroyed`, pero la ventana solo existe en el gráfico.
- **Impacto**: batería y datos en un móvil, y carga innecesaria en la API, en la pantalla que un usuario deja abierta precisamente cuando algo va mal. Recarga además las cuatro fuentes aunque solo una pestaña esté visible. No se pierde dinero, así que es Media; pero es también una precondición del trabajo de este spec: añadir la curva y los ciclos a `load()` sin arreglar esto multiplicaría el problema. El comentario equivocado agrava el hallazgo porque invita a no comprobar.
- **Reproducción / test**: abrir el detalle de un market maker simulado con actividad y contar las peticiones en la pestaña de red. Se ven ráfagas de tres o cuatro por fill.
- **Propuesta**: aplicar la misma tubería que el gráfico —`throttleTime(BOT_COALESCE_MS)` con `leading` y `trailing`— y corregir el comentario de `chart.page.ts` para que describa lo que hay. Como mejora aparte, pedir solo lo que la pestaña visible necesita. Arreglo S.
- **Decisión**: corregido en 002 (`83b01f2`): `throttleTime(1500, {leading, trailing})` con la misma constante `BOT_COALESCE_MS` que el gráfico.

### F-06 — La revisión del asistente pinta cifras crudas justo donde se decide poner dinero

- **Síntoma**: en el último paso antes de crear un bot, los precios y las cantidades de la escalera salen con punto decimal inglés y con todos los decimales que traiga el venue, mientras diez píxeles más abajo las cifras del peor caso salen formateadas.
- **Evidencia**: `bot-create.page.html:355-367` interpola directamente `{{ lv.price }}`, `{{ lv.qty }}` y `{{ lv.distancePct }} %`, sin pasar por ninguna función de formato. En el bloque inmediatamente siguiente, `:375` y siguientes sí usan `money(p.worstCaseNotional)`. Las dos convenciones numéricas conviven en la misma pantalla y a pocos píxeles. `apps/app/src/app/core/utils/format.ts:94-117` existe precisamente para esto y documenta el caso. Además, `LevelPreview` trae `cumulativeNotional` y `cumulativeMargin`, que `packages/shared/src/bot.ts:191` describe como «los acumulados hasta este nivel incluido: **es el número que importa de verdad**», y la plantilla no los pinta.
- **Impacto**: la pantalla que la propia interfaz titula «Esto es lo que se colocará» (`:342`) presenta los números de la peor forma posible para leerlos, en el momento de máxima consecuencia. Con martingala o GridMart, donde la escalera tiene doce o veinte niveles y lo que hay que entender es cuánto se acumula, el dato que contesta esa pregunta está calculado, viaja en la respuesta y no se enseña.
- **Reproducción / test**: crear un bot en un par con muchos decimales (por ejemplo un símbolo con `price_decimals` alto) y mirar el paso «Revisión».
- **Propuesta**: pasar los tres campos por `price()`, `qty()` y `pct()`, y añadir una columna de acumulado por nivel. Arreglo S, sin cambio de contrato: el dato ya llega.
- **Decisión**: corregido en 002 (`83b01f2`): `price()`, `qty()` y `pct()` en la escalera de la revisión, más la línea de acumulados por nivel.

### F-07 — La aritmética de dinero de la app se hace con `Number`

- **Síntoma**: la app suma, resta y multiplica importes con aritmética de coma flotante, contra el invariante 1 del proyecto.
- **Evidencia**: `decimal.js` está declarado como dependencia de `apps/app` (`apps/app/package.json`) y **no se importa en ningún fichero de `apps/app/src/app`**. En su lugar hay 84 usos de `Number(` en el árbol de la app. Los que operan sobre dinero:
  - `bots-list.page.ts:435-437` — `total()`: `String(Number(bot.realizedPnl) + Number(bot.unrealizedPnl))`, el PnL de cada tarjeta.
  - `portfolio.page.ts:245-249` — `deployed`: acumula `Number(qty) × Number(entry)` sobre N bots.
  - `portfolio.page.ts` — `sumPnl`, del que sale la cifra grande de la portada.
  - Los tres cálculos de F-02.
- **Impacto**: a dos decimales de presentación no se ha demostrado ningún error visible, y por eso **no se clasifica como Alta**: sumar una decena de importes en doble precisión da errores del orden de 1e-13, que no llegan a la pantalla. Lo que sí es cierto es que la app es hoy la única parte del sistema que no cumple el invariante que `CLAUDE.md` pone en primer lugar, que la desviación es sistemática y no puntual, y que crece con el número de bots. Se anota como Media por ser deriva de un invariante declarado, dejando escrito que no se ha observado consecuencia.
- **Reproducción / test**: `['0.1', '0.2']` sumado con la tubería actual da `0.30000000000000004`; con `Decimal`, `'0.3'`.
- **Propuesta**: que toda la aritmética de dinero de la app pase por las funciones puras de `packages/shared/src/series.ts` (que este spec crea) y por `money.ts`, y que `Number()` quede solo en el borde de pintado, donde una coordenada sí es un número. Arreglo M por número de sitios, sin riesgo por pieza.
- **Decisión**: corregido en 002 (`83b01f2`) en los sitios que operan dinero: `sumaExacta` en la portada y las tarjetas, `Decimal` en exposición y reparto. Quedan usos de `Number` que son solo comparaciones o coordenadas.
- **Severidad**: Media se mantiene (2026-09-05). Es desviación de un invariante declarado sin consecuencia observada a dos decimales; subirla a Alta no cambiaría nada y bajarla a Baja escondería que era un invariante.

### F-08 — La pestaña Eventos enseña las constantes del motor sin traducir

- **Síntoma**: en la pantalla que existe para mirar cuando algo no cuadra, los sucesos salen como identificadores en mayúsculas y en inglés.
- **Evidencia**: `bot-detail.page.html:506` interpola `{{ e.type }}` tal cual. Los valores que produce el motor son constantes como `RISK_GUARD_TRIPPED`, `ORDER_REJECTED`, `FAIR_PRICE_STALE`, `LIQUIDATION_NEAR`, `MARKET_SPEC_CHANGED` o `POSITION_MODE_SKIPPED` (emitidas a lo largo de `apps/worker/src/engine/bot-runner.ts`). La app tiene un fichero dedicado a traducir constantes a lenguaje humano —`apps/app/src/app/core/utils/labels.ts`, con `strategyLabel`, `venueLabel`, `botStatusLabel`— y aquí no se usa ninguno.
- **Impacto**: el proyecto entero está en castellano y esta es la pantalla de diagnóstico. Un usuario que quiere saber por qué se paró su bot encuentra una constante de programa. Peor: la causa está ahí y hay que ir a la quinta pestaña a buscarla, cuando la cabecera del bot solo enseña la pastilla de estado y, con suerte, `lastError` (`bot-detail.page.html:88-95`).
- **Reproducción / test**: abrir la pestaña Eventos de cualquier bot con recorrido.
- **Propuesta**: un diccionario de tipo de evento a frase en castellano en `core/utils/labels.ts`, con caída a la constante cruda para tipos nuevos —el patrón que ya usan las otras funciones de ese fichero, para que añadir un evento en el worker no rompa la pantalla—, y subir el último evento de severidad `WARN` o superior a la cabecera del bot y a la tarjeta de la lista. Arreglo S para la traducción; la subida a cabecera es propuesta de catálogo, no hallazgo.
- **Decisión**: corregido en 002 (`83b01f2`): `EVENT_LABELS` en `labels.ts`, con caída a la constante para tipos nuevos.

### F-09 — Dos vocabularios para los mismos niveles

- **Síntoma**: un nivel se llama `GRID_BUY#3` en el detalle del bot y `GRID#3` en el gráfico.
- **Evidencia**: `bot-detail.page.html:391-394` interpola `{{ o.level_kind }}#{{ o.level_index }}` y `{{ o.status }}` crudos, produciendo `GRID_BUY#3` y `PARTIALLY_FILLED`. El gráfico ya tiene el traductor escrito: `levelTitle` en `apps/app/src/app/shared/chart/bot-overlay.ts:79-92` produce los rótulos cortos `BASE`, `SAF#n`, `GRID#n`, `TP#n`, `SL`, `BID`, `ASK`. La misma cosa tiene dos nombres en dos pantallas de la misma aplicación, entre las que además se navega con un botón.
- **Impacto**: fricción de lectura y una traducción mental innecesaria al saltar del detalle al gráfico, que es un camino de un toque (`bot-detail.page.html:17-25`). No hay pérdida ni riesgo.
- **Reproducción / test**: abrir la pestaña Órdenes de un bot de rejilla y luego su gráfico.
- **Propuesta**: reutilizar `levelTitle` en el detalle y traducir los estados de orden en `labels.ts`. Arreglo S; el traductor ya existe y está probado por uso.
- **Decisión**: corregido en 002 (`83b01f2`): `levelTitle` exportado desde `bot-overlay.ts` y usado en Escalera y Órdenes; `orderStatusLabel` para los estados.

### F-10 — Dos métodos cliente escritos y nunca llamados, uno de ellos sin tipar

- **Síntoma**: la app tiene el código para pedir la serie temporal y los ciclos cerrados de un bot, y ninguna pantalla lo usa.
- **Evidencia**: `apps/app/src/app/core/services/bots.service.ts:283-286` define `snapshots(id, limit = 300)` contra `GET /bots/:id/snapshots`, y `:271-274` define `cycles(id, limit = 50)`. Una búsqueda de `.snapshots(` y `.cycles(` en `apps/app/src` no devuelve ninguna llamada: los únicos consumidores de sub-recursos de bot son `chart.page.ts:1116-1117`, que usa `fills()` y `levels()`. Además `cycles()` devuelve `Promise<unknown[]>` —el único de los siete sub-recursos sin tipo— y la interfaz `BotCycle` de `core/models/index.ts:164-176` no declara `exit_avg`, que la base guarda y la API devuelve.
- **Impacto**: no hay defecto de funcionamiento; hay una funcionalidad entera construida hasta el penúltimo paso. La consecuencia es la que motiva este spec: la app no tiene curva de resultado, ni de posición, ni de margen, ni de distancia a liquidación en el tiempo, ni tasa de acierto por ciclo, ni duración media, teniendo los datos a una llamada. `exit_avg` es además el campo que dice a qué precio se cerró un ciclo de verdad.
- **Reproducción / test**: `grep -rn "\.snapshots(\|\.cycles(" apps/app/src` no devuelve resultados.
- **Propuesta**: tipar `cycles()` como `Promise<BotCycle[]>`, añadir `exit_avg` a `BotCycle`, y consumir ambos en el detalle del bot. Es el objeto de la primera tanda de este spec. Arreglo S para el tipado.
- **Decisión**: corregido en 002 (`83b01f2`): `cycles()` tipado, `exit_avg` declarado, y los dos endpoints alimentan el Resumen.

### F-11 — El objetivo `test` de la app apunta a ficheros que no existen

- **Síntoma**: `ng test` en `apps/app` no puede funcionar.
- **Evidencia**: `apps/app/angular.json:136-143` declara el objetivo `test` con el constructor `@angular-devkit/build-angular:karma` y las opciones `main: "src/test.ts"`, `polyfills: "src/polyfills.ts"`, `tsConfig: "tsconfig.spec.json"` y `karmaConfig: "karma.conf.js"`. De esos cuatro, **`src/test.ts` y `karma.conf.js` no existen**; `src/polyfills.ts` y `tsconfig.spec.json` sí. Falta además `karma` en `devDependencies`. El script de `package.json` no lo invoca: es `echo "sin tests de UI por ahora"`. Queda `@types/jasmine`, sin runner que lo use.
- **Impacto**: ninguno en ejecución, porque nadie lo llama. Lo que hace es sugerir que existe una suite de UI que podría ejecutarse, y esa expectativa equivocada es la que lleva a plantear tests de componente cuando la decisión tomada en la casa —y documentada en `packages/shared/src/candle-paging.ts:6-16`— es la contraria: sacar la lógica a `shared` y probarla allí.
- **Reproducción / test**: `ls apps/app/karma.conf.js apps/app/src/test.ts` devuelve «No such file or directory» para los dos.
- **Propuesta**: borrar el objetivo `test` de `angular.json` y `@types/jasmine` de `devDependencies`, y dejar en su lugar un comentario que apunte al precedente de `candle-paging.ts`. Arreglo S. Alternativa, si algún día se quiere suite de componentes: spec propio, porque arrastra `jest-preset-angular`, TestBed y zone.js.
- **Decisión**: corregido en `e64f065` (2026-09-05): se borran el objetivo `test` de `angular.json` y su `tsconfig.spec.json`. La política de tests de la app es la del precedente de `candle-paging.ts`: la lógica en `shared` con jest, la vista sin runner. Si algún día se monta una suite de UI, se vuelve a declarar entera y con sus ficheros.

### F-12 — El muestreo de la curva del backtest no tenía ningún test

- **Síntoma**: nada comprobaba que `downsampleExtrema` conservara el pico del drawdown, que es exactamente lo que su comentario dice que existe para conservar.
- **Evidencia**: `packages/backtest/src/metrics.ts:142-175` era una función privada; `packages/backtest/src/engine.spec.ts` y `ticks.spec.ts` —los dos únicos specs del paquete— ejercitan `runReplay` y la agregación de ticks, no `buildMetrics` (`grep -rn "buildMetrics\|downsample" packages/backtest/src/*.spec.ts` no devuelve nada). El único consumidor es `apps/api/src/modules/backtests/backtests.service.ts:207`, sin test tampoco.
- **Impacto**: un cambio en el tamaño del cubo o en la deduplicación podría borrar el mínimo de la curva y nadie se enteraría: la gráfica seguiría pintándose, con menos drawdown del real. Baja porque no hay evidencia de fallo; se anota porque es la propiedad que la función promete.
- **Reproducción / test**: `packages/shared/src/series.spec.ts` — «la punta profunda sobrevive con cualquier tope»: una serie plana con una única caída, muestreada a 8, 40, 200 y 1000 puntos, conserva la caída en los cuatro casos.
- **Propuesta**: promover la función a `@crypton/shared` (`muestreoPorExtremos`) con su spec, y que `metrics.ts` la llame. Hecho en este spec.
- **Decisión**: corregido en 002 (`7ba9b41`); los 24 tests de `backtest` pasan sin modificarlos (CA-5).

## Revisión de código de la primera tanda

Segunda lectura, con los ojos de quien no lo escribió, de todo lo que este spec añadió entre
`8860625` y `3594ef8`. Se separa de las fichas F-NN porque no son defectos de la app que se revisó
sino de lo que se hizo al corregirla, y ninguno llegó a `main`. Las referencias `fichero:línea` son
del árbol en `3594ef8`; las correcciones están en `13055fb` (shared), `2c001e3` (api) y `76aa64f`
(app), con sus tests.

| ID | Qué estaba mal | Dónde | Efecto que tenía | Corrección |
|---|---|---|---|---|
| R-01 | El rango pedía `points` **cubos** y el servidor conserva **cuatro filas por cubo**: para 480 puntos volvían 1920 | `apps/api/.../bot-series.service.ts:106` | La curva de 24 h, 7 d y 30 d llegaba 4× más pesada y `muestreoPorExtremos` volvía a recortarla en el cliente | `bucketMsFor(desde, hasta, points / 4)` en `shared`, compartido con la app; test de que el cubo de 24 h es de 12 min |
| R-02 | El umbral de hueco era fijo (3 min) y los cubos del rango llegan a 6 h | `apps/app/.../bot-series.ts:21,42` | La línea de 7 d y 30 d se partía en cientos de fragmentos sin que el bot hubiera parado | `gapMsFor(bucket) = max(3 cadencias, 2 cubos)`; el detalle recuerda el cubo con el que llegó la serie |
| R-03 | La distancia a liquidación se medía contra el `mark_price` del **último snapshot** | `apps/api/.../bots.service.ts`, `metricsOf` | Un bot parado con posición no escribe más snapshots: su distancia quedaba congelada durante días con el mercado moviéndose | `liveMarks`: una lectura de la caché de tickers por venue y red; sin ticker, el snapshot. Y la fórmula es `liquidationDistancePct` de `shared`, la del worker y el preview, no una cuarta |
| R-04 | Al unificar la métrica (F-02), la **única** pantalla con precio vivo pasó a leer el número del servidor | `apps/app/.../chart.page.ts:544` | Con el gráfico abierto sobre un bot sin eventos el número no se movía aunque la vela sí | El gráfico mide sobre el último tick con la fórmula compartida y cae al servidor si no hay tick |
| R-05 | Cuatro semáforos escritos a mano, con `<` en unas y `>=` en otras | `bot-detail.page.ts:377`, `bots-list.page.ts:310,316`, `portfolio.page.ts:187,269`, `chart.page.html` | En 10 % y 25 % exactos, dos pantallas pintaban colores distintos para el mismo bot | `core/utils/risk.ts` (umbrales y tono) y `ui-liq-meter` (la fila entera) en las cuatro |
| R-06 | La ventana de agrupación de eventos, copiada en dos pantallas | `bot-detail.page.ts:146`, `chart.page.ts:157` | Dos copias de una política que ya se habían desalineado una vez (F-05) | `StreamService.ofBot(botId)` con la constante dentro |
| R-07 | Los rasgos de mercado se calculaban dos veces: el asistente con sus constantes y `/market-data/features` con las suyas | `advisor.service.ts:72,574` | Franja del gráfico y recomendación podían decir cosas distintas del mismo par | El asistente delega en `MarketDataService.features`; una tubería y una caché |
| R-08 | `ui-spark` ignoraba `height` en modo barras | `ui-spark.component.ts:45` | Las barras de ciclos salían con la altura del CSS, no la pedida | `[style.height.px]` sobre `.bars`; `markPos` reutiliza las coordenadas ya calculadas |
| R-09 | `aria-valuemax` fijo en 100 cuando `total` es nulo | `ui-meter.component.ts:40` | Un lector de pantalla oía «60 de 100» en una barra que iba de 0 a la suma de los segmentos | `valueMax = total ?? suma`; umbrales estrictos |
| R-10 | El detalle volvía a descargar la serie con **cada** evento agrupado (1,5 s) aunque la tabla cambie una vez por minuto; y una respuesta tardía de otra ventana pisaba la actual | `bot-detail.page.ts:812-826` | 39 de cada 40 descargas idénticas en un market maker; y al pulsar 7d→8h rápido podía quedarse la de 7d | Refresco como mucho una vez por cadencia, y se descarta la respuesta si el rango cambió mientras llegaba |
| R-11 | El ROI solo se veía dentro del `@if` de la serie; el coste y el reparto maker/taker solo con ciclos cerrados; `distancia()` se recalculaba en la plantilla por fila y vuelta | `bot-detail.page.html:143-176,258-310,527-556` | Un bot recién arrancado no enseñaba ni ROI ni reparto, justo cuando se mira si funciona | ROI fuera del `@if`; reparto sin esperar al primer ciclo; distancia precalculada en `escalera` |
| R-12 | La escalera del asistente formateaba precio y cantidad **sin los decimales del mercado** | `bot-create.page.html:363-364` | Dos niveles contiguos de un par barato salían idénticos en la pantalla donde se decide poner dinero (lo que F-06 quería arreglar, a medias) | `price(lv.price, decimales())`, `qty(lv.qty, decimalesQty())` |
| R-13 | La guarda de propiedad del rango era `snapshots(user.id, id, 1)`: una consulta de datos usada como guarda; y `toMs <= fromMs` producía una consulta vacía en vez de un 400 | `bots.controller.ts:261-266` | Una fila leída y descartada por petición; un rango invertido devolvía `[]` sin explicar por qué | `BotsService.assertOwn` (`select id`) y `BadRequestException` |
| R-14 | La analítica de pantalla (`resumenDeCiclos`, `repartoDeEjecucion`, coste de comisiones) vivía en la app sin test, y el reparto por símbolo de la cartera sumaba con `Number` | `apps/app/.../bot-series.ts`, `portfolio.page.ts:347` | Contra el precedente de `candle-paging.ts` que este mismo spec invoca, y contra el invariante 1 (F-07) | Todo a `packages/shared/src/series.ts` con tests; `repartoPorSimbolo` exacto |
| R-15 | Las miniseries de lista y cartera se convertían de cadena a número en **cada** vuelta de la detección de cambios, dos veces por tarjeta | `bots-list.page.ts:273-281`, `portfolio.page.ts:159-167,241` | Trabajo por nada en cada scroll con veinte tarjetas | `@let puntos` en la plantilla y `puntosDeSpark` memorizado por identidad del array |

Lo que la revisión miró y dejó como estaba: `BotSeriesService` no interpola parámetros (test
«los parámetros van fuera del SQL»); ningún componente nuevo importa `lightweight-charts` (CA-7);
`price-chart.component.ts` sigue tocado en una sola línea (`axisLabelVisible`); ningún fichero de
`packages/shared` auditado por el 001 cambió.

## Verificado OK

Lo que se ha revisado y estaba bien, para no volver a mirarlo:

- **El motor gráfico.** `price-chart.component.ts` aísla `lightweight-charts` en un único fichero con una API interna en `Candle`, `OverlayLine` y `OverlayMarker` (`:66-73`); carga la librería con `import()` perezoso; corre fuera de NgZone; se protege de reconstrucciones solapadas con un contador de generación (`:259-269`); indexa la cruceta por tiempo para no recorrer el histórico en cada píxel; y degrada sin romper si la estructura interna de la librería cambia (`attachAxisGesture`, `:854-860`). No se toca.
- **La capa de bot sobre el gráfico.** `bot-overlay.ts` codifica el motivo de cada línea por **tono y por trazo** a la vez, documentando que «una de cada doce personas no separa el rojo del verde» (`chart-theme.ts:69-87`), separa el stop-loss de la liquidación en color por ser las dos que peor sale confundir, distingue lo colocado de lo planificado por intensidad y punteado, y no calla las órdenes que no puede situar (`skipped`).
- **La paleta.** `chart-theme.ts` lee los tokens del `:root` en tiempo de ejecución en vez de mantener una segunda copia, y razona por qué (`:7-11`). El violeta de marca está deliberadamente fuera de las señales de precio.
- **El sistema de diseño.** `theme/variables.scss` tiene dos capas —primitivas y puente a Ionic—, escala de radios cerrada, rampa `--ion-color-step-*` completa de 50 a 950 con el incidente que la motivó anotado, y tres fuentes variables auto-alojadas en vez de CDN, con el motivo escrito.
- **La biblioteca de componentes.** Los 18 `ui-*` de `shared/ui` sustituyeron a familias de clases duplicadas, y cada cabecera enumera lo que unificó y el defecto que corregía. Es la base sobre la que se apoya este spec.
- **El wizard.** `fullConfig()` tiene la misma forma que valida la API, el preview del servidor es el que autoriza crear, y `ui-risk-meter` calcula el riesgo con `strategy.preview()` —la misma función pura que ejecuta el motor— y no con `capital × apalancamiento`, razonando por qué esa cuenta miente en martingala y GridMart (`ui-risk-meter.component.ts:7-27`). Confirmado también por el spec 001 (`informes/A-market-makers.md`, §10).
- **La paginación del gráfico.** `packages/shared/src/candle-paging.ts` es lógica de pantalla puesta en `shared` para poder probarla, con su spec al lado. Es el precedente que este spec sigue.
- **Los canales del flujo en vivo.** `stream.service.ts` separa eventos de bot, ticks y velas en tres canales, con el motivo escrito (`:60-69`): sin esa separación, abrir la lista de mercados afectaría a lo que hace la pantalla de bots.
- **Los estados vacíos.** `bots-list.page.ts` distingue cinco situaciones y cada una dice algo distinto y accionable, incluido el puente para quien tiene sus bots en la pestaña de simulados y cree haberlos perdido.

## Preguntas abiertas

Las cuatro quedaron resueltas el 2026-09-05, cuando el usuario aprobó las maquetas y «todo lo
necesario». El detalle está en la ficha de cada hallazgo:

1. **Severidad de F-07**: Media se mantiene (ficha F-07).
2. **Alcance de F-04**: se ata entero (ficha F-04).
3. **F-11**: se borra el objetivo muerto (ficha F-11).
4. **Rango de la curva**: resuelto en la fase 6 con el rango del servidor; la primera tanda se
   publicó rotulada «últimas 8 h» y la pastilla dice lo que la serie cubre de verdad.

## Specs de seguimiento propuestos

| Nº propuesto | Slug | Hallazgos y propuestas que agrupa | Prioridad |
|---|---|---|---|
| 003 | `cartera-agregada` | Curva de cartera con tabla `portfolio_snapshots` y cron del worker; retención asociada. Única pieza con persistencia nueva | Media |
| 004 | `backtest-para-todos` | Sacar el backtest de `adminGuard`, reabrir ejecuciones guardadas (`detail()` está escrito y no se llama), tabla de operaciones, comparar dos ejecuciones. Depende de 001/F-45 | Alta |
| 005 | `grafico-avanzado` | Panel de resultado bajo el precio, precio medio como serie temporal, veredicto de mercado con `buildFeatures`, acciones del bot sin salir del gráfico | Media |
| 006 | `historial-y-cronologia` | `GET /bots/:id/revisions` sobre `bot_config_revisions`, y cronología unificada de órdenes, ejecuciones y eventos por ciclo | Media |
| 007 | `panel-operativo` | `activity_log` y `GET /admin/activity/summary`, que existen y no tienen ninguna pantalla | Baja |
