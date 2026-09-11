# Market Maker V2 — guía completa

> Estrategia `MARKET_MAKER_V2`.
> Código: [`market-maker-v2.ts`](../packages/strategy-core/src/strategies/market-maker-v2.ts) · piezas compartidas con la V1 en [`mm-shared.ts`](../packages/strategy-core/src/strategies/mm-shared.ts)

Si no sabes qué es un market maker, **empieza por la [guía de la V1](./market-maker.md), sección 1**. Aquí se da por sabido.

---

## 1. Qué cambia respecto a la V1

La V1 y la V2 hacen lo mismo: cuelgan una compra por debajo y una venta por encima, y cobran la diferencia.

La diferencia está en **de dónde sale el número de esa diferencia**.

### En la V1, tú decides el diferencial

Escribes "20 bps" y el bot cotiza a 20 bps. Punto. Lo único que lo mueve es el inventario acumulado.

**El problema**: 20 bps puede ser un negocio estupendo un martes tranquilo y un desastre el día que sale una noticia. Y si tu exchange te cobra 3 bps de comisión por lado, una vuelta completa te cuesta 6 bps — con lo que tus "20 bps de beneficio" son en realidad 14, y eso si el mercado no se mueve en tu contra. Nadie hace esa cuenta a mano cada día.

### En la V2, el diferencial se calcula

Lo que tú escribes es **un punto de partida**. Encima de eso, el bot suma:

```
DIFERENCIAL = tu distancia base
            + margen fijo del libro
            + (volatilidad medida × tu multiplicador)     ← cuanto más nervioso el mercado, más ancho
            + (comisión × 2)                              ← lo que cuesta abrir y cerrar
            + tu buffer de seguridad

y luego lo encaja entre dos límites:

SUELO  = MAX( distancia mínima permitida , comisión × 2 + margen mínimo de beneficio )
TECHO  = spread dinámico máximo

DIFERENCIAL FINAL = MAX( SUELO , MIN( TECHO , lo de arriba ) )
```

Eso da **dos garantías** que la V1 no puede dar:

1. **Nunca cotizas por debajo de lo que cuesta operar.** Si tu comisión es 2 bps y quieres 8 bps limpios, el suelo es 12 bps. Aunque escribas "5 bps de distancia", el bot cotizará a 12. Una vuelta cerrada **siempre** deja dinero.
2. **El bot se ensancha solo cuando el mercado se pone nervioso**, y se estrecha solo cuando se calma. Sin que toques nada.

### Y dos capacidades más

- **Puede cotizar contra el precio de Binance** en vez del libro de tu exchange. Importante en un DEX pequeño, donde tus propias órdenes _son_ el precio: anclarte a tu propio libro es un bucle. Y si esa fuente externa se cae, **el bot retira sus órdenes** en lugar de volver en silencio al precio local.
- **Puede esperar a un precio de disparo** antes de empezar a cotizar.

### El precio a pagar

**Es la estrategia con más parámetros de la plataforma.** Y hay una consecuencia que sorprende a todo el mundo la primera vez:

> Escribes "40 bps de distancia" y ves al bot cotizando a 54. **No está roto.** La fórmula suma.

Si eso te molesta, la V1 te da control directo.

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa cada bot **cada 15 segundos**, y **una ejecución dispara una revisión inmediata**.

### Paso 1 — ¿Cuál es el precio de referencia?

Depende de dos campos combinados:

| Origen del precio justo          | Fuente de precio       | Resultado                                   |
| -------------------------------- | ---------------------- | ------------------------------------------- |
| **Global desde la fuente**       | **Datos del exchange** | Punto medio del libro local                 |
| **Global desde la fuente**       | **Binance**            | **Precio de Binance** ← el caso interesante |
| **Medio del exchange**           | (cualquiera)           | Punto medio del libro local                 |
| **Precio de marca del exchange** | (cualquiera)           | Precio de marca del exchange                |

> ⚠️ Para anclar de verdad a Binance hace falta poner **las dos cosas**: `Fuente de precio = Binance` **y** `Origen del precio justo = Global desde la fuente`. Con cualquier otra combinación se usa el precio local.

**Si pediste Binance y el precio no está disponible, el bot NO cotiza.** Retira sus órdenes y escribe:

> `Sin precio de referencia de binance: no se cotiza hasta que la fuente vuelva.`

Es deliberado: si elegiste una fuente externa es porque no te fías del libro local, y sustituirla en silencio sería hacer justo lo contrario de lo que pediste.

_(Detalle técnico: el precio de Binance se sondea por REST cada 2 s y se comparte entre todos los bots que lo pidan, con 30 s de vida.)_

### Paso 2 — ¿Está armado el bot?

Si has puesto una **Condición de activación**, el bot **no coloca ni una orden** hasta que el precio cruce el disparador:

> `Esperando a que el precio baje a 0.004.`

**Una vez armado, se queda armado mientras el bot viva** (un par casado no cierra el ciclo ni borra el armado). No vuelve a dormirse si el precio deshace el movimiento — sería apagar un bot que ya tiene inventario.

### Paso 3 — ¿Toca recotizar?

Recotiza si se cumple alguna de estas:

- Ha pasado el **Intervalo de actualización de órdenes** (30 s por defecto), **o**
- El precio se ha movido más que la **Distancia para reajustar precio** (30 bps por defecto), **o**
- Alguna orden ha superado su **Actualizar órdenes después de** (120 s por defecto), **o**
- Una orden de salida ha superado su TTL.

> A diferencia de la V1, aquí el umbral de deriva es **un campo propio** (`repriceThresholdBps`) y no el suelo de la cotización. Puedes tener un suelo de 8 bps y recotizar solo a los 30 bps de deriva.

Si hay **Espera tras un fill** activa (35 s por defecto), la cotización se **congela** y no caduca nada.

