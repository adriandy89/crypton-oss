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
DIFERENCIAL (por lado) = tu distancia base
                       + margen fijo del libro
                       + (volatilidad medida × tu multiplicador)   ← cuanto más nervioso el mercado, más ancho
                       + (comisión × 2)                            ← lo que cuesta abrir y cerrar
                       + tu buffer de seguridad

y luego lo encaja entre dos límites:

SUELO  = MAX( distancia mínima permitida , comisión × 2 + margen mínimo de beneficio )
TECHO  = spread dinámico máximo

DIFERENCIAL FINAL = MAX( SUELO , MIN( TECHO , lo de arriba ) )
```

Cada lado lleva la suma entera: con distancias de 20/20, la compra y la venta salen **cada una** a 20 + la parte dinámica + 4 de comisión de ida y vuelta (con 2 bps por lado) + el colchón. La **parte dinámica** —margen del libro más volatilidad— solo se suma con el spread dinámico encendido, que es como viene.

Eso da **dos garantías** que la V1 no puede dar:

1. **Nunca cotizas por debajo de lo que cuesta operar.** Si tu comisión es 2 bps y quieres 8 bps limpios, el suelo es 12 bps. Aunque escribas "5 bps de distancia", el bot cotizará como mínimo a 12: es lo que enseña la vista previa, con el aviso de que las distancias «se elevarán hasta ahí». Un par casado alrededor del mismo precio deja siempre, como poco, ese margen limpio. (Si el precio se va entre la compra y la venta, no: la salida puede quedar por debajo de tu coste; ver el ajuste de precio por inventario, §5.8.)
2. **El bot se ensancha solo cuando el mercado se pone nervioso**, y se estrecha solo cuando se calma. Sin que toques nada.

### Y dos capacidades más

- **Puede cotizar contra el precio de Binance** en vez del libro de tu exchange. Importante en un DEX pequeño, donde tus propias órdenes _son_ el precio: anclarte a tu propio libro es un bucle. Y si esa fuente externa se cae, **el bot retira sus órdenes** en lugar de volver en silencio al precio local.
- **Puede esperar a un precio de disparo** antes de empezar a cotizar.

### El precio a pagar

**Es la estrategia con más parámetros de la plataforma.** Y hay una consecuencia que sorprende a todo el mundo la primera vez:

> Escribes "20 bps de distancia" —el valor de fábrica— y la vista previa enseña 25,5; con el mercado moviéndose 20 bps, el bot cotiza a 32,5. **No está roto.** La fórmula suma.

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
- Alguna orden ha superado su **Actualizar órdenes después de** (300 s por defecto), **o**
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

El inventario también mueve el **centro** de la cotización, igual que en la V1: el **Ajuste de precio por inventario** viene encendido de fábrica, con factor 1 (§5.8). Con posición larga el centro baja —la venta queda más cerca y la compra más lejos—, con la misma fórmula:

```
centro = precio × (1 − sesgo × ratio × distancia_media / 10.000)
ratio  = exposición / Inversión máxima, acotado entre −1 y +1
```

El sesgo no deja de añadir: solo inclina la cotización hacia la salida. Lo que corta el lado que añade son el modo de alto riesgo, el tope, las bandas de precio, la puerta de régimen y el filtro de funding.

### Paso 6 — Componer el diferencial

Esta es la parte característica. Con la configuración de fábrica y una volatilidad medida de 20 bps:

| Componente                                 | Cálculo         | bps       |
| ------------------------------------------ | --------------- | --------- |
| Distancia base                             | tu campo        | 20,00     |
| Margen del libro                           | fijo            | +1,50     |
| Volatilidad                                | 20 × 0,35       | +7,00     |
| Coste ida y vuelta                         | comisión × 2    | +4,00     |
| Buffer de seguridad                        | fijo            | +0,00     |
| **Bruto**                                  |                 | **32,50** |
| Se aplica el suelo: máx(8 ; 2×2 + 8) = 12  | máx(12 ; 32,50) | **32,50** |

Es lo de cada lado: con el precio a 100.000, compra en 99.675 y venta en 100.325. Sin volatilidad medida —lo que enseña la vista previa, que no tiene histórico— son 20 + 1,5 + 4 = **25,50 bps**.

Y luego, **por capa**, con el techo al final:

```
distancia_capa = MAX( SUELO ,  MIN( TECHO ,  diferencial × mult_distancia^capa × preset × modo_riesgo ) )
```

El techo (100 por defecto) se aplica **después** de los multiplicadores de capa, de preset y de modo de riesgo: ninguna capa cotiza más ancha que el techo, y el suelo por coste sigue mandando por debajo (la app rechaza un techo menor que el suelo). Con el campo **vacío** no hay techo, y la app lo avisa; un 0 no se admite, porque el mínimo del campo es 1.

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

La vista previa hace el mismo recorte con el inventario a cero —hasta el spec 080 enseñaba las capas enteras— y avisa cuando las capas de un lado suman más que el tope. Con 3 niveles de 50 USDC y un tope de 120, el tercero sale recortado a lo que queda, unos 20 USDC (con «Sí», no sale); con las cantidades ya redondeadas al paso del par, la Revisión enseña 49,87, 49,83 y 19,91, y el aviso dice: «Las capas de un lado suman 150.00, por encima del tope de posición (120.00): las más profundas se recortan o no llegan a colocarse.»

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
3. **Baja los umbrales de riesgo de fábrica.** 90 / 100 son muy tardíos: el modo defensivo casi no llega antes del tope. El sesgo por inventario, encendido de fábrica, empuja hacia posición cero, pero no deja de añadir. 60 / 80 es mucho más prudente.
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

**Qué cotiza con BTC a 100.000 USDC y una volatilidad medida de 20 bps** (ficha de BTC en Lighter):

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

Una vuelta completa deja **118,5 bps brutos** − 4 bps de comisión ≈ **114,5 bps netos**. Al redondear al paso del par cada orden lleva 0,00017 BTC, unos 17 USDC: ≈ **0,20 USDC** brutos por vuelta y ≈ 0,19 netos.

**Y si el mercado se calma** (volatilidad 5 bps): 25 + 1,5 + 1,75 + 4 + 2 = 34,25 → × 1,5 = **51,4 bps**. El bot se ha estrechado solo. Ese es el punto de la V2.

En la Revisión, que no tiene volatilidad medida, salen 32,5 × 1,5 = 48,75 bps: compra en 99.512,5 y venta en 100.487,5. Y dos lados que no se suman ([cómo se leen](./market-maker.md#qué-enseña-la-vista-previa)): a 1x el **largo** no tiene liquidación —el precio tendría que llegar a cero— y el **corto** sí, en 196.073,1, un 95,12 % por encima de su entrada (mantenimiento del 2,5 %).

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

Con 2 capas de 50 USDC hay **100 USDC comprometidos por lado** (la Revisión enseña 99,70 en el largo y 98,30 en el corto, con las cantidades ya redondeadas), holgados frente al tope de 600.

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
- [ ] ¿He mirado la vista previa? _(muestra el diferencial en reposo, sin volatilidad: es el mínimo que va a cotizar; y cada lado, largo y corto, con su liquidación)_

### Señales de alarma cuando ya está funcionando

El bot escribe una nota muy informativa en cada revisión:

> `Diferencial 34.3/34.3 bps (vol 25.1), inventario 34 % del tope, 2 cotizaciones.`

Con los valores de fábrica y 25,1 bps de volatilidad: 20 + 1,5 + 25,1 × 0,35 + 4 ≈ 34,3 bps por lado.

| Lo que ves                                             | Qué significa                                                    | Qué hacer                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| El diferencial es **mucho** mayor de lo que escribiste | Normal: la fórmula suma. Si es exagerado, mira `vol`             | Baja el **Multiplicador de volatilidad** o el **Spread dinámico máximo**       |
| `vol` altísima y casi ninguna ejecución                | El bot se ha alejado por un mercado nervioso                     | Es lo correcto; espera, o baja el multiplicador de volatilidad                 |
| El diferencial **no cambia nunca**                     | O el spread dinámico está apagado, o estás pegado al suelo/techo | Comprueba el suelo: `comisión × 2 + margen mínimo`                             |
| `Sin precio de referencia de binance`                  | La fuente externa no responde                                    | Espera, o cambia a **Datos del exchange**                                      |
| `Esperando a que el precio…`                           | La condición de activación no se ha cumplido                     | Nada; o quita la condición                                                     |
| Inventario que sube y **nunca baja**                   | Mercado en tendencia                                             | **Baja los umbrales de riesgo**, y comprueba que siguen encendidos el ajuste de precio por inventario y la puerta de régimen |
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
ejecutar**. Revisa tu **Inversión / posición máxima** y la **acción al alcanzar el límite** antes de ponerlo en
real: esa red nunca había hecho falta porque nunca había inventario que topar.

---

## 4. Lo que este bot NO mira (importante)

| Campo                                       | Realidad                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capital asignado** (`totalInvestment`)    | No dimensiona órdenes: el tamaño lo mandan **Tamaño por compra/venta** y **Niveles**. Es la base del resultado del bot y de la **Pérdida diaria máxima**. Para tus límites de nocional cuenta la **Inversión / posición máxima**. |
| **Espera entre ciclos** (`cooldownMinutes`) | Es para estrategias con ciclos que abren y cierran. Aquí usa **Espera tras un fill**.                                                                                                                               |

El **Tope de exposición** común (`maxNotionalCap`) ya no sale en el formulario (spec 080): esta estrategia no lo leía. Su tope es la **Inversión / posición máxima**.

Sí funcionan, aplicados por el motor: **Stop loss** (orden condicional nativa en el exchange, sigue viva aunque la plataforma se caiga; es un **% del margen** medido desde el precio medio de la posición y su dirección sale del **signo de la posición real**), **Pérdida diaria máxima** y **Al acercarse la liquidación**.

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
- Contra él se **recorta** el tamaño del último nivel que cabe (ver `useFullSizeUntilMax`), también en la vista previa.
- Es el **nocional** del bot para tus límites de riesgo, el de cada bot y el total: desde el spec 080 la API lo mide con este campo, que es lo que el bot puede abrir de verdad, y no con capital × apalancamiento.

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

#### Distancia de venta · `sellDistanceBps` · 🔥 en caliente · 1–2000 bps · por defecto **20**

El espejo. Simétricas si quieres neutralidad de verdad.

#### Distancia mínima permitida · `minAllowedDistanceBps` · 🔥 en caliente · 1–500 bps · por defecto **8**

Suelo duro: ninguna capa cotiza más cerca del centro de la cotización que esto (el centro lo mueve el sesgo por inventario; contra cruzar el libro, la orden se pega al toque). **Compite con el suelo calculado** (`comisión × 2 + margen mínimo`): **manda el más alto de los dos**.

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

Es **la garantía** de que un par casado alrededor del mismo precio deja dinero (§1). Si lo subes mucho, el bot cotiza tan lejos que casi no se ejecuta.

> La app te **avisa** si el suelo acaba siendo mayor que tus distancias base: significa que tus "5 bps" se van a convertir en otra cosa (12, con la comisión y el margen de fábrica). Es un aviso, no un error.

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
> 1. **Tiene que quedar por encima del suelo calculado** (`comisión × 2 + margen mínimo`), o la app **rechaza** la configuración: el bot no podría cotizar con beneficio. Con los valores de fábrica el suelo es 12, así que un techo de 10 se rechaza.
> 2. **Vacío** no hay techo, y la app lo avisa al validar («Sin techo del diferencial: con volatilidad alta el bot puede cotizar tan lejos que no ejecute en horas»). Un **0** no es «sin techo»: el mínimo del campo es 1 y se rechaza.

### 5.4 Tiempos

#### Intervalo de actualización de órdenes · `refreshSeconds` · 🔥 en caliente · 15–3600 s · por defecto **30**

Cada cuánto se rehace la cotización aunque el precio no se mueva. Mínimo real **15 s** (el ritmo del motor). Una ejecución la rehace al instante.

#### Distancia para reajustar precio · `repriceThresholdBps` · 🔥 en caliente · 1–1000 bps · por defecto **30**

Cuánto tiene que moverse el precio para recotizar antes de tiempo.

- **Bajo**: sigue al mercado de cerca y cancela mucho (pierde prioridad en el libro).
- **Alto**: deja las órdenes quietas aunque el precio se aleje.
- **Consejo**: un valor cercano a tu distancia de cotización evita quedarte con órdenes ya fuera de mercado.

#### Actualizar órdenes después de · `orderMaxAgeSeconds` · 🔥 en caliente · 0–86400 s · por defecto **300**

Edad máxima de **cualquier** cotización viva antes de rehacerla, aunque el precio no se haya movido. Una orden vieja se calculó con un libro que ya no existe.

Con una excepción, y es importante: **no caduca el lado al que el mercado se está acercando**. Si el precio ha bajado desde tu última cotización, tus compras están más cerca de ejecutarse cuanto más tiempo pasa, y tirarlas por viejas sería tirarlas justo antes de cobrar (spec 035).

**Es un ajuste que la V1 no tiene.** Con 0, las órdenes no caducan por edad.

#### Espera tras un fill · `fillCooldownSeconds` · 🔥 en caliente · 0–3600 s · por defecto **35**

Congela la cotización tras una ejecución, para no perseguir al mercado que acaba de barrerla. Durante la espera tampoco caduca nada.

Viene con **35 s**, bastante más que en la V1 (0).

#### Mantener órdenes de salida durante · `exitOrderTtlSeconds` · 🔥 en caliente · 0–86400 s · por defecto **0**

Cuánto vive una orden **de salida** antes de rehacerla al precio nuevo. Solo aplica al lado que reduce inventario. Con 0, espera a su precio indefinidamente.

> ⚠️ Igual que la caducidad por edad, **no caduca el lado al que el mercado se está acercando** (spec 037). Al recotizar, el centro se mueve con el precio: recolocar una salida que el mercado viene a buscar la **aleja**, justo el tick antes de cobrarla.

### 5.5 Niveles

#### Niveles de cotización · `layers` · 🌤️ en tibio · 1–10 · por defecto **1**

Cuántas órdenes escalonadas por lado.

**Viene con 1** (la V1 viene con 3). Con un solo nivel el bot deja de cotizar ese lado en cuanto se ejecuta, hasta la siguiente recotización — pero a cambio la fórmula es fácil de leer y el techo se cumple de verdad.

#### Multiplicador de distancia por nivel · `layerDistanceMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1**

