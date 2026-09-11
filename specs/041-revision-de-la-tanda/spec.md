# 041 — Revisión de los specs 037-040

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/041-revision-de-la-tanda`

## Objetivo

Corregir lo que apareció al releer con calma los cuatro specs anteriores. Tres son defectos de
verdad y el peor de ellos —una entrada duplicada— cumple la definición de **Crítica** de
`specs/README.md` al pie de la letra.

## Contexto

Los specs 037-040 salieron todos en verde: 6.146 tests, lint limpio, la app compila. Pero los
tests solo prueban lo que alguien pensó en probar, y en la estrategia de tendencia hay tres cosas
que ningún test miraba porque las tres ocurren en **ventanas de tiempo** que un test de una sola
llamada no produce.

Las tres son del spec 040, y no es casualidad: es la única estrategia nueva, la única que abre
posición a mercado y la única cuyo riesgo depende de un cálculo y no de un campo.

## Alcance

- `packages/strategy-core/src/strategies/trend-follow.ts`
- `packages/strategy-core/src/strategies/mm-shared.ts` (el markout rancio)
- Sus tests, y `docs/trend-follow.md`

## Fuera de alcance

- Todo lo demás de los specs 037-039, que se revisó y está bien. Lo verificado se anota en
  `findings.md` para no volver a revisarlo.
- `F-01` del 037 (el doble cobro del coste en la V2), que sigue esperando decisión del usuario.

## Requisitos

- **R-1 — `reusesOrderSlots` fuera de la estrategia de tendencia. (Crítica)**

  Con esa bandera, el motor **permite recolocar un `clientOrderId` que ya se ejecutó**
  ([`bot-runner.ts:1036`](../../apps/worker/src/engine/bot-runner.ts#L1036)). Para un market maker
  es necesario: «ejecutada» significa que el hueco quedó libre. Para una entrada a mercado de un
  solo disparo es una **segunda entrada**.

  La ventana no es estrecha: la señal de ruptura sale de la **vela cerrada**, así que sigue siendo
  cierta durante todo el intervalo —hasta cuatro horas—. Mientras la posición no aparezca en
  `getPositions()`, cada tick de quince segundos vuelve a ver ruptura, vuelve a ver posición cero y
  vuelve a emitir `BASE#0`. Sin la bandera, la fila `FILLED` veta la recolocación para el resto del
  ciclo, que es exactamente la protección que hace falta.

  Y no se pierde nada: al cerrarse la posición el ciclo se cierra —`keepCycleOnFlat` no está
  declarado—, sube `cycleSeq` y los ids del ciclo siguiente son otros.

- **R-2 — El primer stop se ancla en el precio de ENTRADA, no en la marca.**

  Hoy el stop inicial sale de `mark ∓ k·ATR`. Si el precio se mueve en contra entre la ejecución y
  el primer tick con posición, el stop se coloca más lejos y **la operación arriesga más que el
  porcentaje declarado** — que es justo la promesa que sostiene la estrategia entera.

  Con entrada en 100 y `k·ATR = 4,5`, el stop debe ir a 95,5. Si el precio cae a 94 antes del
  primer tick, hoy va a 89,5: se arriesga el doble.

  El arreglo conserva el seguimiento: el primer stop es
  `max(entrada − k·ATR, marca − k·ATR)` para un largo, así que si el precio se ha ido **a favor**
  el stop ya nace más arriba, y si se ha ido **en contra** nace donde tenía que nacer.

- **R-3 — El tamaño se acota por el capital y por el margen disponible.**

  El spec 040 lo pedía (R-3: «acotado por `maxNotionalCap` y por el margen disponible») y no se
  implementó. `cantidad()` divide el riesgo entre la distancia al stop sin mirar nada más, así que
  en un mercado muy tranquilo —ATR pequeño— el nocional puede salir varias veces el capital.

  Se acota por el menor de: `maxNotionalCap`, `totalInvestment × apalancamiento` y
  `availableBalance × apalancamiento`. Recortar **reduce** el riesgo por debajo del declarado, así
  que es seguro; pero la nota lo dice, porque el usuario pidió arriesgar un 1 % y va a arriesgar
  menos.

- **R-4 — Un markout demasiado viejo se descarta en vez de contaminar la media.**

  `resolverMarkout` resuelve todo fill con `now − ts >= horizonte`. Si el bot ha estado sin
  planificar —fuente externa caída, bot pausado, worker relevado—, un fill de hace diez minutos se
  resuelve contra el mid de ahora y entra en la EWMA como si fuera un markout de cuarenta y cinco
  segundos. Se descartan los que pasen de **tres veces el horizonte**: no son medibles, y una
  medida falsa es peor que ninguna.

## Criterios de aceptación

- **CA-1** La estrategia de tendencia **no** declara `reusesOrderSlots`, y un test lo fija con el
  motivo escrito.
- **CA-2** Con entrada en 100, `k·ATR = 4,5` y la marca ya en 94, el primer stop sale en **95,50**,
  no en 89,50.
- **CA-3** Con la marca en 106, el primer stop sale en **101,50**: el seguimiento funciona desde el
  primer tick. Y en corto es el espejo: entrada 100 y marca 106 dan **104,50**, no 110,50.
- **CA-4** Con un ATR minúsculo, el nocional de la entrada no supera `totalInvestment ×
  apalancamiento`, y la nota lo dice.
- **CA-5** Con `maxNotionalCap` por debajo de ese producto, manda el `maxNotionalCap`.
- **CA-6** Un fill de hace más de tres horizontes **no** entra en la EWMA y desaparece de
  pendientes.
- **CA-7** `pnpm test` verde, `pnpm lint` limpio, `ng build` sin errores.

## Riesgos

- **R-1 cambia el comportamiento de una estrategia que nadie ha ejecutado todavía.** Es de ayer y
  no hay ningún bot con ella; el riesgo real es cero.
- **R-3 puede hacer que el bot abra menos de lo que el usuario esperaba** en pares muy tranquilos.
  Es lo correcto —no se puede abrir lo que el margen no sostiene— y por eso lleva nota.