### Paso 4 — Medir la volatilidad

El bot guarda una lista de precios recientes y calcula el **recorrido** del precio en la ventana:

```
volatilidad_bps = (máximo − mínimo) / media × 10.000
```

Si en 5 minutos el precio ha ido de 99 a 101 sobre una media de 100, la volatilidad es **200 bps**.

Dos detalles:

- Se usa el **recorrido** y no la desviación típica porque sale directamente en bps y no exige muestras equiespaciadas (una ejecución dispara un tick fuera de ritmo).
- **Solo se toma muestra cuando se recotiza**, no en cada revisión. Entre recotizaciones las órdenes no se mueven, así que afinar el número no serviría de nada y costaría una escritura en base de datos por tick y por bot.

> Consecuencia práctica: **con refrescos lentos la ventana efectiva de volatilidad es más corta de lo que parece**, porque hay menos muestras dentro.

### Paso 5 — Inventario y modo de riesgo

Idéntico a la V1:

```
exposición = cantidad × precio
ocupación  = |exposición / Inversión máxima| × 100
```

| Modo            | Cuándo (por defecto en V2) | Lado que AÑADE       | Lado que REDUCE       |
| --------------- | -------------------------- | -------------------- | --------------------- |
| **Normal**      | Ocupación < 90 %           | × 1                  | × 1                   |
| **Defensivo**   | Ocupación ≥ **90 %**       | **× 1,5** (se aleja) | **× 0,6** (se acerca) |
| **Alto riesgo** | Ocupación ≥ **100 %**      | **× 0 → desaparece** | × 0,5 y `reduceOnly`  |

> Los umbrales por defecto de la V2 (90 / 100) son **mucho más tardíos** que los de la V1 (70 / 90). La lógica es que aquí el diferencial ya se ensancha solo con la volatilidad. Si quieres frenos tempranos, **bájalos tú**.

> ⚠️ **Diferencia con la V1:** la V2 **no tiene sesgo de precio por inventario**. La V1 desplaza el centro de la cotización en contra de su posición para deshacerla antes; la V2 no lo hace. Aquí el inventario solo actúa mediante los modos de riesgo. Es una razón para poner los umbrales más bajos que los de fábrica.

### Paso 6 — Componer el diferencial

Esta es la parte característica. Con la configuración de fábrica y una volatilidad medida de 20 bps:

| Componente                               | Cálculo        | bps                                    |
| ---------------------------------------- | -------------- | -------------------------------------- |
| Distancia base                           | tu campo       | 40,00                                  |
| Margen del libro                         | fijo           | +1,50                                  |
| Volatilidad                              | 20 × 0,35      | +7,00                                  |
| Coste ida y vuelta                       | comisión × 2   | +0,00 _(por defecto la comisión es 0)_ |
| Buffer de seguridad                      | fijo           | +0,00                                  |
| **Bruto**                                |                | **48,50**                              |
| Se aplica el suelo: máx(8 ; 0×2 + 8) = 8 | máx(8 ; 48,50) | **48,50**                              |

Y luego, **por capa**, con el techo al final:

```
distancia_capa = MAX( SUELO ,  MIN( TECHO ,  diferencial × mult_distancia^capa × preset × modo_riesgo ) )
```

El techo (100 por defecto) se aplica **después** de los multiplicadores de capa, de preset y de modo de riesgo: ninguna capa cotiza más ancha que el techo, y el suelo por coste sigue mandando por debajo (la app rechaza un techo menor que el suelo). Con techo **0** no hay techo, y la app lo avisa.

El **Comportamiento** (preset) multiplica igual que el perfil de la V1:

| Preset      | Distancia | Tamaño |
| ----------- | --------- | ------ |
| Conservador | × 1,5     | × 0,7  |
| Equilibrado | × 1       | × 1    |
| Agresivo    | × 0,7     | × 1,3  |

### Paso 7 — Encajar el tamaño en el tope

Aquí la V2 es **más lista que la V1**. Antes de colocar cada capa mira cuánto hueco queda hasta el tope y:

- **Usar tamaño normal hasta el máximo = No** (por defecto) → **recorta** la capa al hueco que quede. Si lo que queda no llega al mínimo del par, la capa no se coloca.
- **Usar tamaño normal hasta el máximo = Sí** → **todo o nada**: o cabe entera, o no se coloca. Es lo que evita una última capa de 3 USDC que el exchange rechazaría por mínimo de orden.

_(El recorte se hace sobre el **nocional en USDC**, no sobre el tamaño escrito. Con "Cantidad de moneda" el tamaño va en la base y el hueco en la quote: compararlos directamente dejaría el tope sin efecto.)_

### Paso 8 — Guardas finales

Idénticas a la V1: piso/techo de precio (cortan **solo el lado que abre**) y **Acción al alcanzar el límite**.

También como en la V1: el bot **nunca cruza el libro** —si el precio calculado saldría en el toque
contrario o más allá, la orden se pega al toque, que nunca empeora tu precio— y **sin libro no cotiza**.
Esto último importa especialmente aquí: la V2 puede anclarse a un **precio externo** (Binance), y ese
precio no tiene por qué coincidir con el libro del exchange donde se firma la orden. Si se separan, las
cotizaciones se quedan pegadas al toque en vez de salir cruzadas.

---

## 3. Cómo configurarlo con poco riesgo

### La regla número uno de la V2

> ## ⚠️ Pon la **Estimación de comisión** con tu comisión real de maker.
>
> Los bots nuevos nacen con **2 bps** (los creados antes conservan su valor): si tu comisión de maker es otra, ajústala. Con 0 la V2 pierde su principal ventaja: calcula como si operar fuese gratis, y el suelo de beneficio no protege de nada.
>
> Búscala en la web de tu exchange ("maker fee"). Si es 0,02 %, escribe **2**. Si es 0,015 %, escribe **1,5**.

