# 058 — El motor determinista del canal y la estrategia `AI_CHANNEL`

Estado: `hecho` (falta CA-9 del usuario; sin merge ni despliegue) · Tipo: `cambio` · Rama:
`spec/058-canal-determinista` (sale de `spec/057-stops-velas-y-simulador`)

## Objetivo

Construir el bot de canales **sin el modelo**. Consta de cuatro piezas:
- un motor determinista que detecta un rango o un canal y calcula todos los números de una
  operación;
- una estrategia `AI_CHANNEL`, con un modo `REGLAS` que decide sola;
- el trabajo del worker para ejecutarla con apalancamiento alto;
- el backtest que permite validarla.

Estará hecho cuando se cumplan estas condiciones:
- un bot `AI_CHANNEL` en modo `REGLAS` opera de punta a punta contra el simulador;
- sus límites no se rompen en ningún caso probado;
- el walk-forward con el juez deja un informe por setup que el usuario revisa antes de poner
  dinero.

## Contexto

Es la segunda pieza del plan aprobado el 2026-09-17. Las otras tres son:
- **057:** los fallos previos.
- **059:** la IA, la app y las guías.
- **060:** la revisión.

La petición es un bot de «IA agresiva» con estas características:
- lee velas cortas;
- detecta laterales en zigzag o canales;
- opera futuros con apalancamiento alto sobre un capital fijo;
- la IA decide el apalancamiento, el tamaño, el stop y el objetivo con ayuda de una herramienta.

La investigación del plan fija cómo debe hacerse:
- **La probabilidad.** Un rebote en el borde acierta entre un 55 y un 68 %. La ventaja sale del
  beneficio asimétrico, de los costes bajos y del filtro de régimen.
- **Quién calcula.** Todo número lo calcula un motor determinista. La IA solo elige entre opciones
  ya calculadas y, si falla, no se abre nada.
- **El apalancamiento.** Sale del stop, y la liquidación queda siempre muy por detrás de él.

Decisiones del usuario que gobiernan este spec:
- **Uso.** Automático y con dinero real, solo para administradores.
- **Techo que nunca se pasa.**
  - pérdida de hasta el 2 % del capital por operación;
  - hasta el 6 % en el día, y entonces sin entradas hasta las 00:00 UTC;
  - apalancamiento de hasta el menor entre 25x y el máximo del par.
- **Venues.** Hyperliquid, Aster y Lighter.
- **Operaciones.** Por defecto solo el rebote en el borde. La ruptura fallida es opcional y va
  apagada, y la ruptura confirmada queda fuera.
- **Entradas.** Inmediatas con tope de precio (IOC). Sin decisión válida no hay entrada, y el modo
  `REGLAS` hay que elegirlo a mano.

El 057 dejó arreglado lo que este bot necesita:
- stops que no se recolocan;
- velas que solo son cerradas si lo estaban;
- un backtest que pasa velas;
- un simulador que respeta `reduceOnly`.

## Alcance

| Área | Qué |
|---|---|
| `shared` | `ia-canal.ts`: los tipos del canal, la decisión, el historial y los tramos. La regla de apalancamiento por stop en `liquidation.ts`. `StrategyKind.AI_CHANNEL` |
| `strategy-core` | `canal/`: estadística, velas, giros, canales, régimen, setups, costes, herramienta, tasas base, juez y análisis. `strategies/ai-channel.ts`. El contrato nuevo en `types.ts` y en `BotContext`/`DesiredState`. `validateCommon` con la regla por stop |
| `exchange-core` | `getLeverageTiers` en los tres venues, `setLeverage` con acuse, `expiresAt`, IOC en el simulador, `limitFill: TRADE_THROUGH` y la clasificación del «no casa» de Hyperliquid |
| worker | Las series, el tick al cierre de vela, el vigilante del stop, el apalancamiento por operación, las guardas propias, el historial, las intenciones, el candado de administrador, el interruptor global y el tope de bots por venue |
| `db` | Una migración: `AI_CHANNEL`, `bot_ai_intents`, `bot_ai_loops` y `bots.max_notional` |
| API | Acceso mínimo: fuera de los planes, del listado de estrategias y del asesor y el supervisor; solo un administrador lo crea o lo arranca. El backtest con calentamiento y ventanas consecutivas |
| backtest | Las series, el historial, los tramos y el juez en el contexto; el apalancamiento por operación; `TRADE_THROUGH`; métricas por setup |

