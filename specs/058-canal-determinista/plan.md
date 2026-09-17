# 058 — Plan

## Enfoque

De dentro hacia fuera, como en el 040:

1. los tipos y la regla de apalancamiento;
2. los módulos puros del canal;
3. la estrategia y su registro, con los flags nuevos del contrato;
4. los adaptadores;
5. el worker;
6. la migración y el acceso mínimo;
7. el backtest.

Cada capa se prueba antes de la siguiente, y **todo lo nuevo del motor va detrás de un flag del
contrato**: una estrategia que no los declara no ve ningún cambio.

## Decisiones que conviene no deshacer

- **Estadística en `number`, dinero en `Decimal`.** La invariante 1 se aclara así:
  - los precios, cantidades e importes de las órdenes son `Decimal`;
  - los indicadores y las rectas (ADX, RSI, CHOP, bandas, OLS, media vida, percentiles, Wilson)
    son `number`.
  
  No es comodidad: con mil velas en `Decimal`, `analizarMercado` pasa de 200 ms, y el objetivo es
  menos de 20. Los niveles del canal cruzan la frontera **una vez**, con `D(nivel.toString())`, y
  pasan por `px()` antes de tocar una orden. El precedente es `MarketFeatures`.
- **El motor calcula y la IA elige.**
  - La herramienta ofrece opciones con todos sus números.
  - `construirOperacion(candidato, elección)` es la única forma de pasar de enums a una orden.
  - Una elección que no está en la oferta, o no está disponible, no produce nada.
- **Sin estado oculto.**
  - La histéresis del régimen se recalcula en cada tick sobre los prefijos de la serie.
  - Los giros se confirman con el ATR que había en su vela.
  - La operación viva vive en `cycle.scratch.op`, que se escribe **antes** de mandar la entrada.
- **La regla de liquidación por stop solo afecta a esta estrategia.**
  - `validateCommon` recibe `{ reglaLiquidacion: 'POR_STOP' }`.
  - El resto sigue con la regla del 5 %.
- **El modo IA de este spec no opera.** Deja la solicitud escrita y espera. El consumidor llega con
  el 059. Sin decisión válida no hay entrada, y ese es el comportamiento deseado.
- **`AI_CHANNEL` no usa `candles`, usa `series`.** La batería «solo Tendencia pide velas» sigue
  en verde, y se añade la hermana: «solo el canal pide series».

## El contrato nuevo

### `shared/bot.ts`

```ts
BotContext {
  …
  series?: Partial<Record<CandleInterval, Candle[]>>;  // solo si la estrategia declara `series`
  historial?: HistorialOperaciones;                     // día UTC, desde bot_cycles
  decisionIa?: DecisionIa | null;                        // la intención vigente del bot, si la hay
  nivelesApalancamiento?: NivelApalancamiento[];         // tramos del venue para el par
  limites?: LimitesExternos;                             // interruptor global, tope de la cuenta
}
DesiredState {
  …
  apalancamiento?: number;       // el runner lo fija ANTES de la entrada, solo en plano
  decision?: MarcaDecision;      // { intentId, estado: 'ACEPTADA' | 'RECHAZADA', motivo? }
  solicitudIa?: SolicitudIa;     // { barT, huella, snapshot } → fila SOLICITADA
  avisos?: AvisoEstrategia[];    // { tipo, severidad, mensaje, clave } → eventos, uno por clave
}
DesiredOrder.expiresAt?: number; PlaceOrderRequest.expiresAt?: number
```

### `strategy-core/types.ts`

```ts
series?: (config) => { interval: CandleInterval; bars: number }[];
apalancamientoPorOperacion?: boolean;   // sin syncLeverage al arrancar ni al recargar
reglaLiquidacion?: 'POR_STOP';          // validateCommon y RiskService
topeDiarioReanuda?: boolean;            // el guard diario del runner solo pausa al 1,5×
consumeDecisionesIa?: boolean;          // el runner carga y anota intenciones
nocionalMaximo?: (config) => string;    // → bots.max_notional
stopPropio?: boolean;                   // ya existe (057)
```

## La regla por stop (`shared/liquidation.ts`)

Llamamos `s` a la distancia del stop en tanto por uno de la entrada, y `mmr` a la tasa de
mantenimiento del tramo que corresponde al nocional `N`.

```
need  = max(liqBufferStops · s, 3 · ATR(1h) / precio)        liqBufferStops ≥ 3
Lstop = floor(1 / (mmr + need · (1 + mmr)))                  0 ⇒ inviable
Lmax  = min(Lstop, 25, cfg.leverage, tramo.maxLeverage(N), market.maxLeverage, usuario.maxLeverage)
```

**Por qué `(1 + mmr)`.** En aislado, un corto se liquida en `P = E·(1 + 1/L)/(1 + mmr)`, así que su
distancia es `d = (1/L − mmr)/(1 + mmr)`. Pedir `d ≥ need` da `1/L ≥ mmr + need·(1 + mmr)`. El
largo, `d = (1/L − mmr)/(1 − mmr)`, es siempre más holgado. Una sola fórmula cubre los dos lados.

```
R    = min(capital · riskPerTradePct/100,
           capital · (maxDailyLossPct − pérdidaHoyPct)/100 · 0,9)         R ≤ 0 ⇒ sin operación
unit = |entrada − stop| + entrada · taker + stop · (taker + deslizamiento)  pérdida por unidad al stop
N    = min(R / unit · entrada,
           capital · maxNotionalMultiple,
           capital · Lmax,
           maxNotionalCap si lo hay)
maxMargen = min(capital · maxMarginPct/100, saldoLibre · 0,9)
Lmin = ceil(N / maxMargen)          si Lmin > Lmax ⇒ N = Lmax · maxMargen y Lmin = Lmax
Bandas: BAJA = Lmin · MEDIA = round((Lmin + Lmax)/2) · ALTA = Lmax
```

**Qué cambia la banda y qué no.**
- **Cambia:** el margen inmovilizado (`N/L`), la distancia a la liquidación y la pérdida
  catastrófica en un hueco (`N/L`, acotada por `maxMarginPct`).
- **No cambia:** la pérdida al stop, que es la misma en las tres.

El `0,9` es el colchón: una operación solo arriesga el 90 % de lo que queda del tope diario. Deja
sitio a un deslizamiento peor que el estimado sin romper el tope.

## Los módulos del canal (`strategy-core/src/canal/`)

| Fichero | Qué | Notas |
|---|---|---|
| `numeros.ts` | `serieNumerica(velas)` → `Float64Array` por campo; `aDecimal(n)` | La frontera con el dinero |
| `estadistica.ts` | `sma`, `ema`, `rma`, `rsi`, `atrSerie`, `adx` (+DI/−DI), `chop`, `bollinger`, `anchoBanda`, `percentil`, `eficiencia`, `ols` (pendiente, ordenada, R², t), `mediaVidaOU`, `wilson` | Probadas contra cifras a mano |
| `velas.ts` | Reexporta `agregarVelas` (057); `ultimaCerradaEsperada(ahora, intervalo)`; `seriesFrescas(series, ahora)` | Una serie sin su última vela esperada no es fresca |
| `swings.ts` | `swingsConfirmados(serie, atr, θ)` por cambio direccional | Cada giro guarda su vela de confirmación. Propiedad: prefijo = filtrado |
| `canales.ts` | `canalHorizontal`, `canalInclinado`, `puertas`, `puntuar`, `invalidado`, `falsoQuiebre` | Ver abajo |
| `regimen.ts` | `regimenCrudo(1h, 15m)`, `regimen(series)` con histéresis | Sin estado |
| `setups.ts` | `setupsRebote`, `setupsFalsoQuiebre` | Solo `LISTO` es elegible |
| `costes.ts` | Comisiones y deslizamiento por venue, sobrescribibles | HL 1,5/4,5 bps · Aster 1/3,5 · Lighter 0/0 · deslizamiento 2 bps |
| `herramienta.ts` | `herramientaCanal(entrada)` → `SalidaHerramienta`; `construirOperacion` | Ver abajo |
| `tasas-base.ts` | `tasasBase(serie15m, parámetros)` | Triple barrera pesimista |
| `juez.ts` | `juezDeReglas(salida, cfg)` | El modo `REGLAS` y el backtest |
| `analisis.ts` | `analizarMercado(series, cfg)` con memoria acotada (LRU de 32) | La entrada de la estrategia |