### Las otras cinco reglas

1. **Empieza en Neutral.** Igual que en la V1: "Intención Long" coloca **solo compras y ninguna venta** (ver 5.1).
2. **Apalancamiento 1x** (es el valor de fábrica de la V2, y es el correcto para empezar).
3. **Baja los umbrales de riesgo de fábrica.** 90 / 100 son muy tardíos, y esta versión **no tiene sesgo por inventario** que ayude a deshacer. 60 / 80 es mucho más prudente.
4. **Sube la espera tras un fill antes que el tamaño.** Viene en 35 s por algo.
5. **Empieza con 1 capa.** Es el valor de fábrica y hace que la fórmula sea fácil de leer: lo que ves cotizado es exactamente lo que calculó.

### Configuración A — "Prueba de agua" (riesgo mínimo)

Todo local, sin dependencias externas, con frenos tempranos y garantía de beneficio.

| Campo                           | Valor                            |
| ------------------------------- | -------------------------------- |
| Par                             | BTC/USDC o ETH/USDC              |
| Dirección                       | **Neutral**                      |
| Apalancamiento                  | **1x** · Modo de margen: Aislado |
| Comportamiento                  | **Conservador**                  |
| Tamaño por compra/venta         | **25 USDC**                      |
| Inversión / posición máxima     | **200 USDC**                     |
| Distancia de compra / venta     | **25 bps / 25 bps**              |
| Distancia mínima permitida      | 8 bps                            |
| **Estimación de comisión**      | **tu comisión real** (ej. 2 bps) |
| **Margen mínimo de beneficio**  | **10 bps**                       |
| Buffer de seguridad             | 2 bps                            |
| Spread dinámico                 | **Sí** · libro 1,5 · vol ×0,35   |
| Spread dinámico máximo          | 80 bps                           |
| Niveles de cotización           | **1**                            |
| Intervalo de actualización      | 60 s                             |
| Distancia para reajustar precio | 30 bps                           |
| Actualizar órdenes después de   | 180 s                            |
| Espera tras un fill             | 45 s                             |
| Umbral defensivo / alto riesgo  | **60 % / 80 %**                  |
| Acción al alcanzar el límite    | Pausar entradas                  |
| Solo post-only                  | **Sí**                           |
| Fuente de precio                | Datos del exchange               |
| Condición de activación         | Sin condición                    |

**Qué cotiza con BTC a 100.000 USDC y una volatilidad medida de 20 bps:**

| Componente                                                         | bps               |
| ------------------------------------------------------------------ | ----------------- |
| Base                                                               | 25,00             |
| Libro                                                              | +1,50             |
| Volatilidad (20 × 0,35)                                            | +7,00             |
| Comisión ida y vuelta (2 × 2)                                      | +4,00             |
| Buffer                                                             | +2,00             |
| **Bruto**                                                          | **39,50**         |
| Suelo = máx(8 ; 2×2 + 10) = **14** → 39,50 ya lo supera, no aplica | 39,50             |
| Preset Conservador × 1,5                                           | **59,25 ← final** |

→ compra en **99.407,50**, venta en **100.592,50**. Tamaño: 25 × 0,7 = **17,50 USDC**.

Una vuelta completa deja **118,5 bps brutos** − 4 bps de comisión ≈ **114,5 bps netos** sobre 17,50 USDC ≈ **0,20 USDC**.

**Y si el mercado se calma** (volatilidad 5 bps): 25 + 1,5 + 1,75 + 4 + 2 = 34,25 → × 1,5 = **51,4 bps**. El bot se ha estrechado solo. Ese es el punto de la V2.

### Configuración B — "Equilibrada" (uso normal)

| Campo                              | Valor                               |
| ---------------------------------- | ----------------------------------- |
| Dirección                          | **Neutral** · Apalancamiento **1x** |
| Comportamiento                     | **Equilibrado**                     |
| Tamaño por compra/venta            | **50 USDC**                         |
| Inversión / posición máxima        | **600 USDC**                        |
| Distancia de compra / venta        | **20 bps / 20 bps**                 |
| **Estimación de comisión**         | tu comisión real                    |
| **Margen mínimo de beneficio**     | **8 bps**                           |
| Buffer de seguridad                | 1 bps                               |
| Spread dinámico                    | Sí · libro 1,5 · vol ×0,35          |
| Spread dinámico máximo             | 100 bps                             |
| Niveles de cotización              | **2** · distancia 1,3 · tamaño 1    |
| Usar tamaño normal hasta el máximo | **Sí**                              |
| Espera tras un fill                | 35 s                                |
| Umbral defensivo / alto riesgo     | **70 % / 90 %**                     |

Con 2 capas de 50 USDC hay **100 USDC comprometidos por lado**, holgados frente al tope de 600.

### Configuración C — "Anclada a Binance" (para DEX)

Cuando operas en un DEX cuyo libro se desvía del mercado global. Añade a la B:

| Campo                         | Valor                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| **Fuente de precio**          | **Binance**                                                       |
| **Origen del precio justo**   | **Global desde la fuente**                                        |
| **Tipo de mercado de origen** | **Perpetuo**                                                      |
| Símbolo de origen alternativo | _Vacío_, salvo que el par no se llame igual en Binance            |
| Margen mínimo de beneficio    | **12 bps** (un poco más: hay riesgo de desviación entre mercados) |

Así el bot cotiza alrededor del precio de Binance, no del libro local: si el DEX se desvía, sus órdenes quedan del lado bueno de esa diferencia.

**Cuándo hace falta el símbolo alternativo**: por defecto el bot pide `<base>USDT` — BTC pasa a ser `BTCUSDT`. Si tu par se llama distinto en Binance, no hay precio y el bot no cotiza. Caso típico: **kPEPE** en un DEX es **`1000PEPEUSDT`** en Binance.