## Fuera de alcance

- **La llamada al modelo y todo lo que la rodea (059):** el contrato, la herramienta renderizada, el
  consumidor de `BOT_AI_REQUESTS`, los cupos, los avisos, la app, las guías de usuario y la
  enmienda de las invariantes en `CLAUDE.md`. Aquí el modo `IA` deja la solicitud escrita y no
  opera.
- **Entradas en espera en el borde con bracket nativo, ruptura confirmada, IA que gestiona
  posiciones, calendario macro y velas de 10 minutos.** Van en specs posteriores.
- **Portar al fork OSS.** Se hará cuando se pida.

## Requisitos

- **R-1 — Series cerradas.**
  - La estrategia declara varias series, cada una con su intervalo y su número de velas.
  - El runner le entrega solo velas cerradas, topadas por el máximo del venue.
  - La vela de 5 minutos se decide en su cierre más unos segundos.
- **R-2 — Giros sin repintado.**
  - Los giros se confirman por cambio direccional de al menos 1,25·ATR(15m).
  - El resultado sobre un prefijo de la serie es el filtrado del resultado completo.
- **R-3 — Canales con puertas duras.**
  - **Horizontal:** por agrupación de giros.
  - **Inclinado:** por rectas paralelas.
  - **Puertas duras:** ≥ 2 toques por lado y alternados; ≥ 90 % de cierres dentro; anchura entre
    3 y 10 ATR y ≥ 10 veces el coste de ida y vuelta; ≥ 30 velas; ≥ 3 cruces de la media; media
    vida ≤ ¼ de la duración; último toque hace ≤ 48 velas.
  - **Puntuación:** de 0 a 100, con calidad A ≥ 75, B ≥ 60 y C ≥ 45.
- **R-4 — Régimen con histéresis.**
  - Clases: RANGO, TENDENCIA, COMPRESION o INDEFINIDO, sobre velas de 1 h.
  - Se confirma con CHOP(15m) > 50.
  - Tiene histéresis de 3 velas de 15 min y se recalcula en cada tick sin estado guardado.
- **R-5 — Setups.**
  - **REBOTE** exige estas confirmaciones: mecha de rechazo, RSI extremo, divergencia y volumen
    sin ruptura. Por defecto se piden 2.
  - **FALSO_QUIEBRE** es opcional.
  - Solo un setup `LISTO` es elegible.
- **R-6 — La herramienta.** Cada candidato lleva todos sus números:
  - la entrada IOC con su precio peor;
  - tres stops (AJUSTADO, NORMAL y AMPLIO);
  - dos objetivos (la media y el borde opuesto menos una holgura);
  - tres bandas de apalancamiento (BAJA, MEDIA y ALTA);
  - el tamaño;
  - R netos, el coste en R y el acierto de equilibrio;
  - la liquidación, el margen y la pérdida catastrófica.
  
  `construirOperacion(candidato, elección)` es la única vía de enums a números.
- **R-7 — Apalancamiento por stop.** Se sigue la fórmula del plan (`plan.md`, «La regla por stop»).
  Garantías:
  - la liquidación queda al menos a `max(liqBufferStops·s, 3·ATR(1h))`;
  - la pérdida al stop no pasa del riesgo pedido;
  - la pérdida catastrófica en un hueco no pasa de `maxMarginPct` del capital.
- **R-8 — Límites diarios.**
  - Días en UTC.
  - **Tope diario:** sin entradas hasta las 00:00 UTC, y se reanuda solo. Al 1,5× del tope, pausa
    con reanudación manual.
  - **Otros límites:** operaciones por día, racha de pérdidas con su espera, esperas tras stop y
    entre operaciones, objetivo diario, caída máxima y ventanas UTC sin entradas.
