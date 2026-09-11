# Venues y mínimos — lo que cada exchange permite

> Código: cupos en [`venue-weights.ts`](../packages/exchange-core/src/venue-weights.ts) y [`venue-budget.ts`](../packages/exchange-core/src/venue-budget.ts) · fichas de mercado en la tabla `markets` (modelo `Market` de [`schema.prisma`](../packages/db/prisma/schema.prisma)) y, como muestra fija, en [`venue-markets.ts`](../packages/strategy-core/src/venue-markets.ts) · la puerta de las órdenes en `revisarOrden()` de [`order-gate.ts`](../packages/strategy-core/src/order-gate.ts).
> Los tres venues son DEX de perpetuos: Hyperliquid, Lighter y Aster. Cada uno con su red real y su red de pruebas.

---

## 1. La ficha de cada mercado

Cada par tiene una ficha que el motor lee del venue y guarda en `markets`, **por red** (testnet y mainnet
son fichas distintas: Aster lista otros pares, Lighter usa otros identificadores, y el tick y el paso
difieren):

| Campo | Qué es | Por qué te importa |
|---|---|---|
| **Tick** (`tick_size`) | Salto mínimo de **precio** | Dos líneas de una rejilla a menos de 2 ticks se solapan al redondear: la app lo rechaza |
| **Paso** (`step_size`) | Salto mínimo de **cantidad** | En DOGE, kPEPE y 1000PEPE el paso es **1 moneda entera**: 15 USDT son 162 DOGE, no 162,9 |
| **Notional mínimo** (`min_notional`) | Valor mínimo de una orden en USDC/USDT | Cada orden suelta tiene que superarlo |
| **Cantidad mínima** (`min_qty`) | Mínimo en la moneda | En Lighter SOL es 0,1 SOL: a 138 USDC son 13,8 USDC, por encima del notional mínimo |
| **Apalancamiento máximo** (`max_leverage`) | Tope del venue para ese par | La app rechaza por encima (y la API por debajo del 5 % de distancia a liquidación) |
| **Activo** (`active`) | Si el mercado opera | Un mercado inactivo bloquea la creación y el arranque |

Muestra fija de fichas (24-08-2026, mainnet salvo indicación; la ficha real puede cambiar y el motor lo
avisa con `MARKET_SPEC_CHANGED`):

| Venue · par | Tick | Paso | Notional mín. | Cantidad mín. | Apalancamiento máx. |
|---|---|---|---|---|---|
| Lighter BTC | 0,1 | 0,00001 | 10 | 0,0001 (testnet **0,0002**) | 20× |
| Lighter ETH | 0,01 | 0,0001 | 10 | 0,005 | 20× |
| Lighter SOL | 0,001 | 0,001 | 10 | 0,1 | 20× |
| Hyperliquid BTC | 1 | 0,00001 | 10 | 0,00001 | 40× |
| Hyperliquid ETH | 0,1 | 0,0001 | 10 | 0,0001 | 25× |
| Hyperliquid DOGE | 0,00001 | **1** | 10 | 1 | 10× |
| Hyperliquid kPEPE | 0,000001 | **1** | 10 | 1 | 10× |
| Aster BTCUSDT | 0,1 | 0,001 | **5** | 0,001 | 50× |
| Aster ETHUSDT | 0,01 | 0,001 | 5 | 0,001 | 50× |
| Aster DOGEUSDT | 0,00001 | **1** | 5 | 1 | 50× |
| Aster 1000PEPEUSDT | 0,0000001 | **1** | 5 | 1 | 50× |

Regla de la casa: **≥ 20 USDC por orden**, el doble del mínimo, para que el redondeo al paso no la deje
por debajo. Y el apalancamiento máximo del par **no es una recomendación**: 50× en Aster liquida con un
1,5 % de movimiento (la API rechaza todo lo que quede a menos del 5 %: en la práctica, 18×).

---

## 2. Qué hace el motor con una orden que no cumple

Antes de mandar nada al venue, el motor pasa cada orden por `revisarOrden()`, que redondea al tick y al
paso (compra hacia abajo, venta hacia arriba, cantidad siempre hacia abajo) y decide **por qué** no
cumple, en vez de mandarla a ciegas o vetarla sin más:

| Veredicto | Cuándo | Evento | Efecto |
|---|---|---|---|
| OK | Cumple tick, paso, mínimos | — | Sale al venue |
| Entrada inválida | Una orden **de entrada** (no reduce-only) por debajo del mínimo o del paso | `ORDER_UNVIABLE` (WARN) | Ese nivel se descarta; **el resto de la escalera sigue** |
| Imposible | Una **salida** cuya cantidad o precio queda a cero al redondear | `ORDER_UNVIABLE` (WARN) | No hay orden que mandar |
| Esperando mínimo | Una salida por debajo del mínimo **con entradas vivas** | `EXIT_PENDING_MIN_SIZE` (INFO) | Se colocará en cuanto entren más ejecuciones. No es una avería |
| Resto incerrable | Una salida por debajo del mínimo **sin entradas vivas** | `POSITION_BELOW_MINIMUM` (WARN) | Tu TP (o stop) **no está puesto**: ciérralo a mano en el exchange o añade posición |