> ⚠️ Anclar a Binance **añade una dependencia externa**. Si esa fuente se cae, tu bot deja de cotizar (con las órdenes retiradas). Es la decisión correcta desde el punto de vista del riesgo, pero significa que **tu bot deja de trabajar cuando falla algo que no controlas**.

### Configuración D — "Con disparador"

Un bot preparado para arrancar solo cuando el precio llegue a donde tú quieres:

| Campo añadido               | Ejemplo                     |
| --------------------------- | --------------------------- |
| **Condición de activación** | **Cuando baje a**           |
| **Precio de disparo**       | 2.600 (con ETH hoy a 3.000) |

Hasta que ETH no toque 2.600, el bot no coloca ni una orden. En cuanto lo cruza, queda armado y empieza a cotizar, y sigue armado aunque ETH vuelva a 2.700.

### Checklist antes de arrancar

- [ ] ¿**Estimación de comisión** puesta con mi comisión real? _(la trampa número uno)_
- [ ] ¿**Margen mínimo de beneficio** puesto en algo distinto de 0?
- [ ] ¿Dirección en **Neutral**?
- [ ] ¿Apalancamiento en 1x?
- [ ] ¿He **bajado** los umbrales defensivo/alto riesgo desde el 90/100 de fábrica?
- [ ] ¿La **Inversión / posición máxima** es dinero que puedo perder entero?
- [ ] ¿`niveles × tamaño` es bastante menor que ese tope?
- [ ] ¿El **Spread dinámico máximo** queda por encima del suelo calculado? _(si no, la app rechaza la configuración)_
- [ ] Si uso Binance: ¿**Fuente = Binance** _y_ **Origen = Global desde la fuente**? ¿El símbolo existe allí?
- [ ] ¿**Solo post-only** activado?
- [ ] ¿He mirado la vista previa? _(muestra el diferencial en reposo, sin volatilidad: es el mínimo que va a cotizar)_

### Señales de alarma cuando ya está funcionando

El bot escribe una nota muy informativa en cada revisión:

> `Diferencial 54.2/54.2 bps (vol 25.1), inventario 34 % del tope, 2 cotizaciones.`

| Lo que ves                                             | Qué significa                                                    | Qué hacer                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| El diferencial es **mucho** mayor de lo que escribiste | Normal: la fórmula suma. Si es exagerado, mira `vol`             | Baja el **Multiplicador de volatilidad** o el **Spread dinámico máximo**       |
| `vol` altísima y casi ninguna ejecución                | El bot se ha alejado por un mercado nervioso                     | Es lo correcto; espera, o baja el multiplicador de volatilidad                 |
| El diferencial **no cambia nunca**                     | O el spread dinámico está apagado, o estás pegado al suelo/techo | Comprueba el suelo: `comisión × 2 + margen mínimo`                             |
| `Sin precio de referencia de binance`                  | La fuente externa no responde                                    | Espera, o cambia a **Datos del exchange**                                      |
| `Esperando a que el precio…`                           | La condición de activación no se ha cumplido                     | Nada; o quita la condición                                                     |
| Inventario que sube y **nunca baja**                   | Mercado en tendencia                                             | **Baja los umbrales de riesgo**: la V2 no tiene sesgo por inventario que ayude |
| `Modo defensivo` permanente                            | El tope es pequeño para tus capas                                | Sube el tope o baja el tamaño                                                  |

---

## 3 bis. Qué mueve y qué NO mueve una cotización viva

Esto es lo que decide si el bot llega a ejecutar alguna vez, y hasta el spec 035 estaba mal.

Un market maker gana dinero de una sola forma: **poniendo una orden y esperando a que el mercado
venga a buscarla**. Si cada vez que el precio se acerca el bot mueve la orden un poco más lejos, la
orden no se ejecuta nunca — por muy bien calculado que esté el diferencial y por mucho que el
mercado se mueva.

Eso es exactamente lo que pasaba: un bot cotizando a 121 bps con «Distancia para reajustar» en 51
recolocaba sus órdenes cuando el precio había recorrido menos de la mitad del camino, y se pasó
**23 horas sin una sola ejecución** mientras el precio se movía un 15 %.

Ahora la regla es asimétrica, y conviene entenderla porque explica lo que verás en pantalla:

| Lo que hace el mercado   | Qué pasa con tu cotización                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Se acerca** a tu orden | **No se mueve.** Ni por deriva, ni por el intervalo de actualización, ni por la edad máxima. Es el momento por el que existe la estrategia. |
| **Se aleja** de tu orden | Se recoloca cuando el desvío pasa de la cuarta parte de su distancia: se había quedado atrás y no iba a ejecutarse.                         |

Consecuencia práctica: los dos lados dejan de moverse a la vez. Con el precio cayendo, tu **compra
se queda quieta** esperando a que la alcancen mientras tu **venta baja** siguiendo al mercado. Es lo
que hace un creador de mercado de verdad.

Y una advertencia que se sigue de esto: con el arreglo, un bot que antes no ejecutaba **empezará a
ejecutar**. Revisa tu **Posición máxima** y la **acción al alcanzar el límite** antes de ponerlo en
real: esa red nunca había hecho falta porque nunca había inventario que topar.

---

## 4. Lo que este bot NO mira (importante)

| Campo                                       | Realidad                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tope de exposición** (`maxNotionalCap`)   | ⚠️ **Esta estrategia lo ignora.** Solo lo respetan Rejilla clásica, GridMart y Martingala. Aquí el tope real es **Inversión / posición máxima**.  |
| **Capital asignado** (`totalInvestment`)    | No dimensiona órdenes. El tamaño lo mandan **Tamaño por compra/venta** y **Niveles**. Sí se usa como denominador de la **Pérdida diaria máxima**. |
| **Espera entre ciclos** (`cooldownMinutes`) | Es para estrategias con ciclos que abren y cierran. Aquí usa **Espera tras un fill**.                                                             |