- **R-9 — Salidas deterministas.**
  - **Órdenes nativas:** stop, TP1 y TP2.
  - **Breakeven** tras el TP1.
  - **Cierre a mercado** por cualquiera de estos motivos:
    - tiempo máximo;
    - invalidación;
    - régimen en contra;
    - stop no ejecutado;
    - liquidación o apalancamiento del venue fuera de la regla.
  - Ninguna salida espera a la IA.
- **R-10 — El vigilante del stop.**
  - Tras una entrada se revisa cada pocos segundos hasta que el venue confirma el stop.
  - Sin stop confirmado a los 5 s (10 s en Lighter), se cierra a mercado y se avisa en CRITICAL.
- **R-11 — Apalancamiento por operación.**
  - El runner no sincroniza el apalancamiento al arrancar ni al recargar.
  - Antes de cada entrada, y solo en plano, fija el que pide el plan.
  - Si falla, no hay entrada.
- **R-12 — Intenciones.**
  - Cada decisión deja fila en `bot_ai_intents`, con estas transiciones: `SOLICITADA →
    CONSULTANDO → DECIDIDA → ACEPTADA → ABIERTA → CERRADA`.
  - Terminales: `SIN_ENTRADA`, `FALLIDA`, `RECHAZADA` y `CADUCADA`.
  - Una sola operación viva por bot, y no más de una solicitud por vela.
  - `ACEPTADA` se escribe **antes** de tocar el venue.
- **R-13 — Modo `REGLAS`.** El juez determinista decide sin la API y la fila queda con origen
  `REGLAS`.
- **R-14 — Acceso.** Solo lo usa un administrador:
  - fuera de los planes;
  - fuera del listado de estrategias hasta que la app lo soporte (059);
  - rechazado por el asesor y el supervisor;
  - creación y arranque solo por un administrador;
  - candado en el worker (`spawn`).
- **R-15 — Interruptor global y tope por venue.**
  - Una clave de Redis corta las entradas de todos los bots `AI_CHANNEL`; con Redis caído no hay
    entradas.
  - Lighter admite como mucho 2 bots por IP.
  - En Aster solo se opera con los tramos firmados leídos y en modo unidireccional.
- **R-16 — Backtest.**
  - Recibe series, historial, tramos y juez.
  - Aplica el apalancamiento por operación y los rellenos `TRADE_THROUGH`.
  - Calcula métricas por setup (n, aciertos, R medio, esperanza, factor de beneficio y Wilson).
  - Carga calentamiento previo y admite ventanas consecutivas.
  - Etiqueta igual que las tasas base.
- **R-17 — Invariante 1.** El dinero, las cantidades y los precios van siempre en `Decimal`. Las
  estadísticas adimensionales pueden ir en `number` (ADX, RSI, CHOP, percentiles, OLS, media vida,
  Wilson).

## Criterios de aceptación

- **CA-1** — Los módulos puros tienen tests contra cifras calculadas a mano. Además, tests de
  propiedad:
  - sin repintado;
  - sin mirar al futuro;
  - un fuzz de 10.000 casos en el que ningún límite se rompe, `dLiq ≥ 3·s` y ≥ 3·ATR(1h), y el stop
    queda siempre entre la entrada y la liquidación.
- **CA-2** — Un ejemplo trabajado exacto de `herramientaCanal`, cifra a cifra, en el test.
- **CA-3** — Rendimiento: `analizarMercado` por debajo de 20 ms y `tasasBase` por debajo de 50 ms,
  con las series por defecto.
- **CA-4** — La estrategia entra en todas las baterías genéricas sin excepciones nuevas, salvo las
  declaradas con su razón:
  - `strategies.spec`;
  - el asesor;
  - la matriz de venues;
  - los planes.
- **CA-5** — Tests del runner:
  - el orden `setLeverage` → `placeOrder`;
  - el vigilante del stop;
  - el tope diario, que no pausa;
  - el 1,5×, que sí pausa;
  - la regla de liquidación silenciosa a 25x;
  - el candado de administrador;
  - el interruptor global;
  - el tick al cierre de vela.
- **CA-6** — Un e2e sobre el simulador en modo `REGLAS`: entrada → SL/TP → TP1 → breakeven →
  cierre → espera, sin reutilizar la decisión.
