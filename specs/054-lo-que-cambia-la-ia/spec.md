# 054 — Lo que cambia la IA: los avisos con sus valores, y su alcance medido

Estado: `hecho` (falta CA-9 manual; H-01 y H-02 corregidos en el 055) · Tipo: `cambio` · Rama: `spec/054-lo-que-cambia-la-ia`

## Objetivo

Que cada aviso del Modo IA que propone o aplica un cambio diga **qué parámetros toca**, con su nombre
legible y **su valor de antes y el de después**. Y que lo que la IA puede modificar quede medido
sobre el código real, escrito en la guía y fijado por un test que falle si un día toca algo más.

Se sabrá que está hecho cuando:

- un aviso de Telegram de una sugerencia o de un cambio aplicado se lea sin abrir la app;
- ningún lote de avisos se pierda por largo;
- el test de alcance esté en verde y caiga al romperlo a propósito.

## Contexto

Petición directa del usuario del 2026-09-16, tras el 053: «revisa que las notificaciones de telegram
de la IA que tambien mande que parametros modifico y que valores cambio. Revisa lo que puede
modificar la IA».

Lo que hay hoy (verificado en el código):

- **Los avisos solo nombran claves.** `AI_SUGGESTION` dice «El supervisor propone cambiar
  buyDistanceBps, sellDistanceBps, minAllowedDistanceBps: <motivo>». `AI_APPLIED` dice «El
  supervisor ha cambiado …: <motivo>». No llevan ni un número. Para decidir si se aprueba una
  sugerencia hay que abrir la app. Al aprobar, además, el cambio se **recalcula** con el mercado de
  ese momento (spec 047, F-04), así que lo aplicado puede no ser lo propuesto, y nada lo dice.
- **Los datos existen.** `cambio.diff.changed` trae `from`, `to` y `labelKey` de cada campo. Los
  nombres en castellano solo viven en la app (`apps/app/src/app/core/utils/field-labels.ts`), y la
  unidad, en el descriptor (`FieldMeta.unit`, que `camposEfectivos` cambia a la moneda base en el
  modo «cantidad de moneda»).
- **El notificador no mira la longitud.**
  - `NotifierService` junta hasta doce líneas por chat en un único mensaje. Telegram rechaza los
    textos de más de 4096 caracteres y `TelegramClient.sendMessage` se traga el error.
  - Un lote con avisos más largos se perdería entero y en silencio. Ya puede pasar hoy con un error
    largo del venue, porque el motor no recorta sus mensajes.
- **La app pinta el mensaje de un evento en una sola línea**, tanto en la bitácora como en la
  cronología del bot. Un salto de línea se vería como un espacio.

### Qué puede modificar la IA: medido

Se hizo pasar `decidirCambio` por esta matriz, con el código de la rama del 053 (`e2924ff`):

- las cuatro estrategias cubiertas;
- los trece mercados reales de `VENUE_MARKETS`;
- capitales de 40, 300, 5000 y 60 000;
- tres regímenes de mercado: normal, calmado y en tendencia violenta;
- los tres perfiles;
- con y sin un tope de apalancamiento del usuario por debajo del que tenía el bot;
- tres juegos de perillas;
- el bot tal como sale del generador, y ajustado a mano;
- los veinte movimientos de una sola perilla.

En total, **374 640 decisiones y 241 717 propuestas**. Lo que cambia cada perilla, además de lo que
reparan los acoplamientos. La tabla la fija `alcance.spec.ts`; al escribirlo, el test destapó que
con poco capital el apalancamiento decide cuántas capas caben y, con ellas, la separación mínima
entre capas, que la exploración había contado como reparación:

