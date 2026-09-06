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
| Aster | 2.400 / min | peso (1 con símbolo; hasta 40 sin símbolo) | 85 % (≈ 34/s) | **Veto de IP de hasta tres días** |

Dos detalles de diseño que te afectan:

- El **20 % del depósito está reservado a escrituras** (colocar y cancelar): una avalancha de lecturas no
  puede dejar sin caudal a la cancelación de un pánico.
- Testnet y mainnet **no comparten** presupuesto.
- El simulador y el backtest **no consumen cupo**.

En la práctica: Hyperliquid y Aster aguantan decenas de bots por IP; **Lighter, muy pocos**. Con
0,85 peticiones por segundo, un market maker que recotice cada 30 s con 3 capas por lado ya se lleva una
parte importante del cupo. De ahí la cuenta de servicio `LIGHTER_SERVICE_*` y `WORKER_EGRESS_ID` del
despliegue.

---

## 4. Límites que el motor todavía no modela

> ⚠️ **Limitación conocida (F-50, Lighter, abierta a 2026-09-06).** Lighter Standard admite **30 órdenes
> activas por mercado** (250 por cuenta) y **10 condicionales pendientes** por mercado. El motor no lo sabe:
> una rejilla de más de 30 líneas nunca se completa, el exceso se rechaza en silencio (un error por nivel
> sobrante, en cuarentena) y los rechazos se clasifican como fatales.
> **Hasta que se corrija:** en Lighter, ≤ 30 líneas vivas contando compras, ventas, TP y stop.

> ⚠️ **Limitación conocida (F-23, Aster, abierta a 2026-09-06).** Aster admite **200 órdenes por símbolo**
> y **10 órdenes algorítmicas** (condicionales: stops). Una retícula de 200 niveles agota el cupo y las
> últimas órdenes se rechazan una a una. **Hasta que se corrija:** bastante menos de 200 líneas en Aster.

> ⚠️ **Limitación conocida (F-47, Lighter).** Las órdenes **a mercado** se mandan con el precio de marca
> como tope y sin holgura; si el mejor precio contrario está peor que el mark (lo normal con un
> diferencial no nulo), el secuenciador **cancela la orden** y el motor la marca **ejecutada** sin serlo.
> Afecta a la entrada del DCA, a la base de las escaleras, a «Adelantar seguridad», a «Cerrar ahora» y a
> «Parar y cerrar». **Hasta que se corrija:** en Lighter, comprueba en la web del exchange que las órdenes
> a mercado se ejecutaron; prefiere Hyperliquid o Aster para DCA y escaleras.

> ⚠️ **Limitación conocida (F-55, Lighter).** La hora de creación de las órdenes se toma del reloj local al
> leerlas, así que las **caducidades por edad** de los market makers (`orderMaxAgeSeconds`, 120 s por
> defecto en la V2, y `exitOrderTtlSeconds`) **nunca disparan** en Lighter.

> ⚠️ **Limitación conocida (F-05 / F-70, Lighter y Aster).** Una **liquidación del exchange** puede entrar
> como una ejecución normal (Lighter) o descartarse (Aster): el bot cree seguir en posición y no pausa.
> **Hasta que se corrija:** si el semáforo llegó al rojo, comprueba la posición en el venue.

> ⚠️ **Limitación conocida (F-71, Aster).** «Modo de posición = Cobertura» **no puede funcionar** en Aster:
> cambia el modo de toda la cuenta y a partir de ahí toda orden se rechaza. Déjalo en Automático.

---

## 5. Testnet frente a mainnet

- La ficha del mercado es **otra** (mínimos, pasos, pares disponibles). Lighter testnet exige el doble de
  cantidad mínima en BTC.
- El libro de testnet es irreal: poco volumen, diferenciales absurdos, rebotes que no existen. Sirve para
  comprobar que **tus claves firman y que las órdenes aparecen**, no para medir una estrategia.
- Los presupuestos de peticiones son independientes.
- Un bot pertenece a la cuenta con la que nació (con su red). Para pasar de testnet a mainnet, creas otro
  bot sobre otra conexión.

---

## 6. Resumen por venue

| | Hyperliquid | Lighter | Aster |
|---|---|---|---|
| Mínimo por orden | 10 USDC | 10 USDC | 5 USDT |
| Cupo | Holgado | **Muy estrecho** (60/min) | Holgado, castigo severo |
| Órdenes activas por mercado | (sin límite conocido que afecte) | **30** (F-50) | 200 (F-23) |
| Órdenes a mercado | Con holgura del adaptador | **Sin holgura** (F-47) | Con holgura |
| Caducidad por edad (MM) | ✅ | ❌ (F-55) | ✅ |
| Modo cobertura | — | — | ❌ No usar (F-71) |
| Recomendación hoy | Todo | Rejillas pequeñas y DCA con vigilancia; sin market makers | Todo salvo cobertura; menos de 200 líneas |
