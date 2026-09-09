# Comandos, guardas y eventos — el manual del panel del bot

> Código: los comandos en `runCommand()` de [`bot-runner.ts`](../apps/worker/src/engine/bot-runner.ts), la mutabilidad de cada parámetro en [`config-meta.ts`](../packages/shared/src/config-meta.ts) y en `meta.fields` de cada estrategia, las etiquetas de los eventos en [`labels.ts`](../apps/app/src/app/core/utils/labels.ts).
> Las guardas de riesgo están explicadas en [riesgo y liquidación](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión); aquí solo se resumen.

---

## 1. Cambiar un bot en marcha: en caliente, en tibio, en frío

Cada parámetro declara qué pasa si lo cambias con el bot arrancado. No es una etiqueta decorativa:
decide lo que hace el motor al recargar la configuración.

| Icono | Mutabilidad | Qué hace el motor | Ejemplos |
|---|---|---|---|
| 🔥 | **En caliente** (HOT) | Se aplica en la siguiente revisión (≤ 15 s). Reajusta órdenes; **la posición no se toca**. | `takeProfitPct`, distancias en bps, topes, `stopLossPct`, `cooldownMinutes` |
| 🌤️ | **En tibio** (WARM) | **Cancela y vuelve a tender la escalera**. La posición sigue abierta. La app pide confirmación. | niveles, rango, escalas de la escalera, `totalInvestment`, apalancamiento |
| ❄️ | **En frío** (COLD) | **Se rechaza**: sería otro bot. Hay que parar y crear uno nuevo. | par, cuenta de exchange, dirección, modo de margen, modo de posición, `classicMode` |

Dos avisos que las guías repiten porque importan:

- El **apalancamiento** es en tibio y no en caliente porque el venue puede rechazar el cambio con
  posición abierta y, aunque lo acepte, **mueve el precio de liquidación**.
- Cambiar la **forma de una escalera con inventario** (rango, niveles, separaciones) se **rechaza** (409):
  las salidas de lo comprado dejarían de corresponder a sus líneas. Hazlo con el ciclo limpio (posición en
  cero); con inventario, la API te dice exactamente qué campos son los que redibujan.

---

## 2. Los trece comandos

| Comando | Qué hace | Órdenes del bot | Stop-loss | Posición | Estado final | ¿Pide confirmación? |
|---|---|---|---|---|---|---|
| **Arrancar** (`START`) | Adopta el bot y empieza a planificar | — | — | — | Operando | No |
| **Pausar** (`PAUSE`) | Deja de planificar. «Pausar no es cerrar.» | Se cancelan | **Se conserva** | Intacta | Pausado | No |
| **Reanudar** (`RESUME`) | Vuelve a tender la escalera y rearma el aviso de liquidación | Se recolocan | — | — | Operando | No |
| **Cancelar órdenes** (`CANCEL_ALL_ORDERS`) | Retira todas las órdenes del bot y sigue operando | Se cancelan | **Se cancela también** | Intacta | Operando | No |
| **Parar manteniendo posición** (`STOP_KEEP_POSITION`) | Para el bot y deja la posición abierta | Se cancelan | **Se conserva** | Intacta | Parado | Sí |
| **Parar y cerrar** (`STOP_AND_CLOSE`) | Retira la escalera, cierra la posición **a mercado** y, con el cierre fuera, cancela también el stop. Si el exchange no acepta el cierre: el stop se queda, el bot pasa a **Pausado** y lo dice en CRITICAL (`ACTION_FAILED`) | Se cancelan | Se cancela **tras** el cierre | Se cierra | Parado (Pausado si el cierre falla) | Sí |
| **Pánico** (`PANIC`) | Lo mismo que «Parar y cerrar», con evento propio | Se cancelan | Se cancela tras el cierre | Se cierra | Parado (Pausado si falla) | Sí |
| **Cerrar ahora** (`CLOSE_NOW`) | Cierra la posición a mercado y **el bot sigue operando** (abrirá otro ciclo si la estrategia lo pide) | Se mantienen | Se recoloca solo si vuelve a haber posición | Se cierra | Operando | Sí |
| **Recoger beneficio** (`TAKE_PROFIT_NOW`) | Igual que «Cerrar ahora», con otro motivo en la bitácora | Se mantienen | ídem | Se cierra | Operando | Sí |
| **Aportar / retirar margen** (`ADJUST_MARGIN`) | Mueve colateral de la cuenta a la posición aislada (o al revés). El único comando con argumentos y el único que aleja la liquidación sin tocar la posición | — | — | Intacta | Operando | No |
| **Recentrar la retícula** (`REANCHOR_GRID`) | Olvida el ancla y los niveles ya ejecutados; la escalera se vuelve a colgar del precio actual | Se cancelan | **Se conserva** | Intacta | Operando | No |
| **Resincronizar** (`REPAIR`) | Relee posición, órdenes y ejecuciones del exchange y recalcula el ciclo. **No cancela ni cierra nada** | Se mantienen | Se mantiene | Intacta | Operando | No |
| **Adelantar seguridad** (`ADD_SAFETY_NOW`) | Ejecuta **a mercado** la siguiente orden de seguridad de la escalera | Se mantienen | Se mantiene | Crece | Operando | Sí |