| Estrategia | Perilla | Campos que puede mover |
|---|---|---|
| `MARKET_MAKER` | apalancamiento | `leverage`, `orderSizePerSide`, `maxBotPositionValue`; con poco capital, `layers` y `layerDistanceMultiplier` |
| | cobertura | `defensiveThresholdPct`, `highRiskThresholdPct`, `maxBotPositionValue` |
| | diferencial | `buyDistanceBps`, `sellDistanceBps`, `minAllowedDistanceBps`, `layerDistanceMultiplier` |
| | crecimiento | `layers`, `orderSizePerSide`, `layerSizeMultiplier`, `inventorySkewFactor`, `layerDistanceMultiplier` |
| | cadencia | `refreshSeconds` |
| `MARKET_MAKER_V2` | apalancamiento | `leverage`, `orderSizePerSide`, `maxBotPositionValue`; con poco capital, `layers` y `layerDistanceMultiplier` |
| | cobertura | `defensiveThresholdPct`, `highRiskThresholdPct`, `maxBotPositionValue` |
| | diferencial | `buyDistanceBps`, `sellDistanceBps`, `minAllowedDistanceBps`, `volatilityMultiplier`, `layerDistanceMultiplier`, `repriceThresholdBps`, `maxDynamicSpreadBps` |
| | crecimiento | `layers`, `orderSizePerSide`, `layerSizeMultiplier`, `layerDistanceMultiplier` |
| | cadencia | `refreshSeconds`, `orderMaxAgeSeconds`, `fillCooldownSeconds` |
| `TREND_FOLLOW` | apalancamiento | `leverage`, `maxNotionalCap` |
| | cobertura | `breakoutPeriod`, `entryEfficiency` |
| | diferencial | `atrStopMultiplier` |
| | crecimiento | `riskPerTradePct` |
| | cadencia | `stopRepriceBps` |
| `TRAILING_PROFIT` | apalancamiento | `leverage`, `maxNotionalCap` |
| | cobertura | `takeProfitPct` |
| | cadencia | `trailingCallbackPct`, `trailingRepriceBps` |
| | diferencial, crecimiento | nada |

**Acoplamientos.** Son reparaciones que llegan con cualquier perilla:

- en las cuatro estrategias, `leverage` baja hasta el menor de tres topes: el del usuario, el del
  venue y 18x;
- en los dos market makers, `minAllowedDistanceBps` baja hasta la menor de las distancias;
- en los dos market makers, `layerDistanceMultiplier` sube a 1,05 cuando hay varias capas.

**Lo que no cambió en ninguna de las 241 717 propuestas:**

- el capital, el par, la cuenta y la dirección;
- el perfil y todo lo que se deriva de él: `limitAction`, `riskProfile`, `behaviorPreset`,
  `autoAdjustDistance` y `useFullSizeUntilMax`. El generador emite también `allowShort`, pero
  la estrategia de tendencia no lo declara y la fusión no lo escribe nunca;
- el stop loss: ninguna perilla lo genera, y aunque lo hiciera solo podría estrecharse;
- la pérdida diaria máxima, los topes de inventario largo y corto, la fuente de precio, la
  activación y los campos COLD, como `candleInterval` o la `direction` de la tendencia;
- las constantes del generador: comisión, colchón, margen mínimo, margen del libro, muestra de
  volatilidad, `atrPeriod`, `postOnly`, `dynamicSpread`, `inventoryPriceAdjustment` y
  `activationMode`.

### Hallazgos de la revisión, que se reportan y NO se corrigen aquí

Los dos cambian lo que el supervisor aplica, así que su arreglo lo decide el usuario (constitución:
lo que no es Crítico va a un spec de seguimiento).

- **H-01** (Alta; Media en la práctica mientras `AI_AGENT_DRY_RUN_ONLY=true`, que es el valor de
  fábrica). **En un market maker V2, cualquier decisión de la IA rebaja la distancia mínima que
  fijó el dueño.**
  - **Por qué pasa.**
    - En la V2, una `minAllowedDistanceBps` por encima de las distancias base es una configuración
      legítima: el validador solo avisa («se elevarán hasta ahí») y el suelo compuesto hace lo que
      el dueño pidió.
    - `enforceCouplings`, que el supervisor aplica después del traslado, la «repara» bajándola hasta
      la menor distancia. Lo hace sin banda relativa y sin importar qué perilla se movió.
  - **Evidencia.** Un V2 con suelo de 20 bps y distancias de 10, válido, en cuatro mercados:
    - los ocho movimientos de un paso de cadencia, cobertura, crecimiento y apalancamiento proponen
      `minAllowedDistanceBps` de 20 a 10;
    - con «apalancamiento» es **el único cambio**;
    - el diferencial efectivo en calma baja de 20 a 16,5 bps.
  - **Qué promesas de la guía rompe.**
    - «Todo lo que el supervisor no mueva se queda exactamente como lo dejaste».
    - «Nunca mueve un parámetro más de un cuarto de su valor por escalón».
    - La guarda de posición no lo frena: el campo no está en `CAMPOS_DE_RIESGO`.
  - **Arreglo propuesto.** En `decidirCambio`, no aplicar a una V2 esa reparación. En la V1 sí
    hace falta, porque allí el validador la exige.