Cuánto se aleja cada nivel del anterior. **Con 1** —el valor de fábrica— todos caerían al mismo precio, así que **la app rechaza esa combinación en cuanto hay más de un nivel**: si subes `Niveles de cotización`, sube también este número (1,3–1,5 es lo normal).

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

> ⚠️ El 90 % de fábrica es **muy tardío**. El sesgo por inventario, encendido de fábrica, empuja hacia posición cero, pero no deja de añadir. **Considera bajarlo a 60–70 %.**

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

#### No abrir cortos por debajo de · `priceFloor` · 🔥 en caliente · opcional

Por debajo de este precio el bot **no abre cortos nuevos**: desactiva las ventas que abrirían o
agrandarían un corto. Sigue comprando —bajo el suelo el bot aún puede acumular— y sigue vendiendo para
reducir un largo.

#### No abrir largos por encima de · `priceCeiling` · 🔥 en caliente · opcional

Por encima de este precio el bot **no abre largos nuevos**: desactiva las compras que abrirían o
agrandarían un largo. Sigue vendiendo y sigue comprando para cerrar un corto. Es el freno para no
acumular inventario caro en un bot con sesgo largo.

> Las bandas cortan **solo el lado que abre**. El lado que te saca de la posición sigue siempre vivo.


### 5.8 Microestructura — mirar algo más que el punto medio

