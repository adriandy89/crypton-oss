# Rejilla neutral (Neutral Grid) — guía completa

> Estrategia `NEUTRAL_GRID` · riesgo **MEDIO**.
> Código: [`neutral-grid.ts`](../packages/strategy-core/src/strategies/neutral-grid.ts) · pesos en `geometricWeights()` de [`ladder.ts`](../packages/strategy-core/src/ladder.ts) · guía in-app en [`neutral-grid.guide.ts`](../apps/app/src/app/core/content/neutral-grid.guide.ts).
> Si no conoces la [rejilla clásica](./grid-classic.md), empieza por ella: esta es su versión a dos lados, y es la que más limitaciones abiertas tiene de las cinco.

---

## 1. Qué es esto, en cristiano

Eliges un **precio ancla** y un rango a su alrededor. El bot reparte las líneas por todo el rango y
**cuelga compras en las que quedan por debajo del precio y ventas en las que quedan por encima**, desde el
primer momento y sin esperar a tener inventario. Cada compra ejecutada te deja más largo; cada venta, más
corto. En el centro del rango la posición neta ronda cero: el ancla es **el precio en el que el bot
considera que tu posición debería ser cero**.

Los niveles no pesan todos igual: con el **multiplicador de tamaño** los más lejanos al ancla mueven más
dinero, para que las entradas fuertes ocurran en los extremos y la posición tienda a revertir a cero cerca
del centro.

### El riesgo, dicho claro

El precio **rompe en tendencia**. Al alejarse del ancla la posición neta crece en su contra —largo si cae,
corto si sube— y **no vuelve sola**. Sin **Exposición máxima** crece hasta agotar el margen; con ella, el
bot deja vivas solo las órdenes que la reducen y espera. A diferencia de la rejilla clásica, aquí también
puedes acabar **corto** sin haberlo decidido: las ventas de arriba abren cortos cuando el precio sube.