- **CA-7** — Unas 18 mutaciones caen (ver `plan.md`).
- **CA-8** — La verificación completa en verde: `pnpm test`, `pnpm lint`, `check:env`, los builds
  de API, worker y app, `tsc` de la API y `prisma:deploy` sobre la base local.
- **CA-9** — *(usuario)* Walk-forward con el juez: 3 ventanas de 30 días en BTC, ETH y SOL, con el
  informe por setup, revisado antes de la primera sesión real.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un fallo del motor abre con 25x algo que no debía | Tres comprobaciones de cada límite (por construcción, tras la decisión y en el worker con datos frescos), un fuzz de 10.000 casos y mutaciones |
| La posición se queda sin stop | Stop nativo en el tick del llenado, vigilante que cierra a mercado y los arreglos del 057 |
| Un hueco más allá del stop | Margen aislado y `maxMarginPct`: la pérdida catastrófica queda acotada por construcción |
| El backtest miente a favor | Rellenos `TRADE_THROUGH`, sin mirar al futuro, triple barrera pesimista, walk-forward e intervalo de Wilson |
| Cualquiera puede crear el bot antes del 059 | Fuera de planes y listado, veto en la API y candado en el worker |
| El cupo de Lighter | Velas alineadas al cierre (unas 17 peticiones por hora por símbolo) y como mucho 2 bots por IP |
| La migración sobre bots en marcha | Solo añade tipos, tablas y una columna nula. Es hacia delante y no toca filas |
| Cambios en el runner que afecten a otras estrategias | Todo lo nuevo va detrás de los flags del contrato: una estrategia que no los declara no ve ningún cambio. Lo fija la batería completa del worker |

## Referencias oficiales

Consultadas el 2026-09-16 al implementar los adaptadores (fase 6), solo documentación pública:

- **Hyperliquid: `marginTables`.**
  - Fuente:
    <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-perpetuals-metadata-universe-and-margin-tables>.
  - Cita, título de la sección: «Retrieve perpetuals metadata (universe and margin tables)».
  - Cada activo apunta a su tabla con `marginTableId`.
  - El mantenimiento de cada tramo es la mitad del margen inicial a su apalancamiento máximo
    (<https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers>).
- **Hyperliquid: `updateLeverage`.**
  - Fuente:
    <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#update-leverage>.
  - La respuesta no trae cifras: el acuse repite lo pedido.
- **Aster: `leverageBracket`.**
  - Fuente:
    <https://raw.githubusercontent.com/asterdex/api-docs/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md>,
    sección «Notional and Leverage Brackets (USER_DATA)».
  - Cita: «``GET /fapi/v3/leverageBracket``», con `"initialLeverage": 75, // Max initial leverage
    for this bracket` y `"notionalCap": 10000, // Cap notional of this bracket`.
- **Lighter: `order_expiry`.**
  - Fuente: `lighter-go`,
    <https://raw.githubusercontent.com/elliottech/lighter-go/main/types/txtypes/constants.go>.
  - Cita: `MinOrderExpiryPeriod int64 = 1000 * 60 * 5 // 5 minutes` y
    `MaxOrderExpiryPeriod int64 = 1000 * 60 * 60 * 24 * 30 // 30 days`.
- **Lighter: la IOC va sin caducidad.**
  - Fuente:
    <https://raw.githubusercontent.com/elliottech/lighter-go/main/types/txtypes/create_order.go>.
  - Cita: `txInfo.TimeInForce == ImmediateOrCancel && txInfo.OrderExpiry != NilOrderExpiry` →
    `ErrOrderExpiryInvalid`.
- **Lighter: velas.**
  - Fuente: <https://apidocs.lighter.xyz/reference/candles.md>.
  - Cita: «Returns at most 500 candles per call».
- **Lighter: fracciones de margen.**
  - Llegan en el detalle de cada mercado: `min_initial_margin_fraction` y
    `maintenance_margin_fraction`, en diezmilésimas.
  - Están comprobadas en el adaptador (`lighter.ts`), sin una cita de la documentación.
  - Lighter no escalona por nocional: un solo tramo.