Sí funcionan, aplicados por el motor: **Stop loss** (orden condicional nativa en el exchange, sigue viva aunque la plataforma se caiga; su dirección sale del **signo de la posición real**), **Pérdida diaria máxima** y **Al acercarse la liquidación**.

---

## 5. Parámetros configurables, uno a uno

**Mutabilidad**: 🔥 **en caliente** = se aplica en la siguiente revisión · 🌤️ **en tibio** = cancela y vuelve a tender las órdenes, sin cerrar posición · ❄️ **en frío** = no se puede cambiar, hay que crear otro bot.

### 5.1 Configuración básica

#### Dirección · `direction` · ❄️ en frío · por defecto **Neutral**

> ⚠️ **AVISO IMPORTANTE**, igual que en la V1:
>
> - **Neutral** → compras **y** ventas. El market maker de verdad.
> - **Intención Long** → **solo compras, ninguna venta.** El bot acumula sin salida propia.
> - **Intención Short** → **solo ventas**, con el problema simétrico.
>
> Para "hacer mercado inclinado a comprar", deja **Neutral** y pon la distancia de compra más corta que la de venta.

#### Comportamiento · `behaviorPreset` · 🔥 en caliente · por defecto **Equilibrado**

Ajusta distancia y tamaño a la vez: Conservador (×1,5 distancia, ×0,7 tamaño), Equilibrado (×1, ×1), Agresivo (×0,7, ×1,3).

El techo del spread dinámico se aplica **después** de este multiplicador: un preset Conservador nunca lleva la cotización por encima del techo que fijaste.

#### Tamaño por compra/venta · `orderSizePerSide` · 🔥 en caliente · mínimo 1

Lo que se pone en cada orden, en cada lado. Con varios niveles, el tamaño del **primero**.

**Consejo**: que supere el mínimo del par (~10 USDC). Con preset Conservador se reduce al 70 %.

#### Inversión / posición máxima · `maxBotPositionValue` · 🔥 en caliente · mínimo 1 · ⚠️ campo de riesgo

**El freno principal.** Tope de exposición en cualquier dirección.

- De él salen **en porcentaje** los umbrales defensivo y de alto riesgo.
- Contra él se **recorta** el tamaño del último nivel que cabe (ver `useFullSizeUntilMax`).
- **Consejo**: aquí manda este campo, **no** el "Tope de exposición" genérico (que se ignora).

#### Introducir tamaños en · `sizingMode` · 🌤️ en tibio · por defecto **Valor nocional**

Valor nocional (USDC) o Cantidad de moneda. **Consejo**: valor nocional, se compara sin cuentas contra el tope.

> El campo **cambia de unidad contigo**: con «valor nocional» se rotula `USDC` y su mínimo es 1; con
> «cantidad de moneda» se rotula con la moneda del par y su mínimo pasa a ser el del mercado. Hasta
> el spec 030 decía `USDC` en los dos modos y exigía un mínimo de 1, así que «cantidad de moneda» no
> se podía usar en un par caro.

El tope de posición sigue siendo **nocional en los dos modos**: mide el valor de lo que tienes, no su
cantidad.

#### Acción al alcanzar el límite · `limitAction` · 🔥 en caliente · ⚠️ campo de riesgo

**Pausar entradas** (deja de cotizar el lado que añade) · **Cerrar todo** (liquida a mercado, una vez) · **Apagar** (cierra y detiene el bot).

**Consejo**: Pausar entradas.

### 5.2 Cotización

#### Distancia de compra · `buyDistanceBps` · 🔥 en caliente · 1–2000 bps · por defecto **20**

**Punto de PARTIDA** del diferencial de compra. **No es la distancia final**: el resto de la fórmula suma encima.

> Si te sorprende ver el bot cotizando más lejos de lo que escribiste, es exactamente esto.

#### Distancia de venta · `sellDistanceBps` · 🔥 en caliente · 1–2000 bps · por defecto **40**

El espejo. Simétricas si quieres neutralidad de verdad.

#### Distancia mínima permitida · `minAllowedDistanceBps` · 🔥 en caliente · 1–500 bps · por defecto **8**

Suelo duro absoluto. **Compite con el suelo calculado** (`comisión × 2 + margen mínimo`): **manda el más alto de los dos**.

> ℹ️ A diferencia de la V1, aquí no es un error que supere tus distancias de compra y venta: la app **avisa** de que las elevará hasta ahí, y de que la causa es esta distancia mínima (no la comisión ni el margen).

#### Estimación de comisión · `feeEstimateBps` · 🔥 en caliente · 0–100 bps · por defecto **2**

> ### 🔴 El campo más importante de esta estrategia.

Lo que te cobra el exchange **por lado**. Se cuenta **dos veces**, porque una vuelta completa son dos operaciones.

Entra dos veces en la fórmula: **eleva el suelo** por debajo del cual el bot no cotiza, **y** se suma a la distancia final para que el coste ya esté cubierto.

**Consejo**: ponla igual a tu **comisión real de maker** en ese exchange. Dejarla en 0 hace que el bot cotice como si operar fuese gratis y desactiva de hecho la garantía de beneficio: la app lo **avisa** al validar. Los bots nuevos nacen con 2 bps; los creados antes conservan el suyo.

#### Buffer de seguridad · `safetyBufferBps` · 🔥 en caliente · 0–200 bps · por defecto **0**

Colchón extra que se suma a la distancia final, por encima del coste ya calculado. Para no operar al filo del beneficio cero.

**Consejo**: 1–3 bps bastan. Subirlo mucho hace que el bot deje de ejecutar.