Los mandos de microestructura nacen **apagados**, y se encienden de uno en uno mirando la nota del
bot. No son ajustes finos: cada uno cambia dónde cotiza el bot. Las dos excepciones van al final de
esta sección y vienen **encendidas** de fábrica: el ajuste de precio por inventario y la puerta de
régimen.

> ⚠️ **En Lighter, tres de ellos no hacen nada.** El microprecio, el sesgo por desequilibrio y los
> dos de funding necesitan datos que ese venue no publica (`docs/venues-y-minimos.md` §7). No
> fallan: se comportan como si estuvieran apagados.

#### Precio justo · `fairPriceMode` · 🔥 en caliente · por defecto **Punto medio**

El punto medio `(mejor compra + mejor venta) / 2` **ignora cuánta cantidad hay a cada lado**. Si
hay 30 BTC esperando para comprar y 1 para vender, el precio no está en el medio: está a punto de
subir.

El **microprecio** pondera cada precio por la cantidad del lado contrario:

```
microprecio = (venta × cantidad_compra + compra × cantidad_venta) / (cantidad_compra + cantidad_venta)
```

Con 99,90 / 100,10 y cantidades 30 / 10, sale **100,05** en vez de 100,00: el bot cotiza sus dos
lados cinco céntimos más arriba, que es donde el mercado está yendo.