### Giros (`swings.ts`)

- **La regla.** Cambio direccional sobre máximos y mínimos, con `θᵢ = 1,25 · ATR14ᵢ`, donde el ATR
  es el de la vela `i`, no el final.
  - En modo subida se sigue el máximo. Si una vela baja `θ` por debajo, se confirma el giro alto en
    el máximo (con su índice) y se pasa a bajada.
  - La bajada es el espejo.
  - Como mucho, una transición por vela.
- **La propiedad.** El resultado sobre un prefijo coincide con el resultado completo filtrado por
  `confirmadoEn ≤ k`.

### Canales (`canales.ts`)

- **Horizontal.** Agrupa giros altos a `eps = 0,25·ATR15` → resistencia (media del grupo); giros
  bajos → soporte. Se toma el grupo más reciente con ≥ 2 toques.
- **Inclinado.** OLS con **pendiente común** e intercepción propia para giros altos y bajos:
  - al menos 3 giros por lado;
  - R² ≥ 0,6 en cada lado;
  - la pendiente propia de cada lado a ≤ 25 % de la común.
- **Puertas duras (las dos formas).**
  - ≥ 2 toques por lado, alternados;
  - ≥ 90 % de los cierres de la ventana dentro de `[soporte − eps, resistencia + eps]`;
  - anchura entre 3 y 10 ATR15, y ≥ 10 veces el coste de ida y vuelta en precio;
  - ≥ 30 velas entre el primer toque y ahora;
  - ≥ 3 cruces de la línea media;
  - media vida OU del residuo a la media ≤ ¼ de la duración;
  - último toque hace ≤ 48 velas.
- **Puntuación (0-100).**
  - toques: 20;
  - contención: 20;
  - anchura en ATR, con el óptimo entre 4 y 7: 15;
  - media vida: 15;
  - alternancia: 10;
  - recencia: 10;
  - R² (solo inclinado; el horizontal suma 10 fijos): 10.
  
  Calidad: A ≥ 75 · B ≥ 60 · C ≥ 45 · por debajo, descartado.
- **Invalidación.** Un cierre de 15 min fuera del borde por más de `invalidationAtr·ATR15`.
- **Falso quiebre.**
  - Un cierre fuera, por menos de 1 ATR, en las 3 últimas velas de 15 min.
  - El último cierre vuelve a estar dentro.

### Régimen (`regimen.ts`)

- **Criterios, sobre 1 h cerrada:**
  - **a)** ADX14 < 20, y no sube respecto de hace 3 velas;
  - **b)** CHOP14 > 55;
  - **c)** percentil de la eficiencia (20) sobre la ventana ≤ 30;
  - **d)** percentil del ancho de Bollinger (20/2) entre 20 y 70, y ATR14/ATR96 entre 0,8 y 1,2.
- **Clases:**
  - **RANGO:** al menos 3 de los 4, y CHOP(15m) > 50.
  - **TENDENCIA:** ADX ≥ 25 y subiendo, o percentil de eficiencia ≥ 70. Sentido por +DI/−DI.
  - **COMPRESION:** percentil del ancho < 20 y ATR14/ATR96 < 0,8.
  - **INDEFINIDO:** el resto.
- **Histéresis.** Se calcula en las 3 últimas velas de 15 min cerradas. El régimen efectivo es el
  crudo solo si los 3 coinciden; si no, INDEFINIDO.

### Setups (`setups.ts`)

- **REBOTE largo.**
  - La última vela cerrada de 5 min toca la zona del soporte (`mínimo ≤ soporte + eps`) y cierra
    por encima de `soporte − 0,1·ATR15`.
  - El precio está en el tercio inferior del canal.
- **Confirmaciones.**
  - `MECHA`: mecha inferior ≥ 50 % del rango y cierre en la mitad alta.
  - `RSI`: RSI14(5m) ≤ 30 o RSI2 ≤ 10.
  - `DIVERGENCIA`: mínimo más bajo que el del toque anterior con RSI14 más alto.
  - `VOLUMEN`: volumen ≤ 1,5 × SMA20. Un toque sin clímax de volumen no es una ruptura.
- **Estados.** `LISTO` con al menos `minConfirmations`; `VIGILANDO` con menos.
- **REBOTE corto.** El espejo.
- **FALSO_QUIEBRE.** Ver canales. Su stop va más allá del extremo de la ruptura.

### Herramienta (`herramienta.ts`)

Para cada candidato y cada stop (AJUSTADO, NORMAL y AMPLIO, a 0,25, 0,5 y 1,0 ATR15 más allá del
extremo, más medio spread):

- **Entrada IOC.**
  - Precio de referencia: el ask en un largo, el bid en un corto.
  - Tope: `ref ± maxEntrySlippageR·|ref − stop|`, redondeado hacia el lado que no empeora.
    **Uno por candidato**, medido con el stop válido más cercano (ver «Decisiones de la fase 2»).
  - El tamaño se calcula con el tope: es el peor caso.
- **Stop.** Se redondea hacia la entrada. Con `s > maxStopPct`, la opción es inviable.
- **Objetivos.**
  - `TP1` en la media.
  - `TP2` en el borde opuesto menos `0,15·anchura`.
  - Los dos se redondean hacia la entrada.
- **Números de la operación.** Con la regla por stop: `N`, `qty`, `Lmin`, `Lmax` y las tres bandas.
  Con cada banda: margen, liquidación estimada y pérdida catastrófica.
- **R netos** a TP1 y a TP2:
  - la ganancia menos la comisión de entrada (taker) y la de salida (maker);
  - sobre `unit·qty`.
- **Coste en R.** Las dos comisiones más el deslizamiento, sobre el riesgo por unidad.
- **Acierto de equilibrio.** `1/(1 + R)`.
- **Esquemas de objetivos.**
  - `MEDIA`: todo a TP1.
  - `OPUESTO`: todo a TP2.
  - `ESCALONADO`: `tp1Fraction` a TP1 y el resto a TP2. Si una de las dos partes no llega al
    mínimo del venue, se funde en una.
- **Viable si se cumple todo esto:**
  - `R > 0`;
  - `Lmax ≥ 1`;
  - `qty` y `N` sobre los mínimos del venue;
  - `s ≤ maxStopPct`;
  - el R neto del objetivo más corto del esquema ≥ `minRewardRisk`.
  
  Si no, lleva su motivo.

`construirOperacion(candidato, { stop, objetivo, apalancamiento, tamano })` recalcula todo desde
el candidato. Con `tamano: MEDIO`, la mitad de `N`. Devuelve el `PlanOperacion`: entrada, stop,
objetivos, `qty`, `L` y la huella. Si algo no es viable, devuelve `null` con su motivo.

### Tasas base (`tasas-base.ts`)

- **Detección.** Cada 8 velas de 15 min se detecta el canal con los datos hasta esa vela.
- **Eventos.** Los toques de las 8 velas siguientes.
- **Etiqueta, con triple barrera:**
  - stop NORMAL, objetivo `TP1` y tiempo `maxHoldBars`;
  - si el stop y el objetivo caen en la misma vela, **cuenta como stop**;
  - al vencer el tiempo, se valora a mercado.