#### Margen mínimo de beneficio · `minProfitMarginBps` · 🔥 en caliente · 0–500 bps · por defecto **8**

Lo que tiene que quedar **limpio** después de comisiones en cada vuelta completa.

Junto con la comisión forma el **suelo**: por debajo de `comisión × 2 + este número`, el bot sencillamente no cotiza, aunque tus distancias sean menores.

Es **la garantía** de que un ciclo cerrado deja dinero. Si lo subes mucho, el bot cotiza tan lejos que casi no se ejecuta.

> La app te **avisa** si el suelo acaba siendo mayor que tus distancias base: significa que tu "40 bps" se va a convertir en otra cosa. Es un aviso, no un error.

#### Solo post-only · `postOnly` · 🔥 en caliente · por defecto **Sí**

Intenta colocar órdenes que no tomen liquidez de inmediato, para pagar siempre comisión de maker.

**Consejo**: **déjalo activado**. Toda la fórmula de coste asume que operas como maker; desactivarlo la invalida.

### 5.3 Spread dinámico

#### Spread dinámico · `dynamicSpread` · 🔥 en caliente · por defecto **Sí**

Activa la parte de la fórmula que ensancha con la volatilidad y la anchura del libro.

- **Desactivado**: la distancia final es solo tu base + coste de operar. Un número fijo.
- **Activado**: el bot se ensancha solo cuando el mercado se pone nervioso.

**Consejo**: es lo que distingue a esta versión. Desactivarlo la deja parecida a la V1 — y si eso es lo que quieres, usa la V1, que tiene la mitad de mandos.

#### Muestra de volatilidad · `volatilitySampleSeconds` · 🔥 en caliente · 30–3600 s · por defecto **300**

Ventana sobre la que se mide el recorrido del precio.

- **Corta**: reacciona enseguida a un susto, y también lo olvida enseguida.
- **Larga**: medida más estable y más lenta.
- ⚠️ Las muestras se toman **al recotizar**, no en cada instante: con refrescos lentos la ventana efectiva es menor de lo que parece.

#### Margen del libro de órdenes · `orderBookMarginBps` · 🔥 en caliente · 0–200 bps · por defecto **1,5**

Margen fijo que se suma **siempre** a la parte dinámica, haya volatilidad o no. Garantiza un mínimo de holgura.

**Consejo**: valores pequeños, 1–3 bps.

#### Multiplicador de volatilidad · `volatilityMultiplier` · 🔥 en caliente · 0–5 · por defecto **0,35**

**El mando principal de esta versión.** Cuánta parte de la volatilidad medida pasa al diferencial: con 0,35, una volatilidad de 20 bps añade 7.

- **Subirlo**: el bot se aparta mucho en cuanto hay movimiento. Protege del mercado en tendencia, a costa de ejecutar menos.
- **Con 0**: la volatilidad deja de influir.

**Consejo**: toca este antes que las distancias base.

#### Spread dinámico máximo · `maxDynamicSpreadBps` · 🔥 en caliente · 1–5000 bps · por defecto **100**

**Techo**: impide que un pico puntual mande la cotización tan lejos que deje de ejecutarse durante horas.

Se aplica **al total y por capa**, después de los multiplicadores de nivel, de preset y de modo de riesgo: ninguna capa cotiza más ancha que esto. Capar solo un sumando, o solo la capa 1, no cumpliría la promesa de "nunca cotizo más ancho de X".

> ⚠️ Dos matices reales del código:
>
> 1. **Tiene que quedar por encima del suelo calculado** (`comisión × 2 + margen mínimo`), o la app **rechaza** la configuración: el bot no podría cotizar con beneficio.
> 2. Con **0** no hay techo; la app lo avisa al validar.

### 5.4 Tiempos

#### Intervalo de actualización de órdenes · `refreshSeconds` · 🔥 en caliente · 15–3600 s · por defecto **30**

Cada cuánto se rehace la cotización aunque el precio no se mueva. Mínimo real **15 s** (el ritmo del motor). Una ejecución la rehace al instante.

#### Distancia para reajustar precio · `repriceThresholdBps` · 🔥 en caliente · 1–1000 bps · por defecto **30**

Cuánto tiene que moverse el precio para recotizar antes de tiempo.

- **Bajo**: sigue al mercado de cerca y cancela mucho (pierde prioridad en el libro).
- **Alto**: deja las órdenes quietas aunque el precio se aleje.
- **Consejo**: un valor cercano a tu distancia de cotización evita quedarte con órdenes ya fuera de mercado.

#### Actualizar órdenes después de · `orderMaxAgeSeconds` · 🔥 en caliente · 0–86400 s · por defecto **120**

Edad máxima de **cualquier** cotización viva antes de rehacerla, aunque el precio no se haya movido. Una orden vieja se calculó con un libro que ya no existe.

Con una excepción, y es importante: **no caduca el lado al que el mercado se está acercando**. Si el precio ha bajado desde tu última cotización, tus compras están más cerca de ejecutarse cuanto más tiempo pasa, y tirarlas por viejas sería tirarlas justo antes de cobrar (spec 035).

**Es un ajuste que la V1 no tiene.** Con 0, las órdenes no caducan por edad.

#### Espera tras un fill · `fillCooldownSeconds` · 🔥 en caliente · 0–3600 s · por defecto **35**

Congela la cotización tras una ejecución, para no perseguir al mercado que acaba de barrerla. Durante la espera tampoco caduca nada.

Viene con **35 s**, bastante más que en la V1 (0).

#### Mantener órdenes de salida durante · `exitOrderTtlSeconds` · 🔥 en caliente · 0–86400 s · por defecto **0**

Cuánto vive una orden **de salida** antes de rehacerla al precio nuevo. Solo aplica al lado que reduce inventario. Con 0, espera a su precio indefinidamente.