**Es el primero que conviene probar.** Sin tamaños del libro se comporta exactamente igual que el
punto medio.

#### Sesgo por desequilibrio del libro · `obiSkewFactor` · 🔥 en caliente · 0–2 · por defecto **0**

Cuánto desplaza la cotización el desequilibrio `(cantidad_compra − cantidad_venta) / (suma)`, que
va de −1 a +1. El desplazamiento es `factor × desequilibrio × distancia_base`.

**Empieza en 0,3–0,5.** Cuanto más alto, más se mueve el centro, y cada movimiento que pase de la
distancia de reajuste es una recotización más: se paga en cuota del venue y en prioridad de cola.

#### Sesgo de tamaño por inventario · `sizeSkewFactor` · 🔥 en caliente · 0–1 · por defecto **0**

Sesga **el tamaño** en vez del precio: con posición larga, las compras se hacen más pequeñas
(`× (1 − factor × ocupación)`) y las ventas más grandes (`× (1 + …)`).

Es más suave que mover distancias, porque **no aleja el lado por el que quieres salir**. Con el
tope lleno y el factor a 1, el lado que añade desaparece — lo mismo que ya hace el modo de alto
riesgo.

#### Sesgo por funding · `fundingSkewFactor` · 🔥 en caliente · 0–3 · por defecto **0**