- **Salida.** `n`, aciertos, R medio, límite inferior de Wilson (95 %) y la evidencia:
  `INSUFICIENTE` con n < 20, `DEBIL` con n ≤ 60 y `MODERADA` con n > 60.

### Juez (`juez.ts`)

| Perfil | Stop | Banda | Objetivo por defecto (si `takeProfitSchemes = TODOS`) |
|---|---|---|---|
| PRUDENTE | AMPLIO | BAJA | MEDIA |
| EQUILIBRADA | NORMAL | MEDIA | ESCALONADO |
| AGRESIVA | AJUSTADO | ALTA | ESCALONADO |

- **Elección.** Entre los candidatos `LISTO` y viables, el de mejor calidad de canal y, a igualdad,
  el de mayor R neto.
- **Opción inviable.** Si la opción del perfil no lo es, se prueba la contigua en el sentido
  prudente. Si ninguna lo es, `NO_OPERAR`.

### Decisiones de la fase 2

Tomadas al implementar; cada una tiene su test o su mutación.

- **Un tope de IOC por candidato.** Si cada stop tuviera su tope, la operación del ajustado podría
  mandarse con el tope del amplio y perder más de lo calculado. El tope sale del stop válido más
  cercano a la referencia: ninguna opción admite más deslizamiento del pedido.
- **Tramos sin iterar.** El nocional se calcula en cada tramo con sus reglas y acotado a su rango, y
  se queda el mayor. Iterar «tramo del nocional → nocional del tramo» puede oscilar entre dos. Si el
  redondeo de la cantidad lo deja en un tramo anterior, ese es más permisivo: los números quedan del
  lado prudente.
- **Topes de cantidad.** La cantidad respeta `maxQty` y también `maxMarketQty`: el stop a mercado
  tiene que cerrar la posición entera de una vez.
- **Objetivos en `Decimal`.** Los niveles llegan como texto y se operan en `Decimal`; solo el
  desplazamiento de un inclinado es estadística. En coma flotante, `99.9 + 0.15·3` daba
  `100.35000000000001` y el objetivo acababa un tick más allá.
- **La liquidación que se enseña** se redondea hacia la entrada: nunca la estimación optimista.
- **Descartes.** Además de `CONFIRMACIONES` y `SIN_OPCION_VIABLE`:
  - `ESPERANZA_NEGATIVA`, con evidencia `MODERADA` y R medio negativo;
  - `EVIDENCIA`, si `requireEvidence` pide más de lo que hay.

  Solo es elegible (`esElegible`) un candidato `LISTO` y sin descartes.
- **`construirOperacion` vuelve a mirar la configuración** (dirección, setups, tipos de canal y
  esquemas): puede haber cambiado entre la oferta y la decisión.
- **Tasas base.**
  - Miden el TOQUE del borde, sin las confirmaciones del setup; con ellas habría muy pocos casos.
  - El falso quiebre manda sobre el rebote en la misma vela.
  - Como en vivo: un cierre fuera por un ATR o más acaba con el canal; uno fuera por más de la
    invalidación solo lo suspende en esa vela.
  - Un hueco más allá del stop sale a la apertura (peor que −1R). Lo que la serie no llega a
    resolver no cuenta.
  - Las etiquetas de un lado no se solapan.
- **Juez.**
  - Stops por perfil, hacia lo prudente: PRUDENTE [AMPLIO]; EQUILIBRADA [NORMAL, AMPLIO];
    AGRESIVA [AJUSTADO, NORMAL, AMPLIO].
  - Objetivos: PRUDENTE [MEDIA, ESCALONADO]; EQUILIBRADA [ESCALONADO, MEDIA]; AGRESIVA
    [ESCALONADO, MEDIA, OPUESTO]. Si la configuración deja un único esquema, ese es el de todos.
  - Entre candidatos manda el R (todos son del mismo canal: la calidad es la misma).
  - La confianza que emite es informativa: el modo `REGLAS` no filtra por ella.
- **Análisis.**
  - La parte que depende de las velas va en una caché LRU de 32; la herramienta se calcula en cada
    tick.
  - Las tasas solo se calculan si hay candidatos.
  - La puerta de costes del canal usa comisiones y deslizamiento sin el spread del momento; el
    spread tiene su propia puerta en `plan()`.
  - Con estructura de 5 min, el canal se busca en 5 min y su pendiente se pasa a vela de 15; el
    régimen y el ATR de los stops salen de velas de 15 construidas con las de 5.
- **Pendiente para la fase 3.** Un canal inclinado casi nunca convive con un régimen RANGO. La
  puerta 8 queda así: horizontal exige RANGO; inclinado admite también TENDENCIA si su sentido es el
  de la pendiente y el ADX no pasa de 40.

### Decisiones de la fase 3

- **El enum y el acceso a la app.**
  - `AI_CHANNEL` entra a la vez en `shared` y en el esquema de Prisma; la migración va en la fase 5.
  - `MAX_APALANCAMIENTO_POR_STOP` (25) vive en `shared`: lo usan la herramienta, `validateCommon`
    y el `RiskService`.
  - La app no compila sin la estrategia en su unión y en sus mapas exhaustivos. Por eso se adelanta
    del 059 lo mínimo: la etiqueta, la línea del selector, una primera versión de la guía y el
    filtro de la consola.
  - `AiChannelConfig` es una interfaz explícita, para que la guía tenga que documentar cada campo.
- **Puertas.**
  - Sin `historial` o sin `limites` no hay entradas: el motor tiene que darlos siempre, y el
    backtest también.
  - El spread se mide contra el ATR de 15 min: `spread ≤ maxSpreadFraction · ATR`.
  - La ventana antes del funding usa `ticker.nextFundingAt`. Hyperliquid no lo publica, y allí no
    aplica.
  - El funding en contra quita solo el lado que paga.
  - La vela de la decisión tiene que haber cerrado después de la última salida: una operación que
    abre y cierra dentro de una vela no la reutiliza.
- **Decisiones.**
  - `REGLAS`: una decisión por vela (`scratch.decididaEn`), con `intentId = reglas:<barT>`. Un
    `NO_OPERAR` del juez no deja fila.
  - `IA`: la solicitud vence al cierre de la vela más 60 s. Una decisión de otra vela o de otro
    ciclo no cuenta, y se pide de nuevo. Se rechaza por `PLAZO`, por `HUELLA` o por `OFERTA`
    (confianza por debajo de la pedida, `NO_OPERAR` o una elección que no está en la oferta).
  - `observeOnly`: la decisión se marca `RECHAZADA` con motivo `PUERTA` y lleva el plan, para que
    quede registrada con sus números.
- **La entrada enviada.**
  - Mientras la IOC es reciente (30 s) o sigue en el libro, se espera. Con una ejecución ya contada y
    la posición aún sin ver, hasta 5 min.
  - Si no se llenó, la intención pasa a `RECHAZADA(VENUE)` en su propio tick: un plan marca una sola
    intención. **El worker tiene que admitir `ACEPTADA → RECHAZADA`.**
  - Cada intento usa su propio `BASE#n` (`scratch.intentos`).
- **Con posición.**
  - Los tramos de salida se escalan con la mayor posición vista: un llenado parcial reparte los
    objetivos en la misma proporción.
  - Breakeven: `entrada · (1 ± (2·taker + deslizamiento))`, solo si mejora el stop y queda del lado
    bueno de la marca. Una vez puesto se guarda y no vuelve atrás.
  - Salidas, en este orden: tiempo; stop que no saltó (`0,5·s` más allá); liquidación del venue a
    menos de medio stop por detrás del stop; apalancamiento del venue mayor que el pedido;
    invalidación (el último cierre de 15 min posterior a la entrada; con estructura de 5 min, velas
    de 15 construidas con ellas); régimen en contra.
  - El cierre es `TAKE_PROFIT#500+k` a mercado, un intento cada 30 s y doce como mucho, con aviso
    CRITICAL al agotarse. Mientras se cierra, el stop sigue y los objetivos se retiran.
  - Posición huérfana: stop de emergencia a `maxStopPct` de la entrada y aviso CRITICAL; si el
    precio ya está más allá, cierre a mercado.
