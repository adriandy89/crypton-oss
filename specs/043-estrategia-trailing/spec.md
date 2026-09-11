# 043 — Un bot que solo hace eso: entrar, seguir al máximo y salir

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/043-estrategia-trailing`

## Objetivo

La tarjeta que pidió el usuario: **«pongo 15 % y 1 %, y me olvido»**. Una estrategia que entra una
vez, deja correr el beneficio siguiendo al máximo y cierra cuando el precio retrocede lo pedido.

Se sabrá que está hecho cuando un bot nuevo con solo dos números configurados —objetivo y
retroceso— entre, coloque su disparador al llegar al objetivo, lo suba con el mercado y cierre en
el retroceso; y cuando la pantalla de crear bot lo ofrezca con su guía completa, como las ocho que
ya hay.

## Contexto

El **mecanismo ya está hecho** en el spec 042: `trailingVigente()`, el `intent` explícito y la
marca de agua del precio entre revisiones. Lo que falta es la estrategia que lo use **sin nada
más**, porque en TDCA y en Martingala el seguimiento es un interruptor sobre una escalera de
compras — y quien quiere «una operación que deje correr el beneficio» no quiere una escalera.

Lo que la hace distinta de las ocho existentes: **no promedia, no cotiza y no repone**. Es una
operación con una salida en movimiento. La más parecida es la de tendencia del spec 040, y se
diferencian en lo esencial:

| | **Seguimiento de beneficio** (esta) | [Tendencia](../040-estrategia-de-tendencia/spec.md) |
|---|---|---|
| Cuándo entra | Ya, o al cruzar un precio que tú pones | Cuando el precio rompe su canal de 20 velas |
| Qué mira | El precio, y nada más | Velas, canal Donchian, ATR y eficiencia |
| Tamaño | El capital asignado por el apalancamiento | `riesgo / (k × ATR)` |
| Salida | Sigue al máximo **desde tu objetivo** | Stop de ATR que sigue desde el primer momento |
| Sin llegar al objetivo | No hay salida de beneficio; protege el stop | El stop de ATR ya está puesto |

La de tendencia **no tiene objetivo de beneficio a propósito** —acierta cuatro de cada diez y vive
de los ganadores grandes—. Esta tiene uno, y lo usa como punto de partida del seguimiento. Son dos
tesis distintas, no dos versiones de la misma.

## Alcance

- `packages/shared/src/enums.ts` — `StrategyKind.TRAILING_PROFIT`
- `packages/db/prisma/schema.prisma` + migración — el valor del enum. **Autorizado por este spec.**
- `packages/strategy-core/src/strategies/trailing-profit.ts` — la estrategia, nueva
- `packages/strategy-core/src/{registry,index}.ts` — alta
- `packages/strategy-core/src/trailing-take-profit.ts` — que los campos se puedan pedir sin el interruptor
- `apps/api/src/modules/advisor/build.ts` — su rama en el asesor
- La app: unión de tipos, etiquetas, guía, nombres de campo
- `docs/trailing-profit.md` y el índice de `docs/README.md`
- `packages/backtest/src/warnings.ts` — el aviso de paridad que corresponda

## Fuera de alcance

- **Cambiar nada de las ocho estrategias existentes.** El 042 ya dejó el mecanismo compartido.
- **Entrada escalonada** (varias compras). Eso es el DCA temporizado con el interruptor del 042.
- **Objetivo fijo alternativo.** Quien quiera salir en un precio y ya tiene siete estrategias que
  lo hacen; esta es la que sigue al máximo, y un interruptor para apagar lo único que hace sería un
  bot sin identidad.

## Requisitos

- **R-1 — Un solo mando de entrada, y ya existe.** `activationMode` (`NONE` / `PRICE_ABOVE` /
  `PRICE_BELOW`) con `activationPrice`, las mismas claves, el mismo enum y la **misma función**
  `activationGate()` que el market maker V2 — código ya probado. Con `NONE` entra a mercado en la
  primera revisión; con las otras dos espera a que el precio cruce.

  No se inventa un `entryMode` propio: dos mandos para la misma pregunta acaban contradiciéndose.

- **R-2 — Sin campo de tamaño.** El nocional es el menor de `totalInvestment × apalancamiento`,
  `availableBalance × apalancamiento` y `maxNotionalCap` — el mismo `techoNocional()` del spec 041.
  Quien quiera arriesgar menos baja el capital asignado o pone el tope de exposición, que son
  conceptos que ya están en el formulario y ya tienen guía.

  Un campo más aquí sería un tercer sitio donde decir cuánto dinero se pone.

- **R-3 — El seguimiento no se puede apagar: es la estrategia.** Se piden los dos campos del 042
  —`trailingCallbackPct` y `trailingRepriceBps`— **sin** el interruptor `trailingTakeProfit`, que
  vale `true` siempre. `camposTrailing()` gana un parámetro para poder pedirlos así.

- **R-4 — `takeProfitPct` es la activación, y se llama así en la pantalla.** En TDCA y Martingala
  el campo tiene dos papeles según el interruptor; aquí solo tiene uno, así que la etiqueta lo dice
  sin ambigüedad: **«Beneficio al que empieza a seguir (%)»**.

- **R-5 — Un ciclo por operación, y vuelve a entrar.** No declara `keepCycleOnFlat`: al cerrarse la
  posición se cierra el ciclo, sube `cycleSeq` y el `scratch` se vacía —con él, el máximo y el
  armado—. Después vuelve a entrar respetando `cooldownMinutes`, que **nace en 60** para que no
  encadene operaciones en el mismo minuto.

  Va en la guía en primera línea: **es un bot, no una operación suelta**.

- **R-6 — NO declara `reusesOrderSlots`.** Es la lección Crítica del spec 041: con una entrada a
  mercado de un solo disparo, esa bandera permite que el motor recoloque un id ya ejecutado
  mientras la posición tarda en aparecer en `getPositions()` — o sea, una segunda entrada. Con un
  test que lo fija y el motivo escrito.

- **R-7 — Nace con stop loss.** `stopLossPct` de fábrica **5 %**. Por debajo del objetivo el
  seguimiento no protege nada, y esta es la única estrategia en la que esa ventana es *toda* la
  operación hasta que llega al objetivo. `validate()` **avisa** si se quita.

- **R-8 — Alta completa.** El sistema de tipos de la app es el checklist y no compila hasta que
  estén: enum de `shared` y de Prisma con migración, registro, asesor, unión de tipos, etiqueta,
  guía con **una ficha por campo**, nombres de campo, `docs/` con su índice y el aviso de paridad
  del backtest.

## Criterios de aceptación

- **CA-1** Plana y con `activationMode: NONE`, emite `BASE#0` a mercado por el nocional que
  permiten capital, saldo y tope — el menor de los tres.
