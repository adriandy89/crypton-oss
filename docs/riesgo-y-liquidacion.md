# Riesgo y liquidación — cómo se mide y qué hace el motor

> Código: [`liquidation.ts`](../packages/shared/src/liquidation.ts) (la fórmula), [`risk.ts`](../apps/app/src/app/core/utils/risk.ts) (el semáforo de la app), [`risk.service.ts`](../apps/api/src/modules/risk/risk.service.ts) (los límites de tu cuenta) y `checkRiskGuards()` en [`bot-runner.ts`](../apps/worker/src/engine/bot-runner.ts) (las guardas que corren en cada revisión).
> Las guías de estrategia enlazan aquí. Léelo entero una vez; después basta con volver a la tabla que necesites.

---

## 1. Las cuatro cifras que importan

| Cifra | Qué es | Dónde la ves |
|---|---|---|
| **Capital asignado** (`totalInvestment`) | El **margen** que el bot puede usar. No sale de tu cuenta ni se transfiere a ningún sitio: es el techo que el bot se autoimpone al repartir sus órdenes. | Formulario del bot · tarjeta del bot |
| **Notional** (exposición) | Cantidad × precio. Con apalancamiento `L`, una escalera completa mueve **capital × L** de notional. | Vista previa («Exposición total») · resumen del bot |
| **Peor caso** | Todos los niveles ejecutados: notional, margen consumido, precio medio resultante y liquidación estimada. | Vista previa, antes de crear el bot |
| **Distancia a liquidación** | Cuánto puede moverse el precio **en contra** antes de que el exchange cierre la posición por ti. En %. | Vista previa · lista de bots · cartera · detalle · gráfico (el mismo número en todas) |

Regla que hay que interiorizar: **el apalancamiento no cambia cuánto pones, cambia cuánto pierdes por cada
punto que el precio se mueve en contra, y acerca la liquidación**. Dos bots con 500 USDC de capital, uno a
1× y otro a 5×, arriesgan los mismos 500 USDC; el segundo los pierde con una caída cinco veces menor.

---

## 2. La fórmula de la liquidación (estimada)

Antes de que exista posición, la app y la API estiman la liquidación con la fórmula de una posición
**aislada** ([`liquidation.ts:23-37`](../packages/shared/src/liquidation.ts)):

```
LARGO : liquidación ≈ precio_medio × (1 − 1/apalancamiento + 0,005)
CORTO : liquidación ≈ precio_medio × (1 + 1/apalancamiento − mmr)

distancia ≈ 1/apalancamiento − mmr          (en fracción; × 100 para el %)
```

`mmr` es la **tasa de margen de mantenimiento del mercado**: la mitad del margen inicial a su
apalancamiento máximo (BTC a 40× en Hyperliquid → 1,25 %; ETH a 25× → 2 %; DOGE a 10× → 5 %). Lighter
publica la suya y la ficha del mercado la trae. Traducido a una tabla, con BTC en Hyperliquid (1,25 %):

| Apalancamiento | Distancia estimada a la liquidación | Lectura |
|---|---|---|
| 1× | ≈ 98,8 % | En la práctica, sin liquidación: el precio tendría que irse a cero |
| 2× | ≈ 48,8 % | El precio tiene que moverse a la mitad |
| 3× | ≈ 32,1 % | |
| 5× | ≈ 18,8 % | Ya es una caída «normal» de una altcoin en una semana mala |
| 10× | ≈ 8,8 % | Un día volátil |
| 16× | ≈ 5,0 % | El **máximo que la API acepta en BTC** (ver §4) |
| 17× | ≈ 4,6 % | La API lo rechaza |

> ⚠️ **Sigue siendo una estimación.** El exchange aplica una escala de margen de mantenimiento **por
> tramos**: cuanto mayor es la posición, mayor la tasa; la ficha usa el tramo más bajo. Por eso la app
> etiqueta el número como «estimación» y **en cuanto hay posición abierta manda el precio de liquidación
> que devuelve el venue**, no este.

Cuando el bot ya tiene posición, todas las pantallas enseñan la distancia calculada por la API una sola
vez con el precio de liquidación **real** del exchange y el precio de marca del último snapshot.

---

## 3. Aislado frente a cruzado

| Modo de margen | Qué respalda la posición | Liquidación | Riesgo para los otros bots |
|---|---|---|---|
| **Aislado** (`ISOLATED`) | Solo el margen de esta posición | Llega **antes** | Ninguno: lo máximo que pierde este bot es su margen |
| **Cruzado** (`CROSS`) | Toda la caja libre de la cuenta, repartida entre las posiciones abiertas en proporción a su notional | Llega **más lejos** | Una posición perdedora **arrastra el saldo de los demás bots de esa cuenta** |