- **Pausas.** Al 1,5× del tope diario y con la caída máxima, las dos sobre el realizado del
  historial.

## La estrategia (`strategies/ai-channel.ts`)

### Series

| `structureInterval` | Series (cada una topada a `maxBarras − 3`) |
|---|---|
| 15m (por defecto) | 5m × 144 · 15m × 1000 · 1h × 480 |
| 5m | 5m × 1000 · 1h × 480 |

### `plan()` con posición

No necesita velas: todo sale de `scratch.op`.

1. **El stop.** Siempre el `STOP_LOSS#0` propio: MARKET con disparo, `reduceOnly` y la cantidad de
   la posición.
2. **Los objetivos.** `TAKE_PROFIT#0` y `#1`, límites `reduceOnly`, según el esquema. Si una parte
   no llega al mínimo, se funden.
3. **Breakeven.** Tras el TP1 (lo sabe `scratch.op.tp1Hecho`, por la cantidad de la posición), el
   stop pasa a la entrada más las comisiones. El stop nunca se amplía.
4. **Salidas deterministas.** Se cierra a mercado `reduceOnly` con `TAKE_PROFIT#500..511` (un
   índice por intento, con 30 s entre intentos) si pasa cualquiera de estas cosas:
   - el tiempo máximo (`maxHoldBars` velas de 15 min);
   - la invalidación;
   - el régimen a TENDENCIA contra la posición;
   - el precio pasado del stop en más de `0,5·s` (el stop no saltó);
   - una liquidación del venue más cerca que la regla, o un apalancamiento distinto del pedido.
5. **Posición huérfana.** Sin `scratch.op`, stop de emergencia a `maxStopPct` de la entrada y aviso
   CRITICAL.
6. **Nunca** se pide apalancamiento con posición.

### `plan()` en plano

Las puertas, en este orden (la primera que cierra se dice en la nota):

1. datos frescos;
2. tope diario;
3. objetivo del día;
4. operaciones del día y racha;
5. esperas;
6. ventanas UTC;
7. caída máxima;
8. régimen RANGO;
9. spread;
10. funding en contra y ventana previa al cobro;
11. `entriesEnabled` y el interruptor global;
12. decisión:
    - **`REGLAS`:** el juez.
    - **`IA`:** `ctx.decisionIa` validada. Cuenta que esté vigente, que sea de la misma vela y
      candidato, que el candidato siga `LISTO`, que la huella coincida, que los enums estén
      permitidos, que la dirección se admita, que sea viable y que no se haya usado.
    - **Sin decisión y con candidato:** `solicitudIa`.
13. `construirOperacion` → `BASE#n` LIMIT IOC al tope, con `apalancamiento: L` y
    `decision: ACEPTADA`, y `scratchPatch.op` guardado antes del venue.

**Ids de cliente.**
- `BASE#n`, donde `n` es el intento dentro del ciclo.
- No se declara `reusesOrderSlots`.
- Una operación usa como mucho 1 condicional y 3 límites: cabe en Lighter (30) y en Aster.

### Validación

- `marginMode` ISOLATED.
- `leverage` ≤ 25 y ≤ el máximo del par.
- `riskPerTradePct` ≤ 2.
- `maxDailyLossPct` ≤ 6 y ≥ `riskPerTradePct`.
- El capital debe dar para el mínimo del venue con el stop más ancho.
- Ventanas UTC bien formadas.
- Con `stopLossPct` fijado, solo un aviso (no se usa).
- `validateCommon` con la regla por stop.

### Vista previa

Presenta los límites en % y en USDC, el nocional máximo, la liquidación con el tope y el stop más
ancho que admite, y una operación de ejemplo marcada como estimación, con un ATR del 1 %.

## Parámetros (`meta.fields`)

La tabla completa, con valores por defecto, límites y mutabilidad, es la del plan aprobado. Todos
son HOT salvo:
- `totalInvestment`: WARM.
- `marginMode` y `structureInterval`: COLD.
- `direction`: HOT, porque solo decide las entradas nuevas.

Ningún campo lleva `reshapes`.

## Worker

- **Series.** El runner lee cada serie de `candleHistory` con un TTL por petición de
  `min(span, 15 min)`. El refresco al cierre del 057 hace el resto: unas 17 peticiones por hora por
  símbolo.
- **Tick al cierre.** Un temporizador alineado al cierre de 5 min, a los 6 s más un desfase por bot
  de hasta 2 s (ver las decisiones de la fase 7), que trae antes las velas y llama a
  `requestTick()`.
- **Vigilante del stop.**
  - Tras un llenado de entrada, se hacen ticks cada 3 s (8 s en Lighter) hasta ver el stop en el
    libro.
  - Si a los 5 s (10 s en Lighter) no está, se cierra a mercado y se avisa en CRITICAL
    (`SIN_STOP`).
- **Apalancamiento.**
  - Sin `syncLeverage` al arrancar ni al recargar.
  - Con `desired.apalancamiento` y en plano:
    1. se marca la intención;
    2. `setLeverage(L, ISOLATED)`;
    3. se relee la posición si el venue la informa;
    4. si algo falla, no hay entrada y la intención queda `RECHAZADA('VENUE')`.
- **Guardas.**
  - **Tope diario.** Con `topeDiarioReanuda`, la guarda diaria del runner solo pausa al 1,5× del
    tope. La estrategia bloquea las entradas antes.
  - **Liquidación.** Con `reglaLiquidacion`, el aviso de liquidación se mide contra la regla por
    stop (actúa a 2/3 del camino) y la acción por defecto es `CLOSE_ALL`.
- **Historial.** `historialOperaciones()` sale de `bot_cycles` con el día UTC: operaciones,
  resultado realizado, racha de pérdidas, último cierre y último stop.
- **Intenciones.**
  - `decisionVigente()` carga la última no terminal.
  - `anotarDecision()` escribe la transición con un UPDATE condicional por estado.
  - `solicitar()` inserta `SOLICITADA` con `UNIQUE(bot_id, bar_t, kind)` y publica
    `BOT_AI_REQUESTS`.
  - `EngineService` escucha `BOT_AI_INTENTS` → `requestTick`.
- **Caducidad de intenciones.**
  - Vence en `min(cierre + 60 s, siguiente cierre de 5 min)`.
  - Caduca al instante con un llenado, un comando, una recarga, una pausa o una reanudación.
- **Candado.** `spawn()` rechaza `AI_CHANNEL` si el dueño no es `ADMIN`, leído de la base.
- **Interruptor global.**
  - `crypton:ai-channel:entries` en Redis, leído en cada tick.
  - `off` o Redis caído → sin entradas.
- **Tope por venue.**
  - `AI_CHANNEL_MAX_BOTS_PER_VENUE`, con Lighter a 2 por defecto.
  - El worker no adopta más: el sobrante queda en ERROR con el motivo.
- **Aster.** Sin tramos firmados leídos, o en modo cobertura, sin entradas.

### Decisiones de la fase 7

- **Series y velas.**
  - `candleHistory(…, { ttlMs })`: el TTL se pide por lectura, y en una ventana compartida manda el
    más corto. Las series del canal piden el de su intervalo (5 min, 15 min, y 15 min para la de
    1 h). Con el minuto de siempre, el canal gastaba tres peticiones por minuto y par en traer
    velas cerradas, que no cambian: el cupo de Lighter no lo aguanta.
  - Cada serie se pide topada en lo que el venue sirve de una vez, menos 3 (Lighter: 500).
  - `candleWindow()` espera, como mucho 8 s, al refresco que ya esté en vuelo. Se llama **fuera del
    cerrojo**: dentro, un PANIC esperaría a la red.