- **CA-2** Con `PRICE_ABOVE` y el precio por debajo del disparador **no** emite nada, y la nota
  dice a qué espera.
- **CA-3** Con posición y por debajo del objetivo no hay orden de beneficio, y el stop del motor
  sigue ahí.
- **CA-4** Al cruzar el objetivo aparece el `TAKE_PROFIT#0` con `intent: 'SL'`, `type: 'MARKET'`,
  `triggerPrice` y `reduceOnly`.
- **CA-5** El disparador sube con el máximo y **nunca** baja.
- **CA-6** En corto, el espejo exacto.
- **CA-7** La estrategia **no** declara `reusesOrderSlots`, con el motivo escrito (R-6).
- **CA-8** `defaults()` incluye `stopLossPct: '5'` y `cooldownMinutes: 60`, y `validate()` avisa si
  se deja el stop a cero.
- **CA-9** Camino completo en el simulador, a través del runner real: entra, no sale al +10 %,
  sigue al máximo visto **solo por el stream** y cierra al retroceder.

  *La segunda mitad —«y el ciclo siguiente vuelve a entrar pasada la espera»— se comprueba en el
  test puro y no en el del worker: el `MemoryStore` del harness no cierra ciclos (su
  `applyFillToCycle` solo lleva la cuenta de niveles), así que allí no hay espera que observar.
  Hacerlo cerrar ciclos tocaría las veintitrés pruebas que comparten ese doble.*
- **CA-10** El asesor devuelve una configuración **válida** para los tres perfiles.
- **CA-11** `pnpm test` verde, `pnpm lint` limpio, `ng build` sin errores, `tsc` del worker sin
  errores.
- **CA-12** *(manual, usuario)* Un bot simulado con objetivo 2 % y retroceso 0,5 % sobre un par con
  movimiento: entra, la condicional aparece tras cruzar el 2 %, sube y nunca baja, y al cerrarse
  arranca un ciclo nuevo pasada la espera.

## Lo que apareció por el camino

- **El filtro de estrategias del panel de administración se enumera a mano** y se había quedado sin
  la del spec 040: un bot de tendencia no se podía filtrar. Se añaden las dos
  ([bots.page.ts](../../apps/app/src/app/features/admin/bots.page.ts)).
- **El tamaño se dimensiona sobre la MARCA y la compra se llena en el ask**, así que el nocional
  real queda medio diferencial por encima del tope — un 0,05 % en el par de prueba. Es la misma
  cuenta que hace la estrategia de tendencia desde el spec 041 y se deja igual a propósito: cambiar
  solo esta las dejaría distintas sin motivo. Queda anotado en el test, con el número.
- **`buildTrend` del asesor devuelve `allowShort`**, que no es un campo de `TrendFollowConfig`: el
  spec 040 lo sustituyó por `direction: NEUTRAL` y el asesor se quedó con la clave vieja. No se
  toca aquí porque cambiar la salida del asesor cambia lo que se le propone al usuario.

## Riesgos

- **Toca `packages/db/prisma`.** Un valor de enum: no altera ninguna fila ni ninguna columna. Es
  exactamente la misma migración que el spec 040, que se aplicó y se verificó en local.
- **Es la primera estrategia sin ninguna red por debajo del objetivo salvo el stop.** De ahí R-7 y
  de ahí que la guía empiece por el peor caso y no por el mejor.
- **Vuelve a entrar sola.** Es lo que hace un bot, pero hay que decirlo: quien esperaba una sola
  operación se encontrará la segunda. Va en la guía, en la etiqueta y en la nota del plan.