El modo es ❄️ **en frío**: no se puede cambiar con el bot creado. Ojo con los valores de fábrica:
**Rejilla neutral, Market Maker y Market Maker V2 vienen en cruzado**; las otras cuatro en aislado. La vista
previa te lo recuerda: en cruzado avisa de que la liquidación estimada es una **cota** (la real depende del
saldo de toda la cuenta y de las demás posiciones), y en la rejilla neutral enseña la liquidación del lado
largo y, en un aviso, la del lado corto.

---

## 4. El semáforo y la regla del 5 %

La distancia a liquidación se pinta igual en las cuatro pantallas ([`risk.ts:14-16`](../apps/app/src/app/core/utils/risk.ts)):

| Distancia | Color | Qué significa |
|---|---|---|
| **≥ 25 %** | 🟢 verde | Cómodo. Un movimiento diario normal no te acerca. |
| **10 % – 25 %** | 🟡 ámbar | Vigila. Una vela mala te deja en rojo. |
| **< 10 %** | 🔴 rojo | Peligro. Es el umbral por defecto del aviso `LIQUIDATION_NEAR`. |
| sin dato | gris | Sin posición, o el venue no ha devuelto precio de liquidación. |

La barra **satura al 40 %**: por encima de eso la distancia deja de ser información y la barra sale llena.

**La regla del 5 %.** Al crear o editar un bot, la API calcula la distancia estimada con la fórmula de §2
y **rechaza la configuración si queda por debajo del 5 %** ([`risk.service.ts:86-93`](../apps/api/src/modules/risk/risk.service.ts)):

> «A 17× la liquidación estimada llega con menos del 5 % de movimiento adverso en BTC: el máximo aquí es 16×.»

El tope depende de la tasa de mantenimiento del par: 16× en BTC de Hyperliquid (1,25 %), 14× en ETH
(2 %), 10× en DOGE (5 %). El formulario aplica **la misma regla con la misma tasa** y te dice el tope de
ese mercado antes de crear el bot; la API la repite al guardar. No es un fallo del formulario: es la red
de la cuenta.

**Recomendación de la casa:** 1× o 2× en todo lo que retenga inventario (rejillas, DCA, escaleras) y
nunca por encima de 3× en las estrategias que promedian a la baja (la propia app avisa en el DCA
temporizado por encima de 3×; en Martingala y GridMart rechaza la escalera si cubre más recorrido que la
distancia a la liquidación).

---

## 5. Los límites de tu cuenta

En la pantalla **Riesgo** (`/risk`) fijas los topes que valen para **todos** tus bots. Se crean con
valores de fábrica la primera vez que entras; ninguno admite cero («cero» no significa «sin límite»,
significa que la plataforma se apaga, y por eso está prohibido).

| Límite | Qué corta | Cuándo se comprueba |
|---|---|---|
| Apalancamiento máximo | Ningún bot puede crearse ni **seguir corriendo** por encima | Al crear, al editar y **en cada revisión** del bot (un bot viejo con apalancamiento por encima del tope nuevo se pausa) |
| Notional máximo por bot | `capital × apalancamiento` al crear; la posición viva en cada revisión | Creación y revisión |
| Notional máximo total | La suma de todos tus bots | Creación y cada minuto en la revisión |
| Bots abiertos máximos | Cuántos pueden estar arrancados a la vez | Al arrancar |
| Pérdida diaria máxima (USDC) | PnL realizado **de todos tus bots** en el día | Al arrancar y en cada revisión |
| Kill-switch por pérdida acumulada (%) | Pérdida acumulada del bot sobre su capital asignado | Cada revisión |
| Aviso de liquidación (%) · por defecto **10** | A qué distancia salta `LIQUIDATION_NEAR` | Cada revisión |

Y el **kill-switch global** (`POST /risk/kill-switch`, el botón rojo de la pantalla): marca **todos** tus
bots para parar y cerrar; el worker, que es quien tiene las claves, cancela y cierra. Es el único
comando con alcance de cuenta: los comandos de un bot nunca tocan las órdenes de otro.

---

## 6. Las guardas del motor, revisión a revisión

El motor revisa cada bot **cada 15 segundos** y antes de planificar nada evalúa estas guardas
(`checkRiskGuards`, [`bot-runner.ts`](../apps/worker/src/engine/bot-runner.ts)). Si una salta, el bot
**se pausa, no se cierra**: cerrar realizaría la pérdida al instante y en el peor momento; pausar detiene
el sangrado y te deja la decisión.