### 5.5 Niveles

#### Niveles de cotización · `layers` · 🌤️ en tibio · 1–10 · por defecto **1**

Cuántas órdenes escalonadas por lado.

**Viene con 1** (la V1 viene con 3). Con un solo nivel el bot deja de cotizar ese lado en cuanto se ejecuta, hasta la siguiente recotización — pero a cambio la fórmula es fácil de leer y el techo se cumple de verdad.

#### Multiplicador de distancia por nivel · `layerDistanceMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1**

Cuánto se aleja cada nivel del anterior. **Con 1** (el valor de fábrica) todos van a la misma distancia.

#### Multiplicador de tamaño por nivel · `layerSizeMultiplier` · 🌤️ en tibio · 0,1–3 · por defecto **1**

Cuánto crece cada nivel respecto del anterior. Por encima de 1 los lejanos mueven más dinero. **Consejo**: empieza en 1.

#### Usar tamaño normal hasta el máximo · `useFullSizeUntilMax` · 🔥 en caliente · por defecto **No**

Qué hacer con el último nivel cuando ya no cabe entero dentro del tope:

- **No** (por defecto) → se **recorta** al hueco que quede; si el recorte deja la capa por debajo del **mínimo del par**, no se coloca (antes salía y el exchange la rechazaba en cada recotización).
- **Sí** → **todo o nada**: se coloca completo o no se coloca.

**Consejo**: **actívalo** en pares con mínimos de orden altos, donde una capa recortada quedaría por debajo del mínimo y el exchange la rechazaría.

### 5.6 Riesgo

#### Umbral defensivo · `defensiveThresholdPct` · 🔥 en caliente · 1–100 % · por defecto **90**

Ocupación del tope a la que el bot aleja un 50 % el lado que añade y acerca un 40 % el que reduce.

> ⚠️ El 90 % de fábrica es **muy tardío**, y la V2 no tiene sesgo por inventario que ayude a deshacer. **Considera bajarlo a 60–70 %.**

Tiene que ser **menor** que el umbral de alto riesgo, o la app lo rechaza.

#### Umbral de alto riesgo · `highRiskThresholdPct` · 🔥 en caliente · 1–100 % · por defecto **100** · ⚠️ campo de riesgo

Ocupación a la que el bot **deja de añadir por completo**: solo queda vivo el lado que reduce, a la mitad de distancia y marcado `reduceOnly`.

> Con el **100 % de fábrica, este modo solo se activa justo al tocar el tope** — es decir, casi no actúa como aviso previo. Bájalo a 80–90 % si quieres margen de reacción.

### 5.7 Precio

#### Fuente de precio · `priceSource` · 🔥 en caliente · por defecto **Datos del exchange**

Contra qué precio se cotiza: el del propio exchange donde opera el bot, o **Binance** como referencia externa.

⚠️ Con Binance, **si la fuente se cae o se queda rancia el bot DEJA DE COTIZAR** y retira sus órdenes, en vez de volver en silencio al precio local.

**Consejo**: Binance tiene sentido en DEX que se desvían del mercado global. Recuerda que añade una dependencia externa.

#### Origen del precio justo · `fairPriceOrigin` · 🔥 en caliente · por defecto **Global desde la fuente**

De dónde sale exactamente el precio de referencia:

| Opción                           | Qué usa                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| **Global desde la fuente**       | El precio de la Fuente de precio elegida (Binance, si la elegiste) |
| **Medio del exchange**           | El punto medio del libro donde opera el bot                        |
| **Precio de marca del exchange** | El que ese exchange usa para liquidar; más estable que el medio    |

⚠️ Para anclar a Binance hacen falta **las dos cosas**: `Fuente = Binance` **y** `Origen = Global desde la fuente`. Con "Medio del exchange" o "Precio de marca", la fuente externa se ignora.

#### Tipo de mercado de origen · `sourceMarketType` · 🔥 en caliente · por defecto **Perpetuo**

Qué mercado de Binance se consulta:

- **Perpetuo**: el más parecido a lo que operas en un DEX de perpetuos.
- **Spot**: no arrastra la prima del perpetuo.
- **Índice**: media de varios mercados, el más estable.

#### Símbolo de origen alternativo · `sourceSymbolOverride` · 🔥 en caliente · opcional

El nombre exacto del par en Binance, cuando allí no se llama igual.

Por defecto el bot pide `<base>USDT`: BTC → `BTCUSDT`. Si ese nombre no existe en Binance, no hay precio y el bot no cotiza.

**Caso típico**: kPEPE en un DEX es **`1000PEPEUSDT`** en Binance. Déjalo vacío si el nombre coincide.

#### Piso de precio · `priceFloor` · 🔥 en caliente · opcional

Por debajo de este precio el bot **solo reduce, no abre**: desactiva el lado que abriría posición corta nueva.

#### Techo de precio · `priceCeiling` · 🔥 en caliente · opcional

Por encima de este precio el bot **solo reduce, no abre**: desactiva el lado que abriría posición larga nueva.

> Las bandas cortan **solo el lado que abre**. El lado que te saca de la posición sigue siempre vivo.

### 5.8 Condición de activación

#### Condición de activación · `activationMode` · 🔥 en caliente · por defecto **Sin condición**

**Sin condición** · **Cuando suba a** · **Cuando baje a**.

Con una condición puesta, el bot **no coloca ni una orden** hasta que el precio cruce el disparador. Una vez armado se queda armado **mientras el bot viva**: un par casado no cierra el ciclo ni borra el armado. Parar y volver a arrancar el bot sí vuelve a evaluar la condición.

#### Precio de disparo · `activationPrice` · 🔥 en caliente · obligatorio si hay condición

El precio que tiene que cruzarse. Con una condición de activación puesta, la app **exige** un precio mayor que cero.