- **El despertador del cierre.** A los **6 s** del cierre de 5 min, más un desfase fijo por bot de
  0 a 2 s (FNV-1a del id), y no a los 4 s del plan. El feed del 057 (F-03) no pide la vela recién
  cerrada hasta pasados 2 s más un desfase de hasta 3 s: a los 4 s el bot llegaba antes que su
  vela. Primero trae las series; luego pide el tick.
- **El vigilante del stop.**
  - «Confirmado» es lo que dice el venue: el stop está en el libro al empezar el tick, o su
    colocación tuvo acuse positivo en este tick.
  - Umbral: **5 s**, y **10 s en Lighter**. Allí el acuse de `sendTx` solo dice que la transacción
    está bien formada, y el stop aparece en el libro algo después; con su revisión cada 8 s, 5 s
    cerrarían en la primera que aún no lo viera.
  - Pasado el umbral: `SIN_STOP` en CRITICAL y cierre a mercado. Si el venue no acepta el cierre,
    `ACTION_FAILED` en CRITICAL y se reintenta en la revisión siguiente.
  - **Ticks de vigilancia** cada 3 s (HL, Aster; 5 s si el venue no está en la tabla) y 8 s
    (Lighter), solo mientras haya una entrada enviada sin posición o una posición sin stop
    confirmado.
  - El stop de una estrategia con apalancamiento por operación **no espera al mínimo** del venue
    (`ESPERANDO_MINIMO`, `RESTO_INCERRABLE`): sale, y si el venue lo rechaza, el vigilante cierra.
    Solo una orden imposible (cantidad o precio a cero) se queda sin mandar.
- **El orden antes de una entrada** (`aplicarCanal`), siempre antes de hablar con el venue:
  1. `pausar` → `pauseForRisk` y el tick termina sin tocar el libro.
  2. Los avisos, una vez por clave mientras sigan; si una clave desaparece y vuelve, avisa otra vez.
  3. La solicitud a la IA (`solicitar`).
  4. La marca de la intención (`anotar`). Si la base dice que no, la entrada sale del plan. Si la
     escritura **falla**, el tick muere y no sale nada.
  5. Solo con la posición **plana** (una desconocida no cuenta como plana): `setLeverage(L)`.
- **El acuse del apalancamiento.**
  - Otro apalancamiento → sin entrada.
  - `null` (Lighter) → se entra. La posición lo dice después, y la salida por «apalancamiento del
    venue mayor que el pedido» ya existe.
  - `maxNotional` (Aster) por debajo del nocional de la entrada → sin entrada.
  - `AUTH` y `THROTTLED` se relanzan, como en `place()`: una credencial muerta suelta el bot, no se
    queda en un descarte. Cualquier otro error → sin entrada.
- **Descartar una entrada.**
  - `scratch.op` pasa a `null`: el tick siguiente no espera un llenado que no llegará.
  - La intención aceptada pasa a `RECHAZADA` con su motivo y sin plan.
  - `AI_ENTRY_DISCARDED` en WARN.
  - Un worker sin almacén de intenciones no abre nada: no hay entrada sin constancia.
- **La vida de una intención en el runner.**
  - `abrir()`, una vez por intención, en cuanto hay posición.
  - `cerrar()` cuando una ejecución cierra el ciclo.
  - `caducarPendientes()` (`SOLICITADA`, `CONSULTANDO`, `DECIDIDA` → `CADUCADA` con `ESTADO`) ante
    cualquier ejecución, comando, recarga, pausa o reanudación.
  - Una `ACEPTADA` no se caduca: su IOC se resuelve sola, y si no llega a llenarse, la estrategia
    la rechaza (`VENUE`) pasados 30 s (5 min si ya consta alguna ejecución). Mientras, el índice
    único parcial no deja abrir otra.
- **Comandos.**
  - `CANCEL_ALL_ORDERS` pide un tick en el acto (si el bot no está pausado): el stop propio vuelve
    al libro sin esperar al latido.
  - `ADJUST_MARGIN` con `REMOVE` se rechaza con apalancamiento por operación: acercaría la
    liquidación al stop calculado. `ADD` sí.
  - `REANCHOR_NO_APLICA` incluye `AI_CHANNEL`.
- **Guardas.**
  - Liquidación por stop: se mide el **camino** entrada → liquidación. A 2/3, `LIQUIDATION_NEAR`
    en CRITICAL (con el enfriamiento de siempre) y `liquidationAction`, `CLOSE_ALL` por defecto
    (`ALERT` solo avisa). Por debajo, silencio: el aviso por porcentaje no se usa.
  - Tope diario con `topeDiarioReanuda`: la guarda del runner solo pausa a 1,5 veces.
- **`place()`.** Una fila `EXPIRED` cuenta como muerta, igual que `CANCELED` y `REJECTED`, y su id
  se puede volver a mandar. `expiresAt` viaja a `PlaceOrderRequest` cuando la orden lo trae.
- **`BotStore`.**
  - `historialOperaciones()`: de los ciclos **cerrados**, con el día UTC.
    - La racha son las últimas pérdidas seguidas, entre los 50 cierres más recientes. Un cero no es
      pérdida.
    - El último stop es la última ejecución de una orden `STOP_LOSS`.
    - El total y su pico (máximo de la suma acumulada, nunca negativo) salen en una sola consulta.
    - Caché de 20 s; se invalida al cerrar un ciclo y al cambiar de día.
  - `setMaxNotional()` solo escribe si cambia, y trata el nulo aparte: en SQL, `NOT` no incluye
    los nulos.
  - `totalNotionalOfUser()` usa `max_notional` si lo hay.
  - `confirmOrder()` cierra la fila con un acuse `CANCELED` o `EXPIRED` (la IOC sin ejecutar);
    `syncOrderState()`, con `EXPIRED` o `REJECTED`.
- **`AiIntentStore`.**
  - `vigente()`: la última intención de entrada, en cualquier estado; la estrategia decide si le
    sirve.
  - `solicitar()`: crea `SOLICITADA`. Si la vela ya tiene la suya (`P2002`), devuelve `false`. Si
    no, publica en `BOT_AI_REQUESTS` sin esperar a que llegue: la API también sondea.
  - `anotar(ACEPTADA)`:
    - de la IA, un UPDATE condicional desde `DECIDIDA` que debe tocar una fila;
    - de reglas, un INSERT con id `reglas:<bot>:<vela>`, que vence a los 6 min de la vela.
  - `anotar(RECHAZADA)`: UPDATE desde `DECIDIDA` o `ACEPTADA`. Si no hay fila y es de reglas con
    plan (solo observar), se crea como constancia.
  - `P2002` en cualquier escritura (el índice parcial «una viva por bot») → `false`.
  - `eleccionDe()` valida el JSON guardado contra los enums; lo que no encaja se lee como «sin
    elección».
- **`EngineService`.**
  - **Candado.** Rol y `disabled` leídos de la base, en `spawn()`, para las estrategias de solo
    administradores, antes de tocar la red.
  - **Tope por venue.** Cuenta los runners reales vivos del canal más los arranques en curso de
    otros bots; los simulados no cuentan. La reserva se suelta en un `finally`. El bot que no cabe
    queda en `ERROR` con el motivo.
  - **Interruptor.** Se lee con un plazo de 1 s: con Redis caído, el cliente encola en vez de
    fallar, y el tick esperaría dentro del cerrojo. `off` —en cualquier caja, con o sin comillas
    JSON— cierra; la clave ausente deja abierto.
  - `BOT_AI_INTENTS` → `pedirTick()` del bot del mensaje, y de ningún otro.
  - `anotarNocional()` al adoptar y al recargar; un fallo solo se avisa.