| Guarda | Condición | Qué hace |
|---|---|---|
| Apalancamiento | El del bot supera tu límite. Se mira **haya posición o no**. | Pausa |
| Notional por bot | `|posición| × marca` supera tu límite por bot | Pausa |
| Notional total | La suma de tus bots supera tu límite total | Pausa |
| **Liquidación cerca** | Distancia al precio de liquidación **del venue** < «Aviso de liquidación» (10 %) | Evento CRITICAL (con enfriamiento de unos minutos) y, según **Al acercarse la liquidación**: **Solo avisar** (defecto) no toca nada · **Pausar el bot** pausa · **Cerrar todo** cierra a mercado |
| Kill-switch por pérdida acumulada | `pérdida acumulada del bot / capital asignado ≥ %` | Pausa |
| Pérdida diaria de la cuenta | PnL realizado de hoy de todos tus bots < −límite | Pausa |
| Pérdida diaria del bot (%) | `stopLoss diario` del propio bot sobre su capital | Pausa |
| Colocaciones fallidas | 20 fallos pasajeros seguidos al colocar órdenes | Pausa |
| Revisiones fallidas | 5 errores seguidos en el ciclo del motor (algo más de un minuto) | Pausa |
| Precio externo desfasado | El bot cotiza contra Binance y lleva > 15 s sin dato | La estrategia deja de cotizar; aviso `FAIR_PRICE_STALE` |

**Qué significa «pausa» aquí** (`pauseForRisk`): el bot deja de planificar, **cancela sus órdenes
manteniendo el stop-loss** (a partir de ese momento el stop es la única defensa de la posición), pasa a
`PAUSADO` con el motivo, y escribe un evento **CRITICAL** `RISK_GUARD_TRIPPED` que termina con una de
estas tres coletillas:

- «El stop loss sigue vivo en el exchange.»
- «Atención: la posición queda SIN stop loss.» (no configuraste `stopLossPct`)
- «Atención: hay un stop loss configurado pero NO consta colocado en el exchange. Revísalo.»

Un bot pausado sigue latiendo: mira su posición y avisa de la liquidación, pero no toca el libro.

> ℹ️ **Semántica fijada (F-11, 2026-09-06).** El kill-switch del bot mide la **pérdida acumulada sobre el
> capital asignado**, no la caída desde el máximo: es un tope de pérdida absoluta, y así se rotula en la
> app («Pérdida acumulada que pausa el bot»). La pérdida diaria de la cuenta y la del bot cortan el día a
> la misma medianoche, la de tu zona horaria.

---

## 7. El stop-loss

Si rellenas **Stop loss (%)**, el motor —no la estrategia— añade al plan una orden **condicional nativa
del exchange** (`withStopLoss`, [`stop-loss.ts`](../packages/strategy-core/src/stop-loss.ts)):

- Se calcula sobre el **precio medio real** de la posición, en la dirección del **signo de la posición**
  (no de la dirección declarada: un market maker o una rejilla neutral cambian de lado solos).
- Se redondea **un tick hacia la entrada**: salta antes, nunca después.
- Es `reduceOnly` sobre la posición entera y vive **en el exchange**: se dispara aunque la plataforma
  esté caída.
- Sobrevive a `PAUSE`, `STOP_KEEP_POSITION`, «Recentrar la retícula» y a todas las pausas por guarda.
  Lo cancela `CANCEL_ALL_ORDERS`; `STOP_AND_CLOSE` y `PANIC` lo cancelan **solo después de que el cierre
  haya salido**: si el exchange no acepta el cierre, el stop se queda, el bot pasa a pausado y lo dice en
  CRITICAL.
- Si el exchange lo **rechaza**, el evento es CRITICAL una vez por forma de orden y el motor lo
  reintenta en cada revisión (no entra en cuarentena como el resto de órdenes). Un fallo **pasajero** al
  colocarlo (un corte de red) se reintenta en el mismo instante y, si tampoco sale, es CRITICAL.
- Su tamaño mínimo se mide sobre la **posición al precio de marca**, no al precio de disparo: un stop al
  −10 % de una posición de 10,5 USDC cabe aunque al disparo valiera 9,45.
- La API rechaza un `stopLossPct` fuera de (0, 100) y una pérdida diaria máxima no positiva, igual que el
  formulario.
- En el simulador es una condicional en reposo que se dispara con el precio de marca, igual que en un
  venue real.