En un perpetuo, mantener posición **cobra o paga cada periodo**. El funding dice qué lado está
siendo pagado, y este mando inclina la cotización hacia ese lado:

| Funding | Quién paga | Qué hace el bot |
|---|---|---|
| Positivo | Los largos | Baja el centro: vende más cerca y compra más lejos ⇒ tiende a quedarse **corto**, que es quien cobra |
| Negativo | Los cortos | Sube el centro ⇒ tiende a quedarse **largo** |

**El signo sale del funding, no de tu posición**, y eso sorprende. Es correcto: funciona igual
estando largo (te saca antes del lado que paga) que estando corto (te mantiene en el que cobra).

**Mídelo antes de confiar en él.** Mira unos días qué funding tiene tu par: con 1 bp por hora y
factor 1, el centro se mueve 1 bp — poco. Con 30 bps en un día de euforia, se mueve 30.

#### Funding máximo en contra · `maxAdverseFundingBps` · 🔥 en caliente · 0–100 · por defecto **0**

Por encima de ese funding, el bot **deja de abrir** posición del lado que paga. El lado que reduce
inventario sigue vivo **siempre**: cortar los dos te dejaría atrapado.

Un funding extremo y sostenido suele querer decir que todo el mundo está del mismo lado. No es el
mando para empezar.

#### Horizonte de markout · `markoutHorizonSeconds` · 🔥 en caliente · 0–300 s · por defecto **0**

**La medida de si te están eligiendo.** Para cada ejecución, mira dónde está el mercado N segundos
después:

- Te compran a 100 y el mercado se va a 99 ⇒ markout **negativo**: quien te compró sabía algo.
- Te compran a 100 y el mercado sube a 101 ⇒ markout positivo: cobraste el diferencial.

Con 0 no se mide nada y no se guarda nada. **30–60 s** es lo razonable: por debajo mide ruido.

**Enciéndelo con la sensibilidad en 0.** Así lo ves en la nota del bot —`markout −3,1/+0,8 bps`—
durante unos días sin que cambie una sola orden.

#### Sensibilidad al markout · `markoutSensitivity` · 🔥 en caliente · 0–3 · por defecto **0**

Cuánto se **aleja** un lado cuando su markout es negativo: se suma
`max(0, −markout) × sensibilidad` bps a la distancia de ese lado. Si te están comprando barato,
tus compras se alejan y tus ventas no se tocan.

**Un markout bueno no acerca la cotización.** El suelo está en cero a propósito: perseguir al
mercado cuando te va bien es la otra forma conocida de perder dinero haciendo de creador de
mercado.


#### Ajuste de precio por inventario · `inventoryPriceAdjustment` · 🔥 en caliente · por defecto **Sí**

**Lo que la V2 no tenía y la V1 sí.** Desplaza el centro en contra del inventario: con posición
larga baja, así que la venta queda más cerca y la compra más lejos, y el bot tiende solo a volver
a cero.

Hasta el spec 039, lo único que reaccionaba al inventario en esta versión eran los modos de
riesgo, y **de fábrica entran al 90 %** — es decir, casi nunca. Por eso esta guía recomendaba
bajarlos a mano.