- **`AccountHandle`.** Devuelve el acuse de `setLeverage` (e invalida lo leído del símbolo, como
  siempre) y reexpone `getLeverageTiers` y `getPositionMode` solo si el adaptador los tiene.
- **API.** `bots.max_notional` se escribe al crear y al editar, con la configuración que queda.
  `currentTotalNotional()` lo usa. `BUS_CHANNELS` gana `BOT_AI_REQUESTS` y `BOT_AI_INTENTS` en los
  dos procesos, y `shared` exporta `CLAVE_INTERRUPTOR_CANAL`.
- **Entorno.** `AI_CHANNEL_MAX_BOTS_PER_VENUE` (`LIGHTER=2`) en el `.env.example` del worker, en
  el de docker y en el compose.
- **Para el 059.**
  - La API escribe el interruptor: `off` u `"off"`.
  - Publica en `BOT_AI_INTENTS` tras decidir.
  - Consume `BOT_AI_REQUESTS` y sondea por si un aviso se pierde.
- **Tests.** Runner del canal, e2e en modo `REGLAS` sobre el simulador (entrada → stop y objetivos
  → primer objetivo → breakeven → cierre → espera, sin reutilizar la vela), motor, store,
  intenciones, velas, `AccountHandle` y API.
- **Mutaciones.** 123, en el worker y en lo que toca de la API. Caen las 123 (con las previstas 13
  a 18 de la lista). A la primera cayeron 116. Las siete que sobrevivieron eran tests que faltaban,
  y ahora existen:
  - tras pausar, el tick debe terminar: si siguiera, marcaría la intención y fijaría el
    apalancamiento, y el test solo miraba las órdenes;
  - la memoria del modo de posición;
  - una fila `EXPIRED` que bloquea su id;
  - el cierre de ciclo que olvida el historial;
  - las tres formas de cerrar una fila muerta en `confirmOrder` y `syncOrderState`.

## exchange-core

- **`getLeverageTiers?(symbol)`** → `NivelApalancamiento[]`, ordenado por nocional.
  - **HL:** `marginTables` de `meta`, que ya viene en `metaAndAssetCtxs`. Mantenimiento
    `1/(2·maxLev)` por tramo.
  - **Aster:** `GET /fapi/v3/leverageBracket` firmado.
  - **Lighter:** un tramo, con las fracciones del mercado.
- **`setLeverage`.** Devuelve un acuse opcional `{ leverage, maxNotional? }`. La firma sigue
  aceptando `void`.
- **`expiresAt`.**
  - **Lighter:** `order_expiry`.
  - **Aster:** GTD si la documentación lo confirma.
  - **HL:** lo ignora y lo dice su comentario.
- **Simulador.**
  - Una límite IOC casa en el acto contra el libro o se cancela: nunca descansa.
  - `limitFill: 'TRADE_THROUGH'` solo casa una límite en reposo si el precio la **cruza**, no si
    solo la toca.
- **Hyperliquid.** «Could not immediately match» → acuse `CANCELED`, no error.

### Decisiones de la fase 6

- **Acuse del apalancamiento.** `AcuseApalancamiento = { leverage: number | null; maxNotional? }`.
  - **HL:** repite lo pedido. `updateLeverage` es atómico, no contesta cifras y el SDK lanza ante
    cualquier error.
  - **Aster:** lo que contesta el venue (`leverage`, `maxNotionalValue`). Si falta el campo, `null`:
    un eco de lo pedido lo haría pasar por confirmado.
  - **Lighter:** `null`. Un 200 de `sendTx` solo dice que la transacción está bien formada.
    **La fase 7 lo confirma en la posición tras el llenado**; la salida por «apalancamiento del
    venue mayor que el pedido» ya existe.
  - **Simulador:** lo pedido.
- **Tramos.**
  - **HL:** llegan con el catálogo (`metaAndAssetCtxs`), sin otra petición. Sin tabla para el
    activo, un tramo con su máximo. Ningún tramo pasa del máximo del activo.
  - **Aster:** `GET /fapi/v3/leverageBracket` firmado, la ruta de la documentación V3.
    - Diez minutos de memoria por símbolo; un fallo no se recuerda.
    - Sin tramos válidos se lanza: una lista vacía parecería «sin límites».
  - **Lighter:** un tramo con la ficha del mercado. El venue no escalona por nocional.
  - **Simulador:** los de la fuente.
    - Si la fuente no los declara, o no puede firmarlos (Aster en simulado), un tramo con la
      ficha: otra estimación optimista, anotada en la cabecera del simulador.
    - Una caída del venue se propaga.
- **`expiresAt`.**
  - **Lighter:** `order_expiry` en milisegundos, acotado entre ahora + 5,5 min y ahora + 28 días.
    El mínimo del venue es de 5 min (`MinOrderExpiryPeriod`).
  - **Aster:** no se manda. La API V3 no tiene GTD: sus vigencias son GTC, IOC, FOK, GTX y HIDDEN.
  - **HL:** no se manda. Su `expiresAfter` caduca la acción firmada, no la orden.
  - **Simulador:** la orden sale del libro al vencer, con el precio siguiente o al pedir el libro,
    y se avisa como `EXPIRED`.
- **La límite IOC en cada venue.**
  - **HL:** «could not immediately match» → acuse `CANCELED` sin id, solo para la límite. Una
    MARKET que no se ejecuta sigue siendo un error.
  - **Aster:** `newOrderRespType=RESULT`, para que el acuse traiga el estado final (`FILLED` o
    `EXPIRED`). `EXPIRED` puede llevar una parte ejecutada; manda la posición.
  - **Lighter:** sin caducidad (`0`). Su acuse sigue siendo `PENDING`; el resultado llega por el
    sondeo y el canal de cuenta.
    - **Hallazgo (latente, corregido aquí con su test).** El firmante de Lighter rechaza una límite
      IOC con caducidad (`lighter-go`, `types/txtypes/create_order.go`, desde su primera versión),
      y se mandaba con la de 28 días desde 001/F-16. Ninguna límite IOC podía entrar en Lighter.
      Hasta este spec no la pedía nadie.
  - **Simulador:** casa contra el libro del momento (la compra con el ask, la venta con el bid).
    - Como taker, con el deslizamiento en contra y nunca peor que su límite.
    - Si no llega, `CANCELED`, sin pasar por el libro.
    - FOK igual: sin profundidad, todo se ejecuta entero.
    - Respeta `reduceOnly`.
- **`TRADE_THROUGH`.** Una límite en reposo solo se ejecuta si el precio la pasa (compra:
  ask < precio; venta: bid > precio). No toca a las condicionales ni a las IOC.
- **Modo de posición.** `getPositionMode?()`, para que la fase 7 no entre en una cuenta de Aster
  en cobertura.
  - **Aster:** `GET /fapi/v3/positionSide/dual`, firmado. Una respuesta sin el campo lanza: no se
    da por unidireccional.
  - **Simulador:** siempre unidireccional.
  - **HL y Lighter:** no lo declaran; solo tienen posición neta, y quien no lo declara se trata
    como unidireccional.
- **Para la fase 7.**
  - El acuse de una IOC sin ejecutar es `CANCELED` (HL, simulador) o `EXPIRED` (Aster).
    `confirmOrder` guarda el estado, pero no `closed_at`.
  - En Lighter el acuse es `PENDING`.
  - `AccountHandle` tiene que devolver el acuse y reexponer `getLeverageTiers` y
    `getPositionMode`.
- **Mutaciones.** 45, en `exchange-core`: las 45 caen.

## Base de datos (una migración)