Reglas comunes:

- **Alcance**: todos cancelan **solo las órdenes de este bot**, nunca las de sus hermanos ni las que
  hayas puesto a mano en la web del exchange. Solo el kill-switch global de la pantalla Riesgo tiene
  alcance de cuenta.
- **Durabilidad**: un comando no se pierde. La API lo escribe en la base en la misma transacción que su
  evento; si el worker estaba reiniciando, lo recoge en la siguiente revisión.
- **Confirmación**: la piden los que cierran posición a mercado (irreversibles: realizan la pérdida al
  instante) y «Recentrar la retícula» (compromete margen nuevo sobre la posición abierta). `REPAIR` no la
  pide porque no toca nada.

### Qué comando aplica a cada estrategia

| Comando | Rejilla clásica | Rejilla neutral | DCA temporizado | Martingala | GridMart | Market makers |
|---|---|---|---|---|---|---|
| Recentrar la retícula | Rechazado: las líneas salen del rango (edítalo) | Rechazado: edita «Precio ancla» | Rechazado: no hay ancla | ✅ Pide confirmación: rearma toda la escalera bajo el precio actual y el aviso anota el margen que compromete | Igual que Martingala | Rechazado: no hay ancla |
| Adelantar seguridad | Inerte («No queda ninguna orden de seguridad») | Inerte | Inerte | ✅ A mercado al precio actual; anuncia lo que dijo el acuse | ✅ Igual que Martingala | Inerte |
| Cerrar ahora / Recoger beneficio | ✅ Cierra el inventario; la rejilla sigue | ✅ | ✅ Cierra y empieza otro ciclo | ✅ Cierra el ciclo | ✅ | ✅ |
| Aportar margen | Solo en aislado | — (cruzado por defecto) | Solo en aislado | Solo en aislado | Solo en aislado | — (cruzado por defecto) |

El menú de la app ofrece «Adelantar seguridad» y «Recentrar la retícula» solo en Martingala y GridMart; si
un comando llega por otra vía a una estrategia en la que no aplica, la API lo rechaza al instante y el motor,
si le llegara, lo veta con `ACTION_FAILED` y el motivo.

---

## 3. Las guardas, en una tabla

Resumen de [riesgo y liquidación §6](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión).
Todas **pausan** (cancelan órdenes conservando el stop, estado `PAUSADO` con motivo, evento CRITICAL);
solo la de liquidación puede cerrar, y solo si tú se lo pediste en «Al acercarse la liquidación».

| Guarda | Se dispara cuando |
|---|---|
| Apalancamiento por encima de tu límite | siempre, haya posición o no |
| Notional del bot / total de tus bots por encima del límite | con posición |
| Liquidación a menos del % de aviso (10 por defecto) | con posición; aviso CRITICAL con enfriamiento; acción según `liquidationAction` |
| Pérdida acumulada del bot ≥ kill-switch (%) | sobre el capital asignado; es un tope de pérdida, no un drawdown desde máximo |
| Pérdida diaria de la cuenta o del bot | PnL realizado de hoy |
| 20 colocaciones fallidas seguidas · 5 revisiones fallidas seguidas | fallos técnicos persistentes |
| Precio externo desfasado (> 15 s) | la estrategia deja de cotizar; el bot **no** se pausa |

---

## 4. Los eventos de la bitácora

La pestaña **Eventos** del bot es la bitácora completa de lo que ha hecho y por qué. Se lee **de más nuevo
a más viejo**. Cada evento tiene una severidad: **INFO** (sin borde), **WARN** (ámbar), **ERROR** y
**CRITICAL** (rojo). Lo que hay que mirar cuando algo no cuadra es lo ámbar y lo rojo.

### Ciclo de vida

| Evento | Etiqueta | Qué hacer |
|---|---|---|
| `BOT_CREATED` · `BOT_STARTED` · `BOT_RESUMED` | Bot creado · arrancado («Motor enganchado al venue») · reanudado | Nada. |
| `BOT_PAUSED` · `BOT_STOPPED` | Bot pausado · parado. Llevan la coletilla del stop («sigue vivo» / «SIN stop loss» / «NO consta colocado») | Lee la coletilla: dice si la posición tiene red. |
| `BOT_ADOPTED` | Adoptado por otro worker (reinicio o segundo worker) | Nada: la reconciliación converge sola. |
| `BOT_REPAIRED` | Resincronizado con el exchange | Nada. |
| `START_FAILED` | No se pudo arrancar (credencial, mercado inactivo, límite de bots…) | Lee el motivo. |
| `CONFIG_RELOADED` | Configuración recargada (en caliente o en tibio) | Comprueba que la escalera se ha retendido como esperabas. |