**Viene encendido desde el spec 071**, con factor 1, igual que la V1. Llegó apagado en el 039 por
prudencia con los bots que ya corrían, y esa prudencia costaba dinero. **No lo apagues.**

> ⚠️ **Lo que cuesta no encenderlo, medido.** Ningún market maker lee el precio de entrada de la
> posición: las dos cotizaciones salen del precio de mercado. Sin este ajuste, en cuanto el precio se
> va, **la venta se planta por debajo de tu coste medio** y realiza una pérdida que la estrategia
> nunca quiso hacer — el beneficio está acotado por el diferencial, y la pérdida no.
>
> Con el motor real sobre ocho pares y veinte días de velas de 5 minutos, con los valores de fábrica:
>
> | | cierres | media |
> |---|---|---|
> | por **encima** del coste medio | 52 % | +0,455 |
> | por **debajo** del coste medio | **48 %** | **−0,777** |
>
> Un cierre malo pesa **1,71 veces** lo que pesa uno bueno. Y las comisiones fueron 63 USDC de una
> pérdida de 520: **no se pierde por lo que se paga, sino por dónde se pone la salida.**
>
> Encendiendo este ajuste con factor 1, la pérdida realizada baja un **44 %**; con el sesgo de tamaño
> también, un **54 %**. Sigue siendo negativa, pero eso ya es el replay, que no tiene flujo
> ([por qué](./simulacion-y-backtest.md#lo-que-el-backtest-no-reproduce)).

#### Sesgo por inventario · `inventorySkewFactor` · 🔥 en caliente · 0–3 · por defecto **1**

Con cuánta fuerza. **1** es el valor con el que la V1 lleva funcionando desde siempre, y el que esta
versión trae desde el spec 071. Subirlo hace que el bot corra más por deshacerse del inventario, a costa de vender antes
de tiempo en un movimiento que le venía bien.

#### Puerta de régimen · `regimeGuard` · ❄️ al arrancar · por defecto **evita tendencia**

**La respuesta al único riesgo de verdad de esta estrategia**: que el precio no vaya y venga, sino
que se vaya en línea recta.

Mira el régimen del mercado sobre velas de **15 minutos y 1 hora** —el mismo clasificador que usan
los bots de IA— y tiene tres posiciones:

| valor | qué hace | tiempo abriendo |
|---|---|---|
| apagada | nada, y ni siquiera pide velas | 100 % |
| **evita tendencia** (de fábrica) | en tendencia deja de ABRIR del lado que acumula contra ella | ~62 % |
| **solo rango** | solo abre en mercado lateral o comprimido | ~9 % |

**Nunca para el bot.** El lado que reduce inventario sigue cotizando siempre, igual que con las
bandas de precio: retirarlo dejaría a la posición sin salida, que es lo contrario de lo que se
busca.

Viene en **evita tendencia** y cambiarla es `COLD` —hay que parar el bot— porque decide si el motor
pide velas. Apagándola no pide ninguna: un market maker suele correr en muchos bots a la vez y cada
sondeo cuenta contra el cupo de peticiones del venue. Ese coste se paga a propósito.

**Lo que aporta, medido.** Con el motor real sobre ocho pares y 120 días de velas de 5 minutos,
ella y el ajuste de precio por inventario llevan juntas el resultado del replay de **−19,9 % a
−11,4 %**, mejor en **7 de 8 pares**. (Sigue negativo, y eso es el replay, que no tiene flujo.)

**Por qué esta y no el filtro que había.** Hasta el spec 071 existía un segundo mando que medía la
eficiencia de Kaufman sobre las muestras de los últimos **segundos**. Se quitó: medido sobre 26
pares y 400 días discriminaba **+0,015 puntos** —dentro del ruido— contra los **+0,156** de esta
puerta con el mismo tiempo activo. La razón es de escala de tiempo, y el inventario de un market
maker se envenena a lo largo de **horas**. Dos mandos para la misma pregunta, uno de ellos que no
funciona, es peor que uno solo.

#### Estimador de volatilidad · `volEstimator` · 🔥 en caliente · por defecto **Recorrido**

Cómo se convierte en un número el movimiento del precio de la ventana.

- **Recorrido**: `(máximo − mínimo) / media`. Simple, pero **crece con el número de muestras**: dos
  bots con la misma volatilidad real pero distinto ritmo de refresco miden cosas distintas. Y
  desde el spec 035 el ritmo de refresco depende de si el mercado se está acercando, así que el
  número depende de algo que no es la volatilidad.
- **Parkinson**: divide por `√(2 · ln n)`, que es como crece el recorrido de un paseo aleatorio
  con el número de observaciones. Quita esa dependencia.

> ⚠️ **Parkinson da números mucho más pequeños.** Con 20 muestras divide por 2,4; con 200, por
> 3,3. Al cambiarlo hay que **volver a ajustar el multiplicador de volatilidad**, o el bot dejará
> de ensancharse cuando debía. Por eso no es el valor de fábrica.


### 5.9 Condición de activación

#### Condición de activación · `activationMode` · 🔥 en caliente · por defecto **Sin condición**

**Sin condición** · **Cuando suba a** · **Cuando baje a**.

Con una condición puesta, el bot **no coloca ni una orden** hasta que el precio cruce el disparador. Una vez armado se queda armado **mientras el bot viva**: un par casado no cierra el ciclo ni borra el armado. Parar y volver a arrancar el bot sí vuelve a evaluar la condición.

#### Precio de disparo · `activationPrice` · 🔥 en caliente · obligatorio si hay condición

El precio que tiene que cruzarse. Con una condición de activación puesta, la app **exige** un precio mayor que cero.

**Consejo**: ponlo donde de verdad quieras empezar a cotizar, no donde está el precio hoy.

### 5.10 Exchange

#### Modo de posición · `positionMode` · ❄️ en frío · por defecto **Automático**

⚠️ Importa más aquí que en ninguna otra estrategia: en **cobertura**, un market maker neutral acumula las dos patas a la vez en vez de compensarlas, y **paga margen por las dos**. **Deja Automático.**

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50x · por defecto **1** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida por igual, y acerca la liquidación. Con la fórmula exacta y BTC en Hyperliquid (mantenimiento del 1,25 %): a 1x un largo no tiene liquidación y un corto la tiene con un 97,53 % en contra; a 2x, 49,37 % en largo y 48,15 % en corto; a 10x, 8,86 % y 8,64 % ([riesgo §2](./riesgo-y-liquidacion.md#2-la-fórmula-de-la-liquidación)). En dirección Neutral la regla del 5 % se mide contra el corto, que liquida antes: en ese par, **15x como mucho** ([riesgo §4](./riesgo-y-liquidacion.md#4-el-semáforo-y-la-regla-del-5-)). La API la repite al arrancar, con el mercado de ese día.

Es **en tibio** porque mueve la liquidación y el stop de lo que ya está abierto. Por eso, con la posición abierta, la API no deja cambiarlo (409, `LEVERAGE_WITH_POSITION`): el stop es un % del margen y se movería con él.

**Consejo**: **1x** (el valor de fábrica de la V2). Por encima de 10x la app avisa con la distancia exacta y lo que se habrá perdido del margen al llegar.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Cruzado**

**Aislado**: el peor caso es el margen asignado a este bot, y la liquidación llega antes; la app rechaza un stop que quede en ella o detrás. **Cruzado**: liquidación más lejos —la Revisión la rotula como «cota»— y la regla del stop solo avisa, pero una posición perdedora puede arrastrar el saldo del resto de bots de esa cuenta. **La V2 viene en cruzado** de fábrica.

### 5.11 Comunes que aplica el motor (o que no aplica nadie)

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera (real, pruebas o simulación). El simulador es algo optimista para un market maker en un solo sentido —todo se ejecuta entero y sin cola— pero enfrenta las cotizaciones al libro de verdad, y por eso **es la herramienta con la que se mide un market maker** ([simulación y backtest](./simulacion-y-backtest.md#qué-hace-el-simulador-exactamente)). El backtest no: además de no reproducir refresco, espera ni volatilidad (F-65), no tiene flujo.

> ⛔ **El backtest no puede decirte si este bot gana.** El replay solo tiene velas, así que una cotización
> se ejecuta cuando el precio llega hasta ella y **nunca** cuando el flujo cruza tu precio sin moverlo —
> que es justo de lo que vive un market maker. Medido: los valores de fábrica sobre ocho pares y 120 días
> dan **−19,9 %** en el replay, y eso no prueba nada sobre la estrategia; es lo que sale de medir solo la
> mitad mala. **Para saber si gana, un bot simulado en el venue.** El backtest sí sirve para ver dónde
> cotiza, cuánto inventario acumula y para comparar dos configuraciones entre sí
> ([simulación y backtest](./simulacion-y-backtest.md#lo-que-el-backtest-no-reproduce)).


#### Par · `symbol` · ❄️ en frío

Fija tick, paso y mínimo. Con el preset Conservador el tamaño baja al 70 % y la vista previa ya lo enseña así: si una capa cae por debajo del mínimo, la vista previa no es válida.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

El capital del bot: contra él se miden su resultado, la **Pérdida diaria máxima** y la pérdida acumulada del kill-switch de tu cuenta. **No dimensiona ninguna orden** (lo hacen Tamaño por compra/venta y Niveles), y desde el spec 080 tampoco es lo que cuenta en tus límites de nocional: ahí cuenta la **Inversión / posición máxima**. Antes la API los medía con capital × apalancamiento, un número que este bot no lee.

**Consejo**: lo que estás dispuesto a comprometer. Una referencia natural es el margen del tope lleno, Inversión / posición máxima ÷ apalancamiento: 600 USDC a 1x en la Configuración B.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90·L · ⚠️ campo de riesgo

Un **% del margen** de la posición, medido desde su **precio medio**, como el SL por ROI de un exchange: el disparo va a `media × (1 ∓ stop/(100·L))`, con `L` el apalancamiento. A 1x, el de fábrica de la V2, el % del margen y el del precio coinciden; a 2x, un 10 % del margen es un 5 % del precio. El máximo es un 90 % del precio, es decir 90·L sobre el margen: 90 a 1x.

Orden condicional nativa, con la dirección del signo de la posición real ([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)). Si la posición del venue lleva más apalancamiento que la configuración, el stop se calcula con el mayor —queda más cerca— y el bot avisa una vez (`LEVERAGE_SKIPPED`). Convive con la **Acción al alcanzar el límite**: el aplanado usa su propio id, así que «Cerrar todo» y «Apagar» salen aunque haya stop.

**Frente a la liquidación**, como en la V1: con dirección Neutral se mide contra el corto; en aislado es un error que el stop quede en la liquidación o detrás, y un aviso que la deje a menos de medio stop detrás; en cruzado, el modo de fábrica, las dos cosas son aviso. A 1x en BTC de Hyperliquid el corto se liquida con un 97,53 % en contra, y el stop más ancho que no avisa es **65 %** del margen: el botón «Usar el stop más ancho válido» lo aplica.

**Consejo**: no viene puesto, y la app avisa al crear el bot sin él. Un stop cierra la posición pero **no para el bot**, que vuelve a cotizar: ponlo holgado, como corte ante un movimiento brusco.

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

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
| **Precio justo**                   | Punto medio        | 🟡 Microprecio, donde el venue lo permita |
| **Ajuste de precio por inventario** | **Sí** (factor 1)  | Déjalo. Sin él, el 48 % de los cierres cae bajo tu coste |
| Sesgo por desequilibrio            | 0                  | 0,3–0,5 cuando hayas visto el resto     |
| Sesgo de tamaño por inventario     | 0                  | 0,3–0,5. Medido, suma sobre el de precio |
| Sesgo por funding                  | 0                  | Mídelo antes                            |
| Horizonte de markout               | 0                  | 🟡 45 s, con sensibilidad 0 para mirarlo |
| Estimador de volatilidad           | Recorrido          | Solo si reajustas el multiplicador      |

---

## 7. ¿V2 o V1?

Ver la tabla comparativa completa en la **[guía de la V1, sección 6](./market-maker.md#6-v1-o-v2)**.

En una línea:

- **V1** → control directo y predecible del diferencial, menos mandos. (Las dos traen el sesgo por inventario encendido de fábrica.)
- **V2** → el bot se adapta solo al ritmo del mercado y **garantiza que cada vuelta completa alrededor del mismo precio deja beneficio limpio después de comisiones** — siempre que le digas cuál es tu comisión.

---

## 8. Limitaciones conocidas (hallazgos abiertos)

Confirmadas en `specs/001-revision-integral/findings.md`. La que la V2 compartía con la V1 —F-54, el
sondeo de ejecuciones en Lighter— quedó **resuelta en el spec 036**: ver
[la nota de la V1](./market-maker.md#7-limitaciones-conocidas-hallazgos-abiertos).