- `StrategyKind` gana `AI_CHANNEL` (con su espejo en `shared/enums.ts`).
- `enum AiIntentState`.
- **`bot_ai_intents`:**
  - columnas: `id`, `bot_id`, `bar_t` (timestamptz), `kind` (varchar 16), `origen` (varchar 8),
    `estado`, `candidato_id`, `huella`, `snapshot` (Json?), `decision` (Json?), `plan` (Json?),
    `motivo`, `expires_at`, `cycle_seq`, `modelo`, `prompt_version`, `latencia_ms`, `coste`
    (Decimal?), `created_at` y `updated_at`;
  - `UNIQUE(bot_id, bar_t, kind)`;
  - índice `(estado, expires_at)`;
  - índice único parcial de una operación viva por bot, en SQL crudo (`ACEPTADA`, `ABIERTA`).
- **`bot_ai_loops`:** `bot_id`, `fallos`, `pausado_hasta`, `ultimo_error`, `llamadas_hoy`, `dia` y
  `coste_hoy`.
- **`bots.max_notional`:** Decimal? (nulo en los bots de siempre).
## API (acceso mínimo)

- **`shared`:** `ESTRATEGIAS_SOLO_ADMIN = [AI_CHANNEL]`, la lista que consultan todas las puertas.
- **`bots.service`:**
  - `strategiesMeta()` las oculta;
  - `create` y `START` las rechazan (403) si el dueño no es `ADMIN`, leído de la base.
- **Asesor y supervisor.** Rechazo explícito con constante; sus baterías la excluyen con su razón.
- **`risk.service`.** Con `reglaLiquidacion: 'POR_STOP'`, el tope de apalancamiento es 25 y no el
  del 5 %.
- **Backtest.**
  - Carga el calentamiento: las series anteriores al inicio.
  - Avisa de que la IA se sustituye por el juez.
  - Añade `ventanasConsecutivas`.

## Backtest

- **Contexto.** `series` agregadas con `agregarVelas` (desde la serie reproducida y el
  calentamiento), `historial` llevado en memoria, `nivelesApalancamiento` de la ficha y un
  `decisor` (el juez).
- **Apalancamiento.** En plano se honra con `sim.setLeverage` antes de colocar.
- **Rellenos.** `limitFill: 'TRADE_THROUGH'` para `AI_CHANNEL`.
- **Registro por operación.** Setup, R y salida. Además, `metricasPorSetup`.
- **Coherencia.** Un test fija que el backtest y `tasasBase` etiquetan igual.

### Decisiones de la fase 8

- **El decisor.** El contrato gana `Strategy.sinIa?(config)`: la estrategia dice cómo decidir sin
  IA. El canal pasa a `decisionMode: 'REGLAS'`, con el mismo perfil. El replay lo usa con
  `consumeDecisionesIa` y avisa de que el resultado mide la herramienta y las reglas, no al modelo.
- **Las series.**
  - Se construyen con `agregarVelas` desde las velas reproducidas más el calentamiento, que va en
    el MISMO intervalo. Así, agregar a 15 min y a 1 h no deja huecos en la frontera.
  - Al planificar solo entran las velas cerradas. La vela reproducida cuenta como cerrada, como ya
    hacía `candles`: se planifica al final de ella.
  - Cada serie va topada en `maxBars − 3` del venue, como en el worker.
  - Las velas del calentamiento que se solapan con el rango se ignoran.
  - «Calentamiento corto» se avisa una vez por serie.
- **El resto del contexto.**
  - El historial se lleva en memoria, como `BotStore`: día UTC, ciclos cerrados, racha entre los 50
    últimos y el último stop por su ejecución.
  - Tramos: uno solo, de la ficha, con el mantenimiento del SIMULADOR, para que la regla por stop
    mida lo mismo que se liquida.
  - Límites abiertos y `decisionIa` nula.
- **Lo que el motor hace por el canal.**
  - El apalancamiento se fija en plano justo antes de colocar la entrada. Con posición, las entradas
    salen del plan.
  - `timeInForce` y `expiresAt` viajan al simulador: sin ellos, la entrada IOC se quedaba en el
    libro. Solo el canal usa `timeInForce`.
  - El stop no espera al mínimo del venue, salvo uno imposible.
  - `pausar` detiene el replay con su aviso.
  - Los avisos cuentan una vez por clave y se resumen en uno.
- **Reaccionar a las ejecuciones.**
  - Tras cualquier ejecución, dentro de la vela o al cerrarla, se vuelve a planificar en el mismo
    instante, hasta tres veces. El stop y los objetivos de una entrada están en el libro desde el
    precio siguiente, y el breakeven tras el primer objetivo también. Sin esto, la posición pasaba
    una vela entera sin stop.
  - Después, el vigilante: una posición sin `STOP_LOSS` en el libro se cierra a mercado
    (`TAKE_PROFIT#999`) y se cuenta en los avisos.
- **Medirse como las tasas base.** El test de coherencia lo fija:
  - `limitFill: 'TRADE_THROUGH'` en el simulador;
  - con posición, la vela se recorre primero hacia el stop, sea cual sea `barPath`
    (`tickPath(…, adversoPara)`);
  - un hueco que salta el stop sale a la apertura: antes del primer precio de la vela, el stop se
    recoloca con el disparo en la apertura;
  - **`etiquetarTripleBarrera` exige PASAR el objetivo**, como `TRADE_THROUGH`. Es un cambio en el
    módulo de la fase 2, con su test.
  - El test compara cada operación del replay con su etiqueta: entrada real, stop y un único
    objetivo (`MEDIA`), con la barrera de tiempo en velas de 5 min (`maxHoldBars × 3`). Coinciden el
    resultado y la vela de salida en todas. El R difiere como mucho 0,06, porque el replay divide
    por el riesgo planeado; el umbral del test es 0,1.
- **El registro.**
  - Cada operación cerrada da una `BacktestOperacionView`: setup, lado, horas, precios, stop,
    objetivos, apalancamiento, riesgo, resultado en USDC y en R, R planeado y salida (`OBJETIVO`,
    `STOP`, `CIERRE`, `LIQUIDACION`).
  - La que sigue abierta al final no cuenta, y se avisa.
  - `metricasPorSetup`, por setup y lado: n, aciertos (resultado > 0), Wilson, R medio, esperanza en
    USDC, factor de beneficio (nulo sin pérdidas) y resultado.
  - `ventanasConsecutivas`: N tramos iguales, cada operación en el tramo donde CERRÓ.
- **API.**
  - Calentamiento: (velas de la serie más larga + 1) × su intervalo, en velas reproducidas (481 h
    para el canal). Se descarga con la misma caché y no cuenta en `MAX_BARS`.
  - Una estrategia cuyas series no salen del intervalo pedido recibe un 400 antes de descargar:
    el canal se reproduce en 5 min.
  - `ventanasConsecutivas` (1-6) entra en el DTO.
  - El resultado lleva `operaciones` (≤ 1000), `porSetup` y `ventanas`. Se guardan dentro del JSON
    de `metrics`, sin migración.
  - La paginación se corta en la primera página vacía: un par listado hace menos de unos 20 días
    se queda sin calentamiento, y el replay avisa.
- **Rendimiento.** Treinta días en 5 min (8640 velas) con calentamiento tardan unos 10 s sobre
  `dist` (~1,2 ms por vela): cabe bajo el interceptor de 80 s.
- **Walk-forward (CA-9).** Tres peticiones de 30 días por par, una por ventana (8640 velas cada una,
  dentro de `MAX_BARS`). Dentro de cada una, `ventanasConsecutivas` enseña si el resultado se
  sostiene.
- **Lo que no cambia.** El atajo de `planificar` durante la espera entre ciclos ya existía para todas
  las estrategias y se queda. En el canal solo deja más tiempo en el libro objetivos de solo
  reducción, que sin posición no se pueden ejecutar.