### Operativa normal

| Evento | Etiqueta | Qué hacer |
|---|---|---|
| `FILL` | Ejecución («BUY 10.65 @ 4.743») | Nada. Es el bot trabajando. |
| `CYCLE_CLOSED` | Ciclo cerrado, con su PnL | Nada. |
| `SAFETY_ADDED` · `ADD_SAFETY_SKIPPED` | Seguridad manual enviada / no aceptada | `SAFETY_ADDED` dice el estado del acuse (ejecutada, o enviada a la espera del `FILL`). `ADD_SAFETY_SKIPPED` en WARN: el exchange no la aceptó; el motivo está en el evento anterior. |
| `GRID_REANCHORED` | Retícula recentrada | Solo en escaleras. El mensaje anota el margen que la escalera nueva compromete además de la posición abierta. |
| `ORDERS_CANCELED` | Órdenes canceladas a petición | Nada. |
| `MARGIN_ADJUSTED` | Margen ajustado | Trae la liquidación antes y después. Si pediste contar el aporte como capital, el capital asignado sube al llegar este acuse. |

### Órdenes con problema

| Evento | Etiqueta | Qué significa | Qué hacer |
|---|---|---|---|
| `ORDER_REJECTED` (WARN) | Orden rechazada por el exchange | El venue no aceptó la orden por sus reglas. El motor la deja en **cuarentena** por forma (tipo de nivel, lado, precio, cantidad y si reduce): no insiste cada revisión, la reintenta cuando la estrategia recotice, cambie la cantidad o la orden cambie de papel. | Lee el motivo. En cotización post-only («cruzaría el libro») es **normal** y desde el spec 029 se queda en la bitácora sin avisarte: los market makers ya no cotizan cruzando, así que si aparece es un caso aislado. |
| `ORDER_REJECTED` (CRITICAL) | El bot no consigue colocar **nada** | Veinte rechazos por reglas seguidos sin una sola orden aceptada. El bot se ha quedado sin órdenes en el libro; si tiene posición, no la está pudiendo reducir. | **Míralo.** El texto trae el último motivo y si la posición tiene stop. Revisa mínimos del par, capital asignado y que el símbolo siga operativo. |
| `ORDER_UNVIABLE` (WARN) | Orden inviable en este mercado | Un nivel de **entrada** por debajo del mínimo del par o del paso de cantidad. Se descarta y el resto de la escalera sigue. | Sube capital o baja niveles. |
| `EXIT_PENDING_MIN_SIZE` (INFO) | Salida pendiente: tamaño mínimo | La salida es aún demasiado pequeña **y quedan entradas vivas**: se colocará en cuanto entren más ejecuciones. | Nada: no es una avería. |
| `POSITION_BELOW_MINIMUM` (WARN) | Resto por debajo del mínimo del venue | Hay posición pero es tan pequeña que **ninguna orden puede cerrarla**, y no quedan entradas que la hagan crecer. Tu TP (o el stop) **no está puesto**. | Ciérralo a mano en el exchange o añade posición. |
| `ORDER_RETRY` (INFO) | Orden reintentada | Fallo pasajero (red, timeout). Se reintenta en la siguiente revisión. | Nada, salvo que se repita: 20 seguidos pausan el bot. |
| `INSUFFICIENT_FUNDS` (ERROR) | Fondos insuficientes | No hay margen para un nivel; la escalera queda incompleta. | Baja el capital asignado o aporta fondos a la cuenta. |
| `CLOSE_SKIPPED` | Cierre omitido | No había posición que cerrar. | Nada. |
| `LEVERAGE_SKIPPED` · `POSITION_MODE_SKIPPED` | Apalancamiento / modo de posición no aplicado | El venue no aceptó el ajuste (posición abierta, o no lo soporta). | El bot sigue con el valor que tenga la cuenta: compruébalo en el exchange. |
| `MARKET_SPEC_CHANGED` | El mercado cambió sus reglas | El venue cambió tick, paso o mínimo. | Revisa que tus niveles sigan por encima del mínimo. |

### Precio de referencia (market makers anclados a Binance)

| Evento | Qué hacer |
|---|---|
| `FAIR_PRICE_STALE` (WARN; CRITICAL si la causa es geográfica) | Binance lleva más de 15 s sin dato: el bot **deja de cotizar** hasta que vuelva. Si es por bloqueo geográfico, cambia la fuente a «Datos del exchange». |
| `FAIR_PRICE_UNAVAILABLE` | No hay precio de la fuente (símbolo mal escrito, mercado inexistente). Revisa «Símbolo de origen alternativo». |