Y un segundo riesgo, menos evidente, que hoy es un hallazgo abierto: por la **banda muerta** que rodea al
precio, una línea **se cancela justo antes de que el precio llegue a ella** si se acerca despacio
([F-81](#5-limitaciones-conocidas-hallazgos-abiertos)). En movimientos graduales esta rejilla **apenas
ejecuta**.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Ancla** | El centro. Por debajo se compra, por encima se vende; el peso de cada línea crece con la distancia al ancla. |
| **Línea** | Cada precio del rango. Con 20 niveles hay 20 líneas repartidas a los dos lados. |
| **Banda muerta** | Medio escalón (medio paso medio) a cada lado del precio actual: las líneas dentro **no tienen orden**, para no cancelar y recolocar la misma orden en cada movimiento mínimo. |
| **Posición neta** | Compras menos ventas. Positiva = largo, negativa = corto. |
| **Exposición máxima** | Tope de la posición neta. Alcanzado, solo quedan vivas las órdenes que la reducen. **Es el freno de esta estrategia.** |
| **Multiplicador de tamaño** | Cuánto más pesa cada línea que la anterior según se aleja del ancla. Con 1, todas iguales. |
| **Ciclo** | Cada paso exacto de la posición por cero cierra un ciclo y abre otro. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — Construir la retícula

Precios como en la rejilla clásica (aritmético o geométrico; aquí **geométrico por defecto**). Pesos:

```
rango_i     = |i − índice de la primera línea ≥ ancla|          (distancia al ancla, en escalones)
peso_i      = multiplicador ^ rango_i
margen_i    = capital asignado × peso_i / Σ pesos                ← Σ margen_i = capital asignado
cantidad_i  = margen_i × apalancamiento / precio_i
```

Con multiplicador 1 todas las líneas mueven lo mismo (`capital × apalancamiento / niveles`). Con 1,5 y 12
niveles, la línea del ancla pesa 1 y los extremos `1,5⁵ ≈ 7,6` y `1,5⁶ ≈ 11,4`: casi la mitad del
capital vive en las cuatro líneas de los extremos.

### Paso 2 — Compras abajo, ventas arriba, banda muerta en medio

Con el precio de marca `m` y el paso medio `p = (superior − inferior) / (niveles − 1)`:

```
línea < m − p/2   →  COMPRA post-only en la línea
línea > m + p/2   →  VENTA post-only en la línea
si no             →  sin orden (banda muerta)
```

Ninguna orden es `reduceOnly`: en modo unidireccional cada línea solo mueve la posición neta, y marcarlas
reduce-only haría que el venue rechazara media retícula cada vez que la posición cruza el cero.

### Paso 3 — El tope de exposición

Si `|posición neta| × precio ≥ Exposición máxima`, el bot **retira las órdenes que aumentarían la
posición** y deja solo las que la reducen. Nota: `Tope de exposición alcanzado: solo órdenes que reducen
posición.`

### Paso 4 — Reconciliar

Como en todas: calcula lo que debería haber, compara con lo que hay, coloca lo que falta y cancela lo que
sobra. Las líneas reutilizan su identificador (`GRID_BUY#i`, `GRID_SELL#i`): una línea que se ejecuta
vuelve a desearse cuando el precio se aleja de ella medio escalón. Nota habitual: `Retícula neutral: 18
órdenes activas.`

### Paso 5 — Cruzar el cero

Cada vez que la posición pasa exactamente por cero se cierra un ciclo (`CYCLE_CLOSED`) y empieza otro:
cambian **todos** los identificadores y la retícula entera se cancela y recoloca (hasta 200 órdenes).

### Paso 6 — Aviso de desvío

Con **Recentrar si se aleja** activado, si `|precio − ancla| / ancla ≥ umbral`, la nota añade `Desvío del
ancla 11,2 %: procede recentrar.` **Solo avisa**: el bot no mueve el ancla por su cuenta.

### Paso 7 — Guardas

Stop-loss inyectado por el motor sobre la media (la dirección sale del **signo de la posición real**, que
aquí cambia), y las [guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión).
La estrategia valida: ancla dentro del rango, al menos 4 niveles, paso ≥ 2 ticks, y **avisa** si no pones
Exposición máxima.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **Exposición máxima, siempre.** Es el único freno propio. Un valor entre la mitad y el total del capital
   asignado: en una ruptura, la posición neta no puede pasar de ahí.
2. **Pocos niveles y un rango razonable.** Cada línea tiene que superar el mínimo del par **también en el
   centro**, que es donde menos pesa con multiplicador > 1. La app rechaza el bot si alguna no cumple.
3. **Cuenta con la banda muerta.** Con `p` de paso medio, solo se ejecutan movimientos mayores que `p/2`
   **dentro de una revisión (15 s)** ([F-81](#5-limitaciones-conocidas-hallazgos-abiertos)). Rangos
   estrechos con muchos niveles hacen la banda pequeña y la rejilla más viva; rangos anchos con pocos
   niveles la hacen casi inerte.
4. **1× o 2×, y sabe que viene en cruzado.** El valor de fábrica es margen **cruzado**: la liquidación queda
   más lejos pero una ruptura arrastra el saldo de los otros bots de la cuenta. Aislado si quieres
   compartimentar.
5. **No te fíes de su backtest.** El replay planifica una vez por vela y no reproduce la banda muerta: el
   backtest de esta estrategia **sobreestima** las ejecuciones (F-65).

### Configuración A — «Neutral alrededor de un ancla clara en ETH»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, ETH a **2.503,35 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Lighter) | |
| Dirección | Neutral | |
| Modo de margen | Cruzado (fábrica) | |
| Apalancamiento | **2×** | |
| Capital asignado | **800 USDC** | 100 % |
| Precio ancla | **2.500** | |
| Precio inferior / superior | **2.200 / 2.800** | |
| Niveles | **24** | |
| Espaciado | Geométrico | |
| Multiplicador de tamaño | 1 | |
| Exposición máxima | **700 USDC** | 87,5 % |

**Qué hace esto.** Paso del **1,05 %** (26 USDC de media); banda muerta de **±13 USDC** (±0,52 %). Cada
línea mueve **≈ 66,5 USDC** (0,024-0,030 ETH). Con ETH en 2.503: **doce compras** vivas de 2.200 a 2.469,
**once ventas** de 2.521 a 2.800, y la línea de 2.495 muda dentro de la banda. La posición arranca en cero.
Cada vuelta del precio al ancla cierra ciclos por los dos lados. Si ETH se va a 2.200 el bot habrá
acumulado un largo, pero el tope de **700 USDC** corta las compras antes de comprometer los 1.600 que
permitiría el apalancamiento.

**Peor caso (vista previa).** La vista previa suma **los dos lados** como entradas: notional **1.596,89
USDC**, margen **800,00**, media **2.475,42**, liquidación estimada **1.250,09** (−50 %). El peor caso real
en una dirección son las líneas de ese lado (≈ 800 USDC de notional en largo) y, antes, el tope de 700.

### Configuración B — «BTC con el tope de exposición como freno principal»

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) · **78.910 USDC** | |
| Apalancamiento | **2×** | |
| Capital asignado | **1.000 USDC** | 100 % |
| Precio ancla | **79.000** | |
| Precio inferior / superior | **74.000 / 84.000** | |
| Niveles | **20** | |
| Multiplicador de tamaño | 1 | |
| Exposición máxima | **500 USDC** | 50 % |

**Qué hace esto.** Paso del **0,67 %** (≈ 526 USDC); banda muerta de **±263 USDC** (±0,33 %). Cada línea
mueve **≈ 99,5 USDC** (0,0012-0,0014 BTC). Diez compras vivas de 74.000 a 78.584, nueve ventas de 79.640 a
84.000, la línea de 79.110 muda. El tope de **500 USDC** es la mitad del capital: el bot puede cotizar en
las veinte líneas, pero en cuanto la posición neta llega a 500 USDC en cualquier dirección (unas cinco
ejecuciones del mismo lado) solo deja vivas las órdenes que la reducen. Es la forma de tener una rejilla
ancha sin que una ruptura la convierta en una posición direccional grande.

**Peor caso (vista previa).** Notional **1.992,41**, margen **1.000,00**, media **78.782**, liquidación
estimada **39.785** (−49,6 %).

### Configuración C — «SOL cargando los extremos»

| Campo | Valor | % del capital |
|---|---|---|
| Par | SOL/USDC (Lighter) · **138,42 USDC** | |
| Apalancamiento | **2×** | |
| Capital asignado | **600 USDC** | 100 % |
| Precio ancla | **138** | |
| Precio inferior / superior | **115 / 165** | |
| Niveles | **12** | |
| Espaciado | Geométrico | |
| Multiplicador de tamaño | **1,5** | |
| Exposición máxima | **600 USDC** | 100 % |

**Qué hace esto.** Con multiplicador 1,5 las líneas pegadas al ancla mueven poco y las de los extremos
mucho: **23 USDC** en 140,03 frente a **263 USDC** en 115 y **175** en 165. El bot apenas se mueve
mientras SOL ronde los 138 y carga de verdad si se va a 115 o a 165. Útil cuando esperas ruido en el
centro y quieres reservar la munición para los extremos. A cambio, con doce niveles el paso medio es de
4,5 USDC y la banda muerta de **±2,27 USDC (±1,6 %)**: solo ejecuta saltos mayores que eso en 15 s.

| Línea | 115,00 | 118,84 | 122,80 | 126,90 | 131,13 | 135,51 | 140,03 | 144,70 | 149,53 | 154,52 | 159,67 | 165,00 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Lado | compra | compra | compra | compra | compra | compra | (banda) | venta | venta | venta | venta | venta |
| Notional (USDC) | 263 | 175 | 117 | 78 | 52 | 35 | 23 | 35 | 52 | 78 | 117 | 175 |

**Peor caso (vista previa).** Notional **1.199,18**, margen **600,00**, media **132,83**, liquidación
estimada **67,08** (−51,5 %).

> La guía in-app propone este ejemplo con 20 niveles y multiplicador 1,8. **No es válido**: las líneas
> centrales caen a 0,8 USDC, por debajo del mínimo de 10 USDC y de la cantidad mínima de 0,1 SOL, y la
> app rechaza el bot. Con 12 niveles y 1,5 pasa (comprobado con `preview()`).

### Checklist antes de arrancar

- [ ] ¿**Exposición máxima** puesta? (entre la mitad y el total del capital)
- [ ] ¿La línea que menos pesa (la del ancla, con multiplicador > 1) supera los 20 USDC?
- [ ] ¿El ancla está cerca del precio de hoy o del precio al que el par suele volver? (dentro del rango, o la app lo rechaza)
- [ ] ¿La banda muerta (`paso medio / 2`) es menor que los saltos que el par da en 15 s?
- [ ] ¿Apalancamiento 1× o 2×? ¿Sé que viene en **cruzado**?
- [ ] ¿En Lighter, 30 líneas o menos?
- [ ] ¿Sé que **Dirección** y **Tope de exposición** no cambian nada aquí? (§4)
- [ ] ¿He decidido cómo recentrar si hace falta? (editar el ancla, no el comando)

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Tope de exposición alcanzado: solo órdenes que reducen posición.` | Ruptura hacia un lado; el freno ha actuado | Decide: esperar el retorno, recentrar (editando el ancla), o cerrar |
| `Desvío del ancla 11,2 %: procede recentrar.` | El precio se ha ido del centro | Edita **Precio ancla** (en tibio): es la forma de recentrar; el menú ya no ofrece «Recentrar» aquí |
| Muchos `CANCELED` de la misma línea y pocos `FILL` con el precio bajando despacio | La banda muerta cancela la línea antes de que se toque (F-81) | Menos niveles no ayudan; rango más estrecho sí (banda más pequeña) |
| `CYCLE_CLOSED` frecuentes con recolocación de toda la retícula | La posición cruza el cero a menudo | Normal; en Lighter cuenta el cupo de peticiones |
| `ORDER_UNVIABLE` en las líneas del centro | Con multiplicador > 1 el centro pesa poco | Baja el multiplicador o sube capital |

---

## 4. Lo que este bot NO mira (importante)

| Campo | Realidad |
|---|---|
| **Dirección** (`direction`) | ⚠️ **No se lee al planificar.** Largo, corto o neutral, la retícula es la misma: compras bajo el ancla y ventas encima. Solo afecta a cómo la vista previa estima la liquidación. La guía in-app promete un sesgo que no existe. |
| **Tope de exposición** (`maxNotionalCap`) | ⚠️ **Muerto.** El freno que el motor consulta es **Exposición máxima**. |
| **Espera entre ciclos** (`cooldownMinutes`) | ⚠️ **Muerto.** |
| **Recentrar si se aleja** / **Umbral para recentrar** | Solo añaden el aviso a la nota. No mueven el ancla. |
| **Capital asignado** | ✅ Sí: es la suma de los márgenes de todas las líneas. |

Sí funcionan, aplicados por el motor: **Stop loss** (sobre la media y con la dirección de la posición real),
**Pérdida diaria máxima**, **Al acercarse la liquidación**, guardas de la cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Confirmadas en `specs/001-revision-integral/findings.md`, abiertas a 2026-09-06.

> ⚠️ **Limitación conocida (F-81).** La banda muerta **cancela la línea justo antes de que pueda
> ejecutarse**: una compra en 95 con paso 5 solo vive mientras el precio esté por encima de 97,5. Si el
> precio baja gradualmente de 98 a 95, la orden desaparece en 97,5 y no vuelve hasta que el precio se aleje.
> Solo se cobran saltos mayores que medio escalón **dentro de una revisión (~15 s)**: en la configuración
> A, movimientos de más del 0,52 %; en la C, de más del 1,6 %. El backtest, que planifica una vez por vela,
> **no lo reproduce y sobreestima** las ejecuciones (F-65).
> **Hasta que se corrija:** úsala en pares y rangos donde los saltos superen la banda; no dimensiones con
> el backtest.

> ⚠️ **Limitación conocida (F-12).** `direction`, `maxNotionalCap` y `cooldownMinutes` no se leen;
> `reanchorOnDrift` solo avisa (§4). **Hasta que se corrija:** el freno es `maxExposure`.

> ⚠️ **Limitación conocida (F-14).** La vista previa estima la liquidación con la fórmula **aislada** aunque
> el modo de fábrica sea **cruzado**, y solo para el lado largo aunque el bot sea neutral.
> **Hasta que se corrija:** léela como cota; con posición manda el precio del venue.

> ⚠️ **Limitación conocida (F-83).** Una ejecución **parcial** de una línea hace que el resto se cancele y
> la línea **se recoloque entera**: hasta 1,3 veces la cantidad en esa línea.
> **Hasta que se corrija:** líneas holgadas sobre el mínimo.

> ⚠️ **Limitación conocida (F-50, solo Lighter).** Máximo 30 órdenes activas por mercado; el exceso se
> rechaza en silencio. **Hasta que se corrija:** ≤ 30 líneas en Lighter (y cuenta el churn del cruce por
> cero contra el cupo de 60 peticiones/min).

> ⚠️ **Limitación conocida (F-94).** Al cruzar el cero cambia todo el ciclo y la retícula entera se
> recoloca; con 200 niveles en un rango del 5 % el paso queda por debajo de una ida y vuelta maker+maker y
> la estrategia no avisa (la clásica sí). El funding del inventario no se muestra.

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente · 🌤️ en tibio (cancela y recoloca las órdenes; la posición sigue; pide confirmación) ·
❄️ en frío (hay que crear otro bot).

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera. **Consejo**: empieza en «Simulación», pero sabiendo que el simulador no
reproduce la banda muerta mejor que el venue: la rejilla neutral se ve igual de quieta en simulación.

#### Par · `symbol` · ❄️ en frío

Fija tick, paso de cantidad y mínimo. Con multiplicador > 1, la línea del ancla es la que más cerca queda
del mínimo.

#### Dirección · `direction` · ❄️ en frío · por defecto **Neutral**

Neutral / Largo / Corto. ⚠️ **`plan()` no lo lee**: la retícula es idéntica en los tres casos. Solo cambia
la dirección con la que la vista previa estima la liquidación. Déjalo en Neutral.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

La suma de los márgenes de todas las líneas, repartida por pesos. Con multiplicador 1, cada línea recibe
`capital / niveles`.

#### Precio ancla · `anchorPrice` · 🌤️ en tibio · obligatorio

El centro de la retícula: el precio en el que el bot considera que tu posición debería ser cero. Todo se
mide contra él: por debajo compras, por encima ventas, y el peso de cada línea crece con su distancia.
Ponerlo lejos del precio actual hace que el bot arranque ya cargado hacia un lado.

**Consejo**: dentro del rango (la app lo exige), cerca del precio de hoy o del precio al que el par suele
volver. **Editarlo es la forma de recentrar**: el comando «Recentrar la retícula» no existe para esta
estrategia y el menú del bot no lo ofrece.

#### Precio inferior · `lowerPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

Extremo inferior. La compra más lejana se coloca aquí; es donde acaba tu posición larga máxima si el
precio se desploma.

#### Precio superior · `upperPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

Extremo superior. La venta más lejana se coloca aquí; es donde acaba tu **corto** máximo si el precio se
dispara.

#### Niveles · `gridLevels` · 🌤️ en tibio · 4–200 · por defecto **20**

Cuántas líneas se reparten por el rango completo, contando los dos lados. Más niveles: retícula más fina,
más ciclos y más pequeños, y **banda muerta más pequeña**. El mínimo son 4.

**Consejo**: que el capital repartido siga dejando la línea más ligera por encima de 20 USDC. En Lighter,
≤ 30.

#### Espaciado · `gridSpacing` · 🌤️ en tibio · por defecto **Geométrico**

Misma distancia en USDC (aritmético) o mismo porcentaje (geométrico). Aquí viene geométrico por defecto:
si el rango es amplio, el mismo salto en USDC rinde porcentajes muy distintos arriba y abajo del ancla.

#### Multiplicador de tamaño · `sizeMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1**

Cuánto más dinero mueven los niveles lejanos al ancla frente a los cercanos. Subirlo vacía el centro y
carga los extremos. Bajarlo a 1 reparte el capital de forma pareja.

**Consejo**: entre 1 y 1,5 para empezar. Por encima de 2, casi todo el capital vive en las dos o tres
líneas de cada extremo y las del centro caen por debajo del mínimo del par.

### 6.2 Riesgo

#### Exposición máxima · `maxExposure` · 🔥 en caliente · opcional · ⚠️ campo de riesgo

Tope de la posición **neta** del bot, en USDC, mirando los dos lados. **Es el freno propio de esta
estrategia**: alcanzado, el bot deja vivas únicamente las órdenes que reducen la posición.

**Consejo**: ponlo siempre. Sin él la app avisa por una razón concreta: en una ruptura la posición neta
crece hasta agotar el margen.

#### Recentrar si se aleja · `reanchorOnDrift` · 🔥 en caliente · por defecto **No**

Vigila cuánto se ha alejado el precio del ancla. **Hoy solo informa**: cuando pasa del umbral lo anota en
la nota del bot, pero **no mueve el ancla**. El recentrado real es editar el Precio ancla.

#### Umbral para recentrar (%) · `reanchorThresholdPct` · 🔥 en caliente · 0,5–50 · por defecto **10**

A qué porcentaje de distancia del ancla aparece el aviso anterior. No cambia ninguna orden por sí mismo.
**Consejo**: un valor cercano a la mitad de tu rango avisa cuando el precio se acerca a un extremo.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

> ⚠️ **Muerto en esta estrategia** (F-12). Configura **Exposición máxima** y deja este vacío.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · 0,1–90 · ⚠️ campo de riesgo

Pérdida sobre la media a la que el motor cierra la posición con una orden condicional nativa. La dirección
sale del **signo de la posición real**, así que sirve igual si acabas largo o corto
([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)).

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su capital, a partir de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo. En cruzado la liquidación del venue depende de toda la cuenta.

### 6.3 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

> ⚠️ **Muerto en esta estrategia** (F-12). Al cruzar el cero la retícula se recoloca en la siguiente revisión.

### 6.4 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida y acerca la liquidación. **Consejo**: 1× o 2×.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Cruzado**

⚠️ **Aquí el valor de fábrica es cruzado**: la liquidación queda más lejos, pero una posición perdedora
puede arrastrar el saldo del resto de bots de esa cuenta. Elige **Aislado** si quieres que el peor caso de
esta rejilla no toque a los demás. No se puede cambiar después.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Neutral | ✅ Déjalo (no se lee) |
| Modo de margen | **Cruzado** | 🟡 Aislado si compartes cuenta con otros bots |
| Apalancamiento | 2× | ✅ Déjalo, o 1× |
| Niveles | 20 | Según rango y capital; banda muerta = paso/2 |
| Espaciado | Geométrico | ✅ Déjalo |
| Multiplicador de tamaño | 1 | 🟡 1,2-1,5 si quieres cargar extremos; vigila el centro |
| Exposición máxima | vacío | 🔴 **Ponlo** |
| Recentrar si se aleja / Umbral | No / 10 % | Solo como aviso |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |
| Espera entre ciclos | 0 | ✅ Déjalo (muerto) |

---

## 8. ¿Esta u otra?

| | **Rejilla neutral** | [Rejilla clásica](./grid-classic.md) | [Market Maker V1](./market-maker.md) |
|---|---|---|---|
| Lados | Dos desde el arranque | Uno (el de la entrada) | Dos, alrededor del precio |
| Precios | Fijos en líneas | Fijos en líneas | Siguen al precio (recotiza) |
| Puede acabar corto sin querer | **Sí** | No (en largo) | Sí, acotado por el tope |
| Freno | `maxExposure` | Rango + `stopOnRangeExit` | Modos defensivo/alto riesgo |
| Reacciona a movimientos lentos | **Mal** (banda muerta, F-81) | Bien | Bien (recotiza cada 30 s) |
| Hallazgos abiertos propios | F-81 | F-88, F-03 | F-57 |

**Elige la neutral si**: no quieres sesgo y el par da saltos claros alrededor de un precio reconocible.
**Elige la clásica si**: quieres acumular o es tu primer bot. **Elige un market maker si**: el par oscila
deprisa y prefieres que las órdenes sigan al precio.