El mínimo se enseña legible en el evento: «0,0002 BTC / 10 USDC». Esta puerta nació de un incidente real:
una ejecución parcial de 0,00001 BTC dejó un take profit de 0,79 USDC frente a un mínimo de 10 en Lighter, y
el rechazo pausaba el bot con la posición abierta y sin stop.

Lo que el venue rechaza **después** de pasar la puerta (reglas que el motor no conoce) llega como
`ORDER_REJECTED` y deja esa forma de orden (precio + cantidad) en **cuarentena**: el motor no insiste en
cada revisión, y la reintenta cuando la estrategia recotice o la cantidad cambie. El stop-loss es la
excepción: se reintenta siempre y su rechazo es CRITICAL.

---

## 3. Cupos de peticiones

Cada venue limita cuántas peticiones acepta por minuto **y por IP**. El motor lleva un presupuesto por
venue y red que comparten todos los bots de la misma máquina (o de la misma IP, vía Redis):

| Venue | Cupo publicado | Unidad | Lo que el motor se permite | Castigo por pasarse |
|---|---|---|---|---|
| Hyperliquid | 1.200 / min | peso (las lecturas normales pesan 2; las velas, 20 + n/60) | 85 % del cupo (≈ 17/s) | Rechazos temporales |
| **Lighter** (Standard) | **60 / min** | **peticiones** (no peso) | 85 % (≈ 0,85/s) | **CAPTCHA durante 60 s** |
| Aster | 2.400 / min de peso **y** 1.200 órdenes / min (300 cada 10 s) | peso (1 con símbolo; hasta 40 sin símbolo) y órdenes | 85 % (≈ 34/s de peso; 17 órdenes/s) | **Veto de IP de hasta tres días** |

Cuatro detalles de diseño que te afectan:

- El **20 % del depósito está reservado a escrituras**: colocar, modificar, cancelar, fijar el apalancamiento
  y ajustar margen. Una avalancha de lecturas no puede dejar sin caudal a la cancelación de un pánico.
- En Aster el presupuesto cuenta además las **órdenes** colocadas (sus dos límites, con margen) y se
  **realimenta** con las cabeceras `X-MBX-USED-WEIGHT` y `X-MBX-ORDER-COUNT` de cada respuesta: si otro
  cliente de la misma IP gasta cupo, el motor lo ve y frena.
- Testnet y mainnet **no comparten** presupuesto.
- El simulador y el backtest **no consumen cupo**.

En la práctica: Hyperliquid y Aster aguantan decenas de bots por IP; **Lighter, muy pocos**. Con
0,85 peticiones por segundo, un market maker que recotice cada 30 s con 3 capas por lado ya se lleva una
parte importante del cupo. De ahí la cuenta de servicio `LIGHTER_SERVICE_*` y `WORKER_EGRESS_ID` del
despliegue.

---

## 4. Límites que el motor todavía no modela

**Órdenes activas por mercado.** Lighter Standard admite **30** (250 por cuenta) y **10 condicionales
pendientes** por mercado; Aster, **200** por símbolo y **10 algorítmicas** (condicionales: el stop-loss es
una por bot, así que ese segundo tope no se alcanza). La vista previa avisa cuando la configuración tiende
más niveles que el tope (es un aviso, no un veto: el tope depende del tier de la cuenta, que la app no
conoce), y si el venue rechaza el exceso, el rechazo se clasifica como regla del mercado, no como avería. En
Lighter, cuenta compras, ventas, TP y stop: ≤ 30 líneas vivas. En Aster, una retícula de 200 niveles más su
take profit y su stop supera el cupo: quédate por debajo.

**Órdenes a mercado en Lighter.** Salen con un **5 % de holgura** en contra (la misma que Hyperliquid) y su
acuse queda **pendiente** hasta que el sondeo de ejecuciones (cada 12 s) las confirma; si el secuenciador
las cancela, la fila vence a los cinco minutos y el nivel se recoloca. La hora de creación de las órdenes
vivas es la del venue, así que las caducidades por edad de los market makers también funcionan aquí.

**Liquidaciones.** En los tres venues una liquidación del exchange llega marcada como tal: el bot la
reconoce, pausa y avisa en vez de contarla como una ejecución propia (en Lighter por el tipo de la
ejecución; en Aster por el id `autoclose-`, la ejecución `CALCULATED` o el estado `NEW_INSURANCE`/`NEW_ADL`;
en Hyperliquid por `dir`). Aun así, si el semáforo llegó al rojo, comprueba la posición en el venue.

**Modo cobertura en Aster**: el formulario lo rechaza. Cambiaría el modo de toda la cuenta (afecta a todos
tus bots en Aster) y el bot no podría operar; usa Automático o Unidireccional.