- **H-02** (Media; Baja mientras `AI_AGENT_DRY_RUN_ONLY=true`). **En un market maker V2, «diferencial
  más» puede estrechar el diferencial efectivo, y «diferencial menos», ensancharlo.**
  - **Por qué pasa.** El generador reparte el diferencial objetivo entre `buyDistanceBps` y
    `volatilityMultiplier`, que se mueven en sentidos contrarios. El traslado por campo del spec 052
    acota cada uno por su lado y no conserva la suma.
  - **Evidencia.** Se calculó el diferencial efectivo de la primera capa con `composeSpreadBps`,
    con el techo aplicado, sobre 16 050 propuestas.
    - A la volatilidad que supone el propio generador:
      - «más» estrecha en 2460 de 7944 casos (31 %);
      - «menos» ensancha en 1962 de 8106 (24 %).
    - En calma, que es lo que enseña `preview()`: «más» estrecha en 2144 casos y ensancha en 118.
    - La desviación es pequeña: el 90 % de las veces, menos de 1 bps; como mucho, 3 bps (un 26 %
      relativo).
    - Nunca baja del suelo por coste, que la estrategia aplica siempre.
  - **Arreglo propuesto**, a elegir:
    - (a) medir el diferencial efectivo antes y después, y descartar lo que no vaya en el sentido
      pedido;
    - (b) cambiar el traslado de la V2 para que la distancia base siga a la perilla.

**Observación O-1** (no es un defecto). Una perilla sin efecto puede producir una propuesta que
solo contiene la reparación del apalancamiento. Pasa con el diferencial o el crecimiento de un
seguimiento de beneficio, o con cualquier perilla ya en su extremo, cuando el bot está por encima
del tope del usuario.

- Es segura: baja el riesgo, y sin ella `assertWithinLimits` rechazaría cualquier cambio.
- Con los avisos de este spec se ve cuál es.

Los hallazgos H-03 y H-05 del 053 siguen pendientes y pasan a un spec propio posterior a este.

## Alcance

- **API.**
  - Un módulo puro, `supervisor/mensajes.ts`, que convierte `diff.changed` en líneas legibles:
    nombre, valor de antes → valor de después y unidad.
  - El módulo lleva el catálogo de nombres de los campos que el supervisor puede mover, copiado de
    la app, con un test que exige que digan lo mismo.
  - Lo usan `AI_SUGGESTION` y `AI_APPLIED`, tanto el automático como el que sigue a una aprobación
    desde Telegram.
- **API: `supervisor/alcance.spec.ts`.** Mide sobre mercados reales qué campos mueve cada perilla y
  falla si cambia algo fuera de la tabla de arriba.
- **Worker.** El notificador reparte un lote en mensajes que Telegram acepta y recorta una línea
  demasiado larga sin romper el HTML.
- **App.** Los mensajes de los eventos conservan sus saltos de línea.
- **Guías.** La tabla del alcance, los acoplamientos, los hallazgos y el formato nuevo de los avisos.

## Fuera de alcance

- Corregir H-01 y H-02: lo decide el usuario.
- Los textos de `AI_FAILED` y `AI_ADVICE`: no aplican ningún cambio.
- Guardar el diff estructurado en `bot_events.payload`, o pintarlo en la app con más detalle. La
  decisión ya guarda el suyo en `bot_ai_decisions.diff`.
- `packages/db`, `shared`, `strategy-core` y `exchange-core`. Del worker solo cambia el notificador.
- El contrato del modelo, el prompt y la traducción (`apply.ts`): no cambian.

## Requisitos

- **R-1** — `AI_SUGGESTION` dice:

  ```text
  El supervisor propone cambiar N parámetro(s) (perilla: movimiento[; …]):
  • Nombre: antes → después unidad      (una línea por campo)
  Motivo: …
  ```

- **R-2** — `AI_APPLIED` dice lo mismo con «El supervisor ha cambiado». Si el cambio llega tras
  aprobarlo desde Telegram:
  - dice «con tu aprobación»;
  - avisa de que los valores se recalcularon al aprobar;
  - los valores son los que de verdad se aplicaron.
- **R-3** — Cómo se escribe cada línea:
  - **Nombre.** En castellano, el mismo que enseña la app para ese `labelKey`. Una clave sin
    catálogo sale tal cual.
  - **Unidad.**
    - Sale del descriptor efectivo: en «cantidad de moneda», el tamaño va en la moneda base.
    - Nunca se repite: la unidad que el nombre lleva entre paréntesis sale del nombre.
    - `sec` se escribe `s`, y `x` va pegada a los dos valores.
    - Un porcentaje sin unidad declarada lleva `%`.
  - **Valores.**
    - Los booleanos, «sí» y «no»; el vacío, «—».
    - Los números, sin ceros de relleno y con punto decimal, como los avisos del motor.