- **Mutaciones.** 53, en el replay, el recorrido, las cifras, las tasas base y la API del backtest.
  Caen las 53.
  - A la primera cayeron 45. Cuatro no compilaban y se reescribieron.
  - Las otras eran tests que faltaban, y ahora existen:
    - el segundo cierre del historial;
    - un aviso que se repite mientras dura (el tope del día);
    - la liquidación por hueco;
    - una condicional que no es el stop, que la apertura no debe tocar.
  - Una más resultó equivalente y destapó una condición redundante en `serieImposible`, que se
    quitó: un intervalo más fino que el paso nunca tiene resto cero.

## Fases

| Fase | Qué | Salida |
|---|---|---|
| 0 | Rama, spec, línea base | Verde |
| 1 | `shared`: tipos, regla por stop y enum | Tests a mano |
| 2 | `canal/`: los módulos puros | Tests a mano y de propiedad; rendimiento |
| 3 | Estrategia, contrato y registro; `validateCommon` | Baterías genéricas |
| 4 | Acceso mínimo: planes, asesor, supervisor, API y semilla | Baterías de la API |
| 5 | Migración | `prisma:deploy` local |
| 6 | exchange-core: tramos, `setLeverage`, `expiresAt`, simulador IOC y `TRADE_THROUGH` | Tests de adaptadores |
| 7 | Worker | Tests del runner y e2e sobre el simulador |
| 8 | Backtest y API del backtest | Tests; walk-forward listo para el usuario |
| 9 | Verificación, mutaciones y cierre | CA-1 a CA-8 |

## Cómo se hace el walk-forward (CA-9, lo hace el usuario)

La app no enseña `AI_CHANNEL` hasta el 059, así que va por la API (Swagger o `curl`), con una
cuenta de administrador:

1. **Un bot simulado por par.** `POST /bots` con `strategy: AI_CHANNEL`, `dryRun: true`, `symbol`
   `BTC`, `ETH` o `SOL`, una conexión de Hyperliquid y la configuración por defecto (por ejemplo,
   la de `defaults()` con `totalInvestment`). No hace falta arrancarlo.
2. **Tres ventanas de 30 días por bot.** `POST /backtests` con `source: BINANCE`,
   `interval: '5m'` y `fromMs`/`toMs` de 30 días seguidos: una petición por ventana, porque cada una
   son 8640 velas y el tope es 10 000. Con `ventanasConsecutivas: 3`, cada petición parte además su
   mes en tres tramos de 10 días.
3. **Lo que hay que mirar**, por setup y lado (`porSetup`) y por tramo (`ventanas`):
   - `n`: con menos de 20 operaciones no se puede concluir nada;
   - `wilsonInferior` frente al acierto que hace falta para el R medio;
   - `rMedio` y `esperanza`;
   - `factorBeneficio`;
   - que el resultado no dependa de un solo tramo.
   La lista `operaciones` dice cómo salió cada una: `OBJETIVO`, `STOP` o `CIERRE`.
4. **Los avisos del resultado** dicen qué no se reproduce: decide el juez y no la IA, sin funding y
   sin las guardas del motor.

## Mutaciones previstas

1. `liqBufferStops` forzado a 1.
2. `ceil` en vez de `floor` en `Lstop`.
3. Redondeo del stop hacia fuera.
4. Redondeo de la entrada IOC hacia el lado malo.
5. Sin comisiones en `unit`.
6. Sin el tope diario en `R`.
7. Giro sin confirmar: el índice de confirmación como índice del giro.
8. Cubo en formación en las series.
9. Histéresis de 1.
10. Sin comprobar la vigencia de la decisión.
11. Sin comprobar la huella.
12. `reduceOnly` falso en los objetivos.
13. `setLeverage` después de la entrada.
14. `syncLeverage` al arrancar.
15. El vigilante no cierra.
16. El 1,5× pausa al 1×.
17. El candado de administrador abierto.
18. El interruptor global ignorado con Redis caído.

## Verificación

```bash
pnpm build:packages
pnpm test:strategies · pnpm test:adapters · pnpm --filter worker test · pnpm test:backtest
pnpm --filter api test · pnpm lint · pnpm check:env
pnpm --filter api build · pnpm --filter worker build · pnpm --filter app build
(cd apps/api && pnpm exec tsc --noEmit -p tsconfig.json)
pnpm prisma:deploy     # local, hacia delante
```

## Cierre (fase 9)

**Mutaciones previstas.** Caen las 18. Dónde cayó cada una:

| # | Mutación | Fase |
|---|---|---|
| 1 | `liqBufferStops` a 1 | 2 |
| 2 | `ceil` en `Lstop` | 9 (con un test nuevo para el tope con decimales) |
| 3 | Stop redondeado hacia fuera | 2 |
| 4 | Tope de la IOC hacia el lado malo | 9 |
| 5 | Sin comisiones en `unit` | 2 |
| 6 | Sin el tope diario en `R` | 2 |
| 7 | Giro sin confirmar | 9 |
| 8 | Cubo en formación en las series | 8 (replay) |
| 9 | Histéresis de 1 | 9 |
| 10 | Sin comprobar la vigencia | 3 |
| 11 | Sin comprobar la huella | 3 |
| 12 | `reduceOnly` falso en los objetivos | 3 |
| 13-18 | Apalancamiento, vigilante, 1,5×, candado e interruptor | 7 |

En total, contando las previstas: 18 del motor (fase 2), 20 de la estrategia (fase 3), 45 de
`exchange-core` (fase 6), 123 del worker (fase 7), 53 del backtest (fase 8) y 5 del cierre.

**Los tiempos de CA-3**, medidos sobre `dist`:
- `analizarMercado` con mil velas de 15 min y un setup (tasas base incluidas): 4,1 ms en un
  análisis nuevo y 0,24 ms en uno guardado.
- `tasasBase` con mil velas: 2,7 ms.

Los tests de tiempo de jest pasan a umbrales de 60, 5 y 150 ms. Con `pnpm test` corriendo todos los
paquetes a la vez, el mejor de diez llegó a 21,7 ms frente a los 20 de antes. Bajo jest solo cazan
un algoritmo que se dispara; el tiempo real es el de `dist`.

**Criterios de aceptación:**

| CA | Estado |
|---|---|
| CA-1 | Hecho: tests a mano, sin repintado (prefijos), sin mirar al futuro (tasas base y replay) y fuzz de 10.000 casos |
| CA-2 | Hecho: el ejemplo trabajado de `herramientaCanal`, cifra a cifra |
| CA-3 | Hecho: 4,1 ms y 2,7 ms sobre `dist` |
| CA-4 | Hecho: las baterías genéricas con sus excepciones declaradas |
| CA-5 | Hecho: los tests del runner (fase 7) |
| CA-6 | Hecho: el e2e en modo `REGLAS`, con la espera y sin reutilizar la vela |
| CA-7 | Hecho: las 18 previstas caen |
| CA-8 | Hecho: `pnpm test`, `pnpm lint` (la API con sus 3 avisos de siempre), `check:env`, los builds de API, worker y app, `tsc` de la API y del worker, y `prisma migrate status` sobre la base local («Database schema is up to date») |
| CA-9 | **Pendiente del usuario**: el walk-forward de arriba, antes de la primera sesión real |

**Tests al cerrar:**

| Paquete | Tests |
|---|---|
| shared | 133 |
| strategy-core | 742 |
| exchange-core | 481 |
| worker | 519 |
| backtest | 64 |
| API | 5815 |

**Sin merge, sin push y sin desplegar.**
- La rama sale de la del 057, que espera la aprobación del usuario para su merge y su despliegue.
- El orden de despliegue del plan: migración → worker → API → app.
- Hasta el 059, nadie ve la estrategia en la app, y solo un administrador puede crearla por la API.
