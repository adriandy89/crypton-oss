# Simulación y backtest — probar sin dinero

> Código: el simulador en [`dry-run.ts`](../packages/exchange-core/src/adapters/dry-run.ts), la cuenta simulada en [`exchange-accounts.service.ts`](../apps/api/src/modules/exchange-accounts/exchange-accounts.service.ts), el backtest en [`packages/backtest`](../packages/backtest/src/engine.ts) (con sus avisos en [`warnings.ts`](../packages/backtest/src/warnings.ts)) y su pantalla en [`backtest.page.ts`](../apps/app/src/app/features/backtest/backtest.page.ts).
> Es el primer paso obligatorio del [camino recomendado](./buenas-practicas.md#2-el-camino-obligatorio). Ninguna de las dos herramientas firma nada ni toca un exchange.

---

## 1. Dos herramientas distintas

| | **Simulación** (bot simulado) | **Backtest** (replay) |
|---|---|---|
| Qué es | Un bot de verdad, con el mismo motor, contra un exchange **fingido** que sigue los **precios reales de mainnet en vivo** | Reproducir la estrategia sobre **velas históricas** |
| Tiempo | Real: un ciclo de 4 horas tarda 4 horas | Comprimido: 30 días en segundos |
| Qué comparte con producción | **Todo** el motor: planificación, reconciliación, stop nativo, guardas, bitácora, comandos | Las mismas piezas puras de estrategia y contabilidad; **no** el motor |
| Para qué sirve | Ver el bot trabajar, aprender la bitácora, comprobar que la configuración hace lo que crees | Dimensionar, comparar dos configuraciones, ver el peor caso en un tramo concreto |
| Para qué **no** sirve | Medir rentabilidad (poco tiempo, sin profundidad de libro) | Predecir: es una reconstrucción con hipótesis |

---

## 2. La cuenta «Simulación»

Al darte de alta, la plataforma **crea sola una cuenta simulada por venue** (Hyperliquid, Lighter, Aster),
con la etiqueta «Simulación», **10.000 USDC** de saldo de partida y sin ninguna credencial: el adaptador se
construye en modo `dryRun` sobre los datos públicos del venue, así que **ni siquiera existe un firmante al
que se le pudiera escapar una orden**. Los precios son los **reales de mainnet**: para que la simulación
enseñe algo, el libro tiene que ser el de verdad.

Como el libro es el de verdad, un bot simulado usa la **conexión en vivo real** del venue: por eso puede
avisarte de que «el stream de ticker se ha caído». No es un fallo de la simulación, es el mismo socket
público que usan los bots reales.

- Puedes cambiar el **saldo simulado** (simular con 10.000 cuando piensas invertir 500 no enseña nada) y
  **reiniciar** el estado simulado: la API vuelve al saldo inicial y borra posiciones y órdenes fingidas.
- Un bot decide **al crearse** si es simulado o real (`dry_run`) y **no puede cambiar**: mezclar simulado y
  real en el mismo bot haría que su histórico no significara nada. Para pasar a real, creas otro bot.
- Puedes tener **varios bots simulados sobre el mismo par**; la regla «un solo bot real por par y cuenta»
  no aplica a los simulados.
- La curva de la cartera, el ranking, el copy-trading y el **resumen diario de Telegram** excluyen los
  bots simulados: su resultado es dinero que no existe y no se suma nunca al de verdad. En el resumen
  salen en una línea aparte, marcada, para que un simulado que trabaja no parezca parado.
- Los avisos de Telegram de un bot simulado van **marcados**: «m v1 (LIT) · simulado».

### Qué hace el simulador, exactamente

| Situación | Simulador | Venue real |
|---|---|---|
| Orden limit / post-only colgada | Se ejecuta **entera y a su propio precio** en cuanto el mejor precio contrario la toca (`ask ≤ compra`, `bid ≥ venta`) | Puede ejecutarse parcialmente y hay cola de prioridad |
| Post-only que cruzaría el libro | **Rechazada**: «Post-only rechazada: cruzaría el libro» | Igual |
| Libro sin los dos lados | El market maker **no cotiza** ese ciclo y lo dice en la nota | Igual |
| Orden a mercado | Se ejecuta al mejor precio contrario **con un deslizamiento del 0,05 %** en contra, como taker | Depende de la profundidad |
| Comisiones | **0,02 % maker · 0,05 % taker**, descontadas del PnL realizado | Las del venue (y las del builder, si las hay) |
| Stop-loss / take profit condicionales | Orden **en reposo** que se dispara con el precio de marca y se ejecuta al precio del disparador con deslizamiento (corregido en el spec 004; antes cerraba en el acto) | Igual, condicional nativa |
| Orden que solo reduce (`reduceOnly`) | Se ejecuta **como mucho por el tamaño de la posición**. Si ya no hay nada que reducir, la límite o el stop se retiran sin ejecutarse y la de mercado se rechaza. Hasta el spec 057 (F-05) se ejecutaba entera: un stop y un objetivo tocados en la misma vela giraban la posición | Igual |
| Liquidación | Con la tasa de mantenimiento **de cada mercado** (1,25 % en BTC de Hyperliquid), la misma con la que la vista previa calcula la liquidación, pero sin la escala por tramos. Hasta el spec 080 era un 0,5 % plano para todos los pares, y en BTC la simulación liquidaba bastante más lejos de lo que la app había enseñado | Escala por tramos del venue |
| Funding | **No existe** | Se cobra o paga periódicamente |
| Margen retenido por órdenes en reposo | **No se descuenta** del saldo disponible | Sí |
| Límites de cuota y de órdenes activas | No aplican (`NO_BUDGET`) | Aplican (Lighter: 60 peticiones/min, 30 órdenes por mercado) |

Consecuencia: **el simulador es algo optimista** para un market maker (todo se ejecuta entero y sin cola) y
**realista** para rejillas y escaleras en cuanto a precios, y **no dice nada** del funding ni de los límites
del venue. Un bot que pierde en simulación perderá en real; uno que gana en simulación **puede** perder en
real.

> ✅ **Para un market maker, esta es la herramienta buena, y no el backtest.** Aquí las cotizaciones se
> enfrentan al **libro de verdad**, tick a tick: cuando el mejor precio contrario baja hasta tu compra es
> porque alguien ha vendido ahí, y eso incluye al flujo que cruza tu precio sin moverlo, que es de lo que
> vive un market maker. El backtest **no tiene** ese flujo —solo velas— y por eso sus cifras para un market
> maker no significan lo que parecen. Está explicado en [el recuadro del backtest](#lo-que-el-backtest-no-reproduce).
> Lo único que este simulador te regala es la **cola**: aquí no la hay y en el venue sí, así que cuenta con
> ejecutar menos de lo que ves.

### Qué mirar en un bot simulado

1. La **vista previa** al crearlo: por lado, el margen y dónde quedan el objetivo, el stop y la
   liquidación estimada; que ningún nivel salga en rojo y que la escalera no se corte antes de tiempo.
2. La **bitácora** las primeras horas: `BOT_STARTED`, las órdenes que se tienden (pestaña Órdenes), los
   `FILL`, y que no haya `ORDER_UNVIABLE` ni `INSUFFICIENT_FUNDS`. Un `ORDER_REJECTED` «Post-only rechazada»
   justo tras un `FILL` es normal (ver [comandos, guardas y eventos](./comandos-guardas-y-eventos.md#órdenes-con-problema)).
3. La **escalera** en la pestaña Escalera: que las órdenes estén donde esperabas.
4. Un **ciclo cerrado** (`CYCLE_CLOSED`) y su PnL frente al que calculaste a mano.
5. Un **comando**: pausar, reanudar, y ver que el stop sobrevive.

Cuánto tiempo: **al menos varios días**, y hasta ver el bot en un movimiento adverso. Una rejilla o una
escalera que solo ha visto un lateral no te ha enseñado nada de su peor caso.

---

## 3. El backtest

Disponible para **tus bots simulados** (pestaña «Backtest», o desde el detalle del bot simulado).
Reproduce la estrategia con las **mismas piezas puras** que usa el motor (`plan()`, `reconcile()`,
`withStopLoss()`, la contabilidad de ciclos) sobre velas históricas.

### Lo que pide

| Campo | Qué es | Por defecto |
|---|---|---|
| Bot simulado | La configuración que se reproduce (la vigente del bot) | — |
| Fuente de las velas | De dónde salen los precios (Binance por defecto; la lista depende de la fuente) | Binance |
| Intervalo | Tamaño de la vela: **5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d** | 15m |
| Periodo | Días hacia atrás: 7 / 30 / 90 | 30 |
| Símbolo de origen alternativo | Si el par se llama distinto en la fuente (p. ej. `1000PEPEUSDT`) | vacío |
| Capital inicial | Saldo con el que arranca la reconstrucción | el del bot |
| Comisión maker / taker | Por lado | 0,02 % / 0,05 % |
| Deslizamiento | En las órdenes a mercado | 0,05 % |
| Diferencial (bps) | Anchura fingida del libro | 2 |
| Recorrido de la vela | **Plausible** (apertura → extremo más cercano → el otro → cierre, la convención de los emuladores) o **Pesimista** (el extremo que más duele, primero) | Plausible |
| Tramos (solo Canal con IA) | Parte el periodo en 1 a 6 tramos seguidos, cada uno con sus cifras | 3 |

Tope: **10.000 velas** por ejecución. 30 días a 5 minutos son 8.640 velas (cabe); 90 días a 5 minutos son
25.920 (no cabe: usa 15 minutos). La pantalla avisa antes de lanzar.

Quedan fuera los intervalos de 1 y 3 minutos (el motor real reconcilia cada 15 s: una vela de 1 minuto no
aporta) y los de una semana o más (la hipótesis sobre el orden de máximo y mínimo no significa nada a esa
escala).

### Lo que devuelve

| Grupo | Métricas |
|---|---|
| Capital | saldo inicial, equity final, PnL neto (y en %), realizado, no realizado al final, comisiones pagadas |
| Caída | caída máxima (y en %), cuándo, pico de equity y cuándo. La caída se calcula sobre la serie **completa**, antes de remuestrear para pintar |
| Ciclos | cerrados, abiertos al final, % de acierto, duración media |
| Ejecuciones | totales, compras/ventas, maker/taker, **beneficio bruto casado** («grid profit», antes de comisiones), liquidaciones |
| Exposición | posición máxima, notional máximo, % del tiempo en mercado |
| Referencia | **comprar y mantener** en el mismo periodo. Va siempre al lado: un +8 % en un mercado que subió un 40 % no es un buen resultado |
| Calidad del dato | velas, ticks, velas que faltaban, mayor hueco |
| Canal con IA | cada operación (setup, lado, entrada, salida, R y cómo salió), una tabla **por setup y lado** (operaciones, aciertos, límite de Wilson, R medio, resultado por operación, factor de beneficio y resultado) y otra **por tramo**. Se guardan con la ejecución y vuelven al reabrirla |

Más la curva de equity, la tabla de operaciones (las últimas 200), la comparación de dos ejecuciones lado a
lado y el historial de ejecuciones guardadas, que se pueden reabrir.

### Lo que el backtest NO reproduce

Los nueve avisos comunes que acompañan **siempre** al resultado, y que hay que leer antes que las cifras
(cada estrategia añade los suyos):

1. **Orden dentro de la vela**: una vela no dice si el máximo llegó antes que el mínimo. Cuanto más larga
   la vela, mayor el error. Con «Pesimista» estresas un resultado que parece demasiado bueno.
2. **Sin profundidad de libro**: una orden en reposo se ejecuta entera al tocarla, sin parciales ni cola.
   En eso un market maker sale mejor aquí que en el venue — pero **ojo con la dirección del sesgo**: la
   falta de flujo pesa mucho más, y esa va en contra. Ver el recuadro de abajo.
3. **Margen de mantenimiento del primer tramo del mercado** (el de la vista previa: 1,25 % en BTC de
   Hyperliquid), sin la escala por tramos: una posición grande revienta **antes** en el venue. Hasta el
   spec 080 era un 0,5 % plano para todos los pares.
4. **Los precios son de la fuente** (Binance), no del venue: mismo activo, otro diferencial, otras mechas.
5. **Sin funding**: en posiciones de días puede ser el mayor componente del resultado.
6. **La ficha del mercado es la de hoy** (tick, paso, mínimo), no la del periodo reproducido.
7. **Guardas de cuenta no simuladas**: pérdida diaria global y notional total dependen de tus otros bots.
8. **El margen retenido por órdenes en reposo no se descuenta** del saldo disponible.
9. **Compara siempre contra comprar y mantener.**

Y lo que queda fuera a propósito por diseño: la persistencia, los leases, los comandos manuales, el
cortacircuitos por colocaciones fallidas y las guardas que dependen de otras posiciones.

> ⛔ **ESTE BACKTEST NO PUEDE DECIR SI UN MARKET MAKER GANA O PIERDE.** Y merece el recuadro más grande
> de esta guía, porque la conclusión equivocada es muy fácil de sacar.
>
> El replay solo tiene **precios**. Una cotización se ejecuta si, y solo si, el precio llega hasta ella —
> o sea que **todas las ejecuciones que verás son de las que el mercado vino a por ti**. Un market maker
> vive exactamente de lo contrario: del flujo que cruza su precio **sin moverlo** (alguien cerrando
> posición, un arbitrajista, una liquidación). Ese flujo no está en una vela y el replay no puede
> inventarlo.
>
> Medido: un Market Maker V2 con los valores de fábrica sobre ocho pares y 120 días da **−19,9 %** en el
> replay. Eso **no** es prueba de que la estrategia pierda; es lo que sale de medir solo la mitad mala.
>
> **Para saber si gana, usa un bot simulado en el venue**, que sí ve flujo real. El backtest sirve para lo
> otro, y para eso es bueno: ver si tu configuración hace lo que crees —dónde cotiza, cuánto inventario
> acumula, cuándo se pone defensivo— y **comparar dos configuraciones entre sí** sobre el mismo periodo.

> ℹ️ **Lo que el replay no reproduce de un market maker, y sus avisos lo dicen.** Se recotiza **una vez por
> vela**: el intervalo de actualización, la espera tras ejecución y la ventana de volatilidad no se
> reproducen, y el precio de referencia externo es la propia serie. Si «Actualizar órdenes después de» es
> menor que la vela (la V2 de fábrica, 120 s, en velas de 5 minutos), las cotizaciones caducan en cada vela y
> el bot cotiza en vela alterna; el aviso lo cuenta con los números de tu configuración. Para las dos
> rejillas, DCA, martingala y GridMart la reconstrucción es fiel a la mecánica (en la neutral, una vela solo
> puede cruzar cada línea una vez). Los rechazos del simulador al colocar una orden se **cuentan** y salen en
> los avisos con su motivo. Nada de esto, eso sí, pesa tanto como la falta de flujo del recuadro de arriba:
> **no dimensiones un market maker con el backtest, y no lo descartes por él tampoco.**

> ℹ️ **Tendencia en el backtest.** Decide con velas de **su** intervalo, no con las del replay.
> - **Si el intervalo del replay lo divide** (15m para una Tendencia de 1h), las construye agrupando
>   horas completas. Solo entra cuando la vela de su intervalo ha cerrado, como en real.
> - **Si no lo divide** (1h para una de 15m), no tiene con qué decidir: no opera, y el aviso lo dice.
> - **El calentamiento.** Las primeras velas del rango (25 con los valores de fábrica) se gastan en
>   calentar el canal y el ATR.
>
> Hasta el spec 057 (F-04) el replay no le pasaba velas y Tendencia **no operaba nunca**: esos
> resultados no valen.

> ℹ️ **El Canal con IA en el backtest** ([guía](./ai-channel.md)).
> - **Decide el juez, no la IA.** El replay usa el modo reglas con el mismo perfil, y el aviso lo dice:
>   el resultado mide el motor y las reglas, no al modelo.
> - **Solo en velas de 5 min.** Con otro intervalo, la API responde 400 antes de descargar nada. Treinta
>   días son 8.640 velas: caben en una ejecución.
> - **Calentamiento.** Descarga además unas 481 horas anteriores al periodo para las series de 15 min
>   y 1 h, sin contar en el tope. Un par listado hace menos de unos 20 días se queda corto, y se avisa.
> - **Se mide como el histórico que ve la IA.** Una límite en reposo solo se ejecuta si el precio la
>   **cruza**, no si la toca; con posición, la vela va primero hacia el stop; y un hueco que salta el stop
>   sale a la apertura. Un test fija que cada operación sale igual que su etiqueta.
> - **Las cifras.** Una operación cuenta en el tramo en que se cerró; la que sigue abierta al final no
>   cuenta. Con menos de 20 operaciones por setup no se puede concluir nada, y el acierto que importa es
>   el de **Wilson**, no el visto.
> - **Cómo hacer el walk-forward.** Tres ejecuciones de 30 días seguidos por par, con tramos. Un
>   resultado que solo sale bien en un tramo es un periodo, no una ventaja.

> ⚠️ **Nota histórica.** Hasta la corrección de F-45 (spec 004, septiembre de 2026) el simulador y el
> backtest ejecutaban el stop-loss **en el acto** al colocarlo: cualquier backtest anterior con
> `stopLossPct` cerraba la posición nada más abrir. **Esos resultados no valen**; repítelos.

---

## 4. Cómo usar las dos juntas

1. **Backtest** de la configuración candidata sobre 30 y 90 días, en «Plausible» y en «Pesimista». Si el
   resultado depende de la elección, la configuración es frágil.
2. Mira la **caída máxima** y la **posición máxima**, no el PnL: son tu peor caso vivido.
3. Compara dos variantes (más capital frente a menos niveles; 1× frente a 2×) con la comparación lado a
   lado.
4. **Simula** la ganadora varios días y comprueba que la bitácora se comporta como el backtest sugería.
5. Solo entonces, **testnet** o mainnet con 20 USDC y 1× ([camino obligatorio](./buenas-practicas.md#2-el-camino-obligatorio)).

En el **Canal con IA** el orden es el mismo, con dos matices: el backtest mide el juez, así que la
simulación de 48-72 horas con la IA encendida es la que dice cómo decide el modelo; y lo primero con
dinero real es un capital pequeño, mirando los avisos y probando el botón de pausa.