**Consejo**: ponlo donde de verdad quieras empezar a cotizar, no donde está el precio hoy.

### 5.9 Exchange

#### Modo de posición · `positionMode` · ❄️ en frío · por defecto **Automático**

⚠️ Importa más aquí que en ninguna otra estrategia: en **cobertura**, un market maker neutral acumula las dos patas a la vez en vez de compensarlas, y **paga margen por las dos**. **Deja Automático.**

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50x · por defecto **1** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida por igual, y acerca la liquidación. A 2x necesitas un movimiento adverso cercano al 50 %; a 10x, cercano al 10 %.

Es **en tibio** porque el venue puede rechazar el cambio con posición abierta y mueve el precio de liquidación.

**Consejo**: **1x** (el valor de fábrica de la V2). Por encima de 10x la app avisa.

#### Modo de margen · `marginMode` · ❄️ en frío

**Aislado**: el peor caso es el margen asignado a este bot, y la liquidación llega antes. **Cruzado**: liquidación más lejos, pero una posición perdedora puede arrastrar el saldo del resto de bots de esa cuenta. **La V2 viene en cruzado** de fábrica.

### 5.10 Comunes que aplica el motor (o que no aplica nadie)

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera (real, pruebas o simulación). El simulador es algo optimista para un market maker ([simulación y backtest](./simulacion-y-backtest.md#qué-hace-el-simulador-exactamente)); el backtest no reproduce refresco, espera ni volatilidad (F-65).

#### Par · `symbol` · ❄️ en frío

Fija tick, paso y mínimo. Con el preset Conservador el tamaño baja al 70 % y la vista previa ya lo enseña así: si una capa cae por debajo del mínimo, la vista previa no es válida.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

**No dimensiona órdenes** (lo hacen Tamaño por compra/venta y Niveles). Es el denominador de la Pérdida diaria máxima y del kill-switch por pérdida acumulada.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

> ⚠️ **Esta estrategia lo ignora** (§4). El tope real es **Inversión / posición máxima**.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · 0,1–90 · ⚠️ campo de riesgo

Orden condicional nativa sobre el precio medio, con la dirección del signo de la posición real ([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)). Convive con la **Acción al alcanzar el límite**: el aplanado usa su propio id, así que «Cerrar todo» y «Apagar» salen aunque haya stop.

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % del capital asignado, a partir de la cual se pausa conservando el stop.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo cuando la distancia a la liquidación baja del umbral de aviso.

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

> ⚠️ **Sin efecto en esta estrategia** (§4). Usa **Espera tras un fill**.

---

## 6. Resumen de valores de fábrica

Útil para ver de un vistazo qué te vas a encontrar al crear el bot:

| Campo                              | Por defecto        | ¿Lo cambio?                             |
| ---------------------------------- | ------------------ | --------------------------------------- |
| Dirección                          | Neutral            | ✅ Déjalo                               |
| Comportamiento                     | Equilibrado        | ✅ Déjalo                               |
| Apalancamiento                     | 1x                 | ✅ Déjalo                               |
| Distancia compra / venta           | 20 / 20 bps        | Según el par                            |
| Distancia mínima permitida         | 8 bps              | ✅ Déjalo                               |
| **Estimación de comisión**         | 2 bps              | 🟡 Ajústala a tu comisión real de maker |
| Buffer de seguridad                | 0 bps              | 1–3 bps                                 |
| Margen mínimo de beneficio         | 8 bps              | ✅ Déjalo o súbelo                      |
| Solo post-only                     | Sí                 | ✅ Déjalo                               |
| Umbral defensivo                   | 90 %               | 🟡 Bájalo a 60–70 %                     |
| Umbral de alto riesgo              | 100 %              | 🟡 Bájalo a 80–90 %                     |
| Intervalo de actualización         | 30 s               | ✅ Déjalo                               |
| Distancia para reajustar           | 30 bps             | ✅ Déjalo                               |
| Actualizar órdenes después de      | 300 s              | ✅ Déjalo                               |
| Espera tras un fill                | 35 s               | ✅ Déjalo                               |
| Mantener órdenes de salida         | 0 (nunca caducan)  | ✅ Déjalo                               |
| Spread dinámico                    | Sí                 | ✅ Déjalo                               |
| Muestra de volatilidad             | 300 s              | ✅ Déjalo                               |
| Margen del libro                   | 1,5 bps            | ✅ Déjalo                               |
| Multiplicador de volatilidad       | 0,35               | El mando principal                      |
| Spread dinámico máximo             | 100 bps            | ✅ Déjalo                               |
| Niveles de cotización              | 1                  | ✅ Déjalo para empezar                  |
| Usar tamaño normal hasta el máximo | No                 | 🟡 Sí en pares con mínimos altos        |
| Fuente de precio                   | Datos del exchange | Solo Binance si operas en DEX           |
| Condición de activación            | Sin condición      | Solo si quieres esperar a un precio     |

---

## 7. ¿V2 o V1?

Ver la tabla comparativa completa en la **[guía de la V1, sección 6](./market-maker.md#6-v1-o-v2)**.

En una línea:

- **V1** → control directo y predecible del diferencial, menos mandos, tiene sesgo por inventario.
- **V2** → el bot se adapta solo al ritmo del mercado y **garantiza que cada vuelta completa deja beneficio limpio después de comisiones** — siempre que le digas cuál es tu comisión.

---

## 8. Limitaciones conocidas (hallazgos abiertos)

Confirmadas en `specs/001-revision-integral/findings.md`. La que la V2 compartía con la V1 —F-54, el
sondeo de ejecuciones en Lighter— quedó **resuelta en el spec 036**: ver
[la nota de la V1](./market-maker.md#7-limitaciones-conocidas-hallazgos-abiertos).
