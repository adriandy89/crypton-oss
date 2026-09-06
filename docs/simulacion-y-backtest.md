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

- Puedes cambiar el **saldo simulado** (simular con 10.000 cuando piensas invertir 500 no enseña nada) y
  **reiniciar** el estado simulado: la API vuelve al saldo inicial y borra posiciones y órdenes fingidas.
- Un bot decide **al crearse** si es simulado o real (`dry_run`) y **no puede cambiar**: mezclar simulado y
  real en el mismo bot haría que su histórico no significara nada. Para pasar a real, creas otro bot.
- Puedes tener **varios bots simulados sobre el mismo par**; la regla «un solo bot real por par y cuenta»
  no aplica a los simulados.
- La curva de la cartera, el ranking y el copy-trading **excluyen** los bots simulados.

### Qué hace el simulador, exactamente

| Situación | Simulador | Venue real |
|---|---|---|
| Orden limit / post-only colgada | Se ejecuta **entera y a su propio precio** en cuanto el mejor precio contrario la toca (`ask ≤ compra`, `bid ≥ venta`) | Puede ejecutarse parcialmente y hay cola de prioridad |
| Post-only que cruzaría el libro | **Rechazada**: «Post-only rechazada: cruzaría el libro» | Igual |
| Orden a mercado | Se ejecuta al mejor precio contrario **con un deslizamiento del 0,05 %** en contra, como taker | Depende de la profundidad |
| Comisiones | **0,02 % maker · 0,05 % taker**, descontadas del PnL realizado | Las del venue (y las del builder, si las hay) |
| Stop-loss / take profit condicionales | Orden **en reposo** que se dispara con el precio de marca y se ejecuta al precio del disparador con deslizamiento (corregido en el spec 004; antes cerraba en el acto) | Igual, condicional nativa |
| Liquidación | Comprobada con una tasa de mantenimiento plana del 0,5 % | Escala por tramos del venue |
| Funding | **No existe** | Se cobra o paga periódicamente |
| Margen retenido por órdenes en reposo | **No se descuenta** del saldo disponible | Sí |
| Límites de cuota y de órdenes activas | No aplican (`NO_BUDGET`) | Aplican (Lighter: 60 peticiones/min, 30 órdenes por mercado) |

Consecuencia: **el simulador es algo optimista** para un market maker (todo se ejecuta entero y sin cola) y
**realista** para rejillas y escaleras en cuanto a precios, y **no dice nada** del funding ni de los límites
del venue. Un bot que pierde en simulación perderá en real; uno que gana en simulación **puede** perder en
real.

### Qué mirar en un bot simulado

1. La **vista previa** al crearlo: peor caso, margen, liquidación estimada, y que ningún nivel salga en rojo.
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

Más la curva de equity, la tabla de operaciones (las últimas 200), la comparación de dos ejecuciones lado a
lado y el historial de ejecuciones guardadas, que se pueden reabrir.

### Lo que el backtest NO reproduce

Los nueve avisos que acompañan **siempre** al resultado, y que hay que leer antes que las cifras:

1. **Orden dentro de la vela**: una vela no dice si el máximo llegó antes que el mínimo. Cuanto más larga
   la vela, mayor el error. Con «Pesimista» estresas un resultado que parece demasiado bueno.
2. **Sin profundidad de libro**: una orden en reposo se ejecuta entera al tocarla, sin parciales ni cola.
   Un market maker sale mejor aquí que en el venue.
3. **Margen de mantenimiento plano** (≈ 0,5 %): una posición grande revienta **antes** en el venue.
4. **Los precios son de la fuente** (Binance), no del venue: mismo activo, otro diferencial, otras mechas.
5. **Sin funding**: en posiciones de días puede ser el mayor componente del resultado.
6. **La ficha del mercado es la de hoy** (tick, paso, mínimo), no la del periodo reproducido.
7. **Guardas de cuenta no simuladas**: pérdida diaria global y notional total dependen de tus otros bots.
8. **El margen retenido por órdenes en reposo no se descuenta** del saldo disponible.
9. **Compara siempre contra comprar y mantener.**

Y lo que queda fuera a propósito por diseño: la persistencia, los leases, los comandos manuales, el
cortacircuitos por colocaciones fallidas y las guardas que dependen de otras posiciones.

> ℹ️ **Lo que el replay no reproduce de un market maker, y sus avisos lo dicen.** Se recotiza **una vez por
> vela**: el intervalo de actualización, la espera tras ejecución y la ventana de volatilidad no se
> reproducen, y el precio de referencia externo es la propia serie. Si «Actualizar órdenes después de» es
> menor que la vela (la V2 de fábrica, 120 s, en velas de 5 minutos), las cotizaciones caducan en cada vela y
> el bot cotiza en vela alterna; el aviso lo cuenta con los números de tu configuración. Para las dos
> rejillas, DCA, martingala y GridMart la reconstrucción es fiel a la mecánica (en la neutral, una vela solo
> puede cruzar cada línea una vez). Los rechazos del simulador al colocar una orden se **cuentan** y salen en
> los avisos con su motivo. No dimensiones un market maker con el backtest.

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