### Riesgo

| Evento | Qué hacer |
|---|---|
| `RISK_GUARD_TRIPPED` (CRITICAL) | Una guarda pausó el bot. El texto dice cuál y si queda stop. **Decide tú**: reanudar tras ajustar, cerrar, o esperar. |
| `LIQUIDATION_NEAR` (CRITICAL) | Liquidación a menos del % de aviso. Aporta margen (si aislado), cierra parte, o cierra todo. No lo pospongas. |
| `LIQUIDATED` | El exchange cerró la posición. El bot queda `LIQUIDADO`. |
| `PANIC` | Pánico: todo cancelado y cerrado. Si el cierre no salió, en su lugar verás un `ACTION_FAILED` CRITICAL y el bot pausado con el stop intacto. |

### Fallos técnicos

| Evento | Qué hacer |
|---|---|
| `TICK_ERROR` (WARN) | Error en una revisión. Aislado no importa; 5 seguidos pausan el bot. Mira la consola del worker. |
| `STREAM_ERROR` | La conexión en vivo con el venue se cortó; el bot rebarre por REST mientras tanto. Se avisa **una vez cada cinco minutos** por stream, no en cada reintento. Si persiste, revisa red o límites de peticiones (Lighter: 60/min por IP). |
| `STREAM_RECOVERED` (INFO) | La conexión volvió. Solo se anuncia si su caída llegó a anunciarse. Nada que hacer. |
| `AUTH_ERROR` (CRITICAL) | El exchange rechazó la credencial. El bot no puede operar: revisa la clave en Cuenta → conexiones. |
| `ACTION_FAILED` | Un comando no pudo ejecutarse. Lee el motivo. |

### La nota del bot

Además de los eventos, cada estrategia escribe una **nota** en cada revisión (la ves en el resumen del
bot). Es la frase que te dice en qué estado cree estar:

| Estrategia | Ejemplos de nota |
|---|---|
| Rejilla clásica | «Precio fuera del rango: sin entradas nuevas, salidas activas.» · «Tope de notional alcanzado: sin entradas nuevas.» |
| Rejilla neutral | «Retícula neutral: 18 órdenes activas.» · «Tope de exposición alcanzado: solo órdenes que reducen posición.» · «Desvío del ancla 11,2 %: procede recentrar.» |
| DCA temporizado | «Comprando (3/20).» · «Sin comprar: faltan 812 s para la siguiente compra; el precio no mejora el medio en el margen exigido.» |
| Martingala | «Abriendo ciclo.» · «Ciclo abierto: 4 seguridades pendientes.» · «En cooldown, 43 s para el próximo ciclo.» |
| GridMart | «Núcleo 0,0501, satélite 0,0671.» · «GridMart Classic: TP satélite en 79.856,9.» |
| Market makers | «Inventario 312.40 (62 % del tope), 6 cotizaciones.» · «Esperando a que el precio baje a 0.004.» |

---

## 5. Estados del bot

| Estado | Qué significa |
|---|---|
| Borrador | Creado, nunca arrancado. |
| Arrancando | Un worker lo está adoptando. |
| Operando | Planifica y reconcilia cada 15 s. |
| Pausado | No planifica. Posición intacta; stop conservado (si lo había). Puede ser tuyo (`PAUSE`) o de una guarda (con motivo). |
| Parando | Ejecutando un comando terminal. |
| Parado | Terminado. Con posición (`STOP_KEEP_POSITION`) o sin ella (`STOP_AND_CLOSE`, `PANIC`). |
| Error | No pudo arrancar o el worker lo soltó por un fallo persistente. |
| Liquidado | El exchange cerró la posición. |

---

## 6. Limitaciones conocidas

El spec `009-protecciones-y-cierre` (septiembre de 2026) corrigió el orden de «Parar y cerrar» (F-33) y
dos fallos de contabilidad de órdenes: una orden aceptada por el venue ya no puede acabar marcada como
rechazada porque falle la base (F-36), y una fila pendiente sin acuse **vence a los cinco minutos** y el
nivel se vuelve a intentar con un aviso `ORDER_RETRY` (F-37). El spec `010-comandos-y-ciclo` dejó
«Recentrar la retícula» solo en las escaleras y con confirmación, hizo que «Adelantar seguridad» salga al
precio actual y anuncie según el acuse, y que «Espera entre ciclos» se pueda cambiar en caliente. El spec
`011-margen-y-modo-posicion` hizo que «Aportar margen» llegue de verdad al exchange, que el capital
asignado suba solo con el acuse, que el modo cobertura quede vetado en Aster y que ningún comando que
mueva dinero se ejecute dos veces.