- **R-4** — Cotas del aviso:
  - como mucho diez líneas de campos; si hay más, la última dice «… y N más»;
  - el motivo, en una sola línea;
  - el aviso entero cabe de sobra en un mensaje de Telegram.
- **R-5** — Ningún envío del notificador supera 4000 caracteres.
  - Un lote se reparte en varios mensajes, en orden y sin perder líneas.
  - Una línea más larga se recorta con «…» sin partir una entidad HTML ni un par sustituto.
  - Vale también para la sugerencia, que se manda sola con sus botones.
- **R-6** — La bitácora y la cronología del bot respetan los saltos de línea del mensaje, sin un
  byte más en `bot-detail.page.scss`, que está en el límite.
- **R-7** — El test de alcance, sobre mercados reales, con bots generados y ajustados a mano, con y
  sin tope de usuario:
  - todo campo que cambie una propuesta pertenece a la tabla de las perillas movidas o a los
    acoplamientos de su estrategia;
  - todo campo de la tabla se alcanza al menos una vez;
  - las perillas muertas no proponen nada salvo acoplamientos;
  - los nombres de todos los campos de la tabla están en el catálogo.
- **R-8** — Guías:
  - `docs/administracion.md` lleva la tabla (con nombres legibles), los acoplamientos, lo que nunca
    toca, los dos hallazgos y un ejemplo de aviso;
  - `docs/comandos-guardas-y-eventos.md` describe el contenido nuevo de `AI_SUGGESTION` y
    `AI_APPLIED`.

## Criterios de aceptación

- **CA-1** (R-1, R-3) — Un test del servicio en manual comprueba el mensaje de `AI_SUGGESTION`,
  tanto el publicado como el guardado:
  - lleva el nombre legible, los dos valores del diff con su unidad, la perilla y el motivo;
  - no lleva ninguna clave interna.
- **CA-2** (R-2) — En automático, `AI_APPLIED` lleva las mismas líneas.
  - Tras una aprobación, dice «con tu aprobación», y sus valores son los del diff recalculado que
    se guarda en la decisión.
- **CA-3** (R-3, R-4) — Tests del módulo puro:
  - unidades, incluida la moneda base en «cantidad de moneda»;
  - nombres con la unidad entre paréntesis;
  - booleanos, vacíos y números;
  - el corte a diez líneas;
  - el motivo con saltos de línea;
  - dos perillas;
  - una clave desconocida.
- **CA-4** (R-3) — Un test lee `field-labels.ts` de la app y exige que cada nombre del catálogo de
  la API diga exactamente lo mismo.
- **CA-5** (R-5) — Tests del notificador:
  - doce avisos de 900 caracteres salen en varios mensajes de 4000 como mucho, con las doce líneas
    en orden;
  - una línea de 10 000 caracteres sale recortada, sin una entidad partida;
  - una sugerencia larga sale recortada y con su teclado.
- **CA-6** (R-7) — El test de alcance pasa, y cae si:
  - se quita un campo de la tabla;
  - se quita un acoplamiento;
  - `buildConfig` pasa a mover un campo nuevo.
- **CA-7** (R-6) — `ng build` sin avisos de presupuesto, y la bitácora y la cronología con
  `pre-line`.
- **CA-8** — Deben quedar en verde:
  - `pnpm --filter api test`, `pnpm --filter api build` y `pnpm --filter worker test`;
  - `pnpm lint`, `ng build` y `pnpm check:env`;
  - las mutaciones de las piezas nuevas, que hacen caer algún test.
- **CA-9** — Comprobación manual del usuario:
  - una sugerencia real en Telegram se lee con sus valores;
  - al aprobarla llega el aviso con los valores aplicados;
  - la bitácora del bot enseña el aviso en varias líneas.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Los nombres de la API y de la app divergen | CA-4 lee el fichero de la app |
| Un aviso largo no llega | R-4 acota el aviso y R-5 reparte y recorta en el notificador |
| Un recorte rompe el HTML y Telegram rechaza el mensaje entero | El recorte retrocede antes de un `&` sin cerrar y de un sustituto alto |
| El test de alcance tarda | Matriz reducida y medida: unos 12 s, frente a los 20 de `apply.spec.ts` |
| Un campo nuevo del generador entra sin revisión | CA-6: el test de alcance cae y obliga a documentarlo |
| Se despliega el worker sin la API, o al revés | Son independientes: el notificador nuevo recorta cualquier mensaje, y la API nueva produce avisos que caben |