---

## 5. La credencial: qué se pide, qué puede y qué caduca

CRYPTON es **no custodial**: no pide una frase semilla ni una clave con permiso de retirada. Lo que
se entrega es una **firma delegada**, y cada venue la llama de otra manera:

| Venue | Qué se pide | ¿Puede retirar? | ¿Caduca? |
|---|---|---|---|
| Hyperliquid | **La dirección de tu cuenta** y la clave privada de una **API wallet** (*agent*) | No | **Sí**: 90 días por defecto, 180 como máximo |
| Lighter | Índice de cuenta, índice de clave y la clave privada de la API | No | No |
| Aster | Tu dirección, la del firmante y su clave privada | No | No |

La credencial se verifica **contra la red que se va a guardar** antes de almacenarla: si no
funciona, no se guarda. Y se comprueba de verdad —que la dirección es una cuenta y que la clave
está autorizada en ella—, no solo que el venue conteste.

### Hyperliquid: la dirección que se pide NO es la de la API wallet

Es el error más fácil de cometer, porque las dos cosas son direcciones `0x…` y salen de la **misma**
pantalla del exchange (*More → API*):

- **Dirección de tu cuenta**: la que tiene el dinero. Es la que aparece arriba a la derecha en la
  web de Hyperliquid y con la que depositaste.
- **Clave privada de la API wallet**: la que Hyperliquid muestra **una sola vez**, al pulsar
  *Generate*, antes de autorizarla firmando con tu wallet principal. La dirección de esa API wallet
  no se pega en ningún sitio: CRYPTON la deriva de la clave.

Si se pega la dirección de la API wallet, CRYPTON **rechaza la conexión y dice cuál es la dirección
correcta** —el propio venue la devuelve—. Antes la aceptaba: la conexión quedaba guardada como
verificada, con un saldo de cero, mientras el dinero estaba en el exchange. Ese fue el spec 028.

Tampoco se aceptan la dirección de una **subcuenta** ni de un **vault**: sus órdenes necesitan un
campo que el motor todavía no manda, así que acabarían en la cuenta principal.

### Qué pasa cuando la API wallet caduca

**No se pierde dinero.** Una API wallet no puede retirar ni transferir; los fondos siguen en tu
cuenta del exchange, gobernados por tu wallet principal. Lo que se pierde es la capacidad de operar:

- El venue deja de aceptar esa firma: los bots **no pueden colocar ni cancelar**.
- Las posiciones abiertas y las órdenes ya puestas **siguen ahí** —incluido el stop-loss, que se
  coloca como orden condicional nativa del venue justamente para sobrevivir a todo esto—, pero
  **nadie las gestiona**. Ese es el riesgo real de una caducidad, y no el dinero.
- Se arregla autorizando una API wallet nueva en el exchange y actualizando la credencial aquí.

La ficha de la conexión enseña hasta cuándo vale y avisa cuando faltan **menos de 14 días**. Después
de reautorizar en el exchange, *Reverificar* pone la fecha al día.

### El dinero tiene que estar donde se opera

Hyperliquid separa **spot** de **perpetuos**, y solo el segundo respalda una posición. Un depósito
que se queda en spot se ve en el exchange pero no cuenta como capital aquí, porque lo que se enseña
es el saldo **operable**. Cuando ese saldo es cero y hay USDC en spot, la ficha de la conexión y el
asistente lo dicen: hay que transferirlo a perpetuos dentro del exchange.

---

## 6. Testnet frente a mainnet

- La ficha del mercado es **otra** (mínimos, pasos, pares disponibles). Lighter testnet exige el doble de
  cantidad mínima en BTC.
- El libro de testnet es irreal: poco volumen, diferenciales absurdos, rebotes que no existen. Sirve para
  comprobar que **tus claves firman y que las órdenes aparecen**, no para medir una estrategia.
- Los presupuestos de peticiones son independientes.
- Un bot pertenece a la cuenta con la que nació (con su red). Para pasar de testnet a mainnet, creas otro
  bot sobre otra conexión.

---

## 7. Resumen por venue

| | Hyperliquid | Lighter | Aster |
|---|---|---|---|
| Mínimo por orden | 10 USDC | 10 USDC | 5 USDT |
| Cupo | Holgado | **Muy estrecho** (60/min) | Holgado, castigo severo |
| Órdenes activas por mercado | (sin límite conocido que afecte) | **30** (la vista previa avisa) | 200 (la vista previa avisa) |
| Órdenes a mercado | Con holgura del adaptador (5 %) | Con holgura (5 %), acuse pendiente hasta el sondeo | Con holgura |
| Caducidad por edad (MM) | ✅ | ✅ | ✅ |
| Modo cobertura | — | — | ❌ Rechazado por el formulario |
| Recomendación hoy | Todo | Todo, incluidos market makers desde el spec 036 (las ejecuciones ya llegan empujadas) | Todo salvo cobertura; menos de 200 líneas |