**Dónde ponerlo.** En las escaleras (Martingala, GridMart), **por debajo del último escalón**: si lo
pones por encima, cierra el ciclo antes de haber terminado de promediar. En una rejilla, por debajo del
precio inferior del rango. En un DCA, donde estés dispuesto a reconocer que la tesis falló.

Al recolocarse (cambió la posición o la media) se cancela el viejo y se pone el nuevo; la ventana entre
ambos dura una llamada al venue. Ponerlo **antes** de cancelar exigiría un id distinto por encarnación
del stop y queda para un spec posterior.

---

## 8. El peor caso de cada estrategia

Lo que la vista previa llama «peor caso» es **todos los niveles ejecutados**. Cómo se calcula en cada una:

| Estrategia | Peor caso (notional) | Margen en el peor caso | Lo que hay que saber |
|---|---|---|---|
| Rejilla clásica | **capital × apalancamiento** (todas las líneas compradas) | capital | La vista previa cuenta **todas** las líneas: basta con que el precio suba por encima del rango y lo recorra entero hacia abajo. |
| Rejilla neutral | capital × apalancamiento en **un** lado (largo si cae, corto si sube) | capital | `Exposición máxima` es el freno que corta antes. |
| DCA temporizado | `importe × compras máximas × apalancamiento` | `importe × compras máximas` (≤ capital, la app lo exige) | Un DCA que dura días paga **funding** todo ese tiempo (§9). |
| Martingala | Σ de los escalones = **capital × apalancamiento** | capital | `Tope de exposición` corta la escalera en el escalón en que se alcanza. El último escalón suele ser el mayor de todos. |
| GridMart | Igual que Martingala | capital | La rejilla de ventas no añade exposición: vende trozos de lo comprado. |
| Market Maker (V1 y V2) | **Valor máximo de la posición**, en cualquiera de los dos sentidos | Ese valor ÷ apalancamiento | `capital asignado` **no** dimensiona nada aquí: solo es el denominador de la pérdida diaria. |
| Tendencia | `riesgo por operación / (multiplicador × ATR)` en cantidad, **acotado** por `capital × apalancamiento`, el margen disponible y el `Tope de exposición` | Ese notional ÷ apalancamiento | Lo que se arriesga **no** es el notional: es el `riesgo por operación`, porque el stop está puesto desde el primer momento. Si el tope recorta, se arriesga **menos** de lo declarado y la nota del bot lo dice. |
| Seguimiento de beneficio | **capital × apalancamiento** en una sola posición, acotado por el margen disponible y el `Tope de exposición` | capital | No hay escalera: la posición entera existe desde el primer minuto. Y hasta llegar al objetivo la única red es el `stop loss`, que por eso viene puesto de fábrica (5 %). Al cerrarse **vuelve a abrir** pasada la espera. |

---

## 9. Lo que ninguna pantalla te enseña: el funding

Los perpetuos cobran o pagan **financiación** de forma periódica (cada hora o cada ocho horas, según el
venue) a quien mantiene posición abierta. **La plataforma no lo modela ni lo muestra en ninguna parte**:
ni en el preview, ni en el PnL del bot, ni en el backtest (que lo declara en sus avisos de fidelidad).
En posiciones que duran días —un DCA en marcha, una escalera agotada esperando el rebote, una rejilla
con inventario— puede ser el mayor componente del resultado.

**Hasta que se modele:** mira la tasa de financiación del par en la web del exchange antes de dejar un
bot con inventario varios días, y cuenta con ella al fijar el take profit.
Estado: sin spec que lo modele; anotado en `specs/001-revision-integral/findings.md` § F-94.

---

## 10. Limitaciones conocidas de este capítulo

| Id | Qué | Hasta que se corrija |
|---|---|---|
| F-11 | Kill-switch = pérdida acumulada, no caída desde máximo (decisión de producto pendiente) | Trátalo como tope absoluto |

El spec `009-protecciones-y-cierre` (septiembre de 2026) corrigió el orden de «Parar y cerrar» (F-33),
la recolocación del stop (F-35), el mínimo al disparo (F-91), la acotación de `stopLossPct` y
`maxDailyLossPct` en la API (parte de F-13) y dos fallos de contabilidad de órdenes (F-36, F-37). El spec
`019-validacion-y-parametros-muertos` cerró el resto de F-13 (la API acota lo que el formulario acota), la
tasa de mantenimiento por mercado (F-93), el tope de apalancamiento explicado (F-44), el doble cómputo del
propio bot al editarlo (F-42) y la medianoche de la pérdida diaria (F-43).
