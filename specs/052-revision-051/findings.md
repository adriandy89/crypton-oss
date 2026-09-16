# 052 — Hallazgos

Revisión del spec 051 completo. La severidad sigue la escala de `specs/README.md`.

Commit base: `060cf9c` (`main`, spec 051 mergeado y desplegado) · Fecha: 2026-09-16 ·
Versiones: node 24.12.0, pnpm 10.28.1 · Hosts sondeados: ninguno (no hace falta: no hay ninguna
regla de venue por medio).

## Línea base

`pnpm build:packages`, `pnpm --filter api exec jest`, `pnpm lint` y `pnpm check:env` sobre
`060cf9c`, antes de tocar nada. Se anota en `tasks.md`.

## Por qué ninguno es Crítico

La escala exige que el defecto produzca una de cinco cosas: posición sin su stop, exposición u
órdenes duplicadas, caída del worker, firma contra la red equivocada, o rechazo sistemático de toda
orden. El supervisor **no firma, no coloca, no cancela y no manda comandos**: su única salida es
`BotsService.updateConfig`. Ninguno de estos hallazgos puede producir ninguna de las cinco. Es el
mismo razonamiento del spec 047, y sigue valiendo.

Lo que sí hay son seis **Altas**, todas de la misma familia: el traslado del delta no tiene cota.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | Con posición abierta se puede estrechar el stop de verdad de `TREND_FOLLOW` | traducción | Alta | corregido en 052 | `apply.ts:406`; `trend-follow.ts:214,341`; `build.ts:604` | S |
| F-02 | El traslado aditivo aplasta al mínimo las distancias de un market maker ajustado | traducción | Alta | corregido en 052 | `apply.ts:253-262` | M |
| F-03 | Un escalón de apalancamiento puede duplicar el tamaño y el tope de un bot sin posición | traducción | Alta | corregido en 052 | `apply.ts:248-251` | M |
| F-04 | En modo «cantidad de moneda» el redondeo a dos decimales destruye la cantidad | traducción | Alta | corregido en 052 | `apply.ts:250`; `common.ts:337-351` | S |
| F-05 | El tope de un market maker que cierra baja contra una exposición de hace diez minutos | traducción | Alta | corregido en 052 | `apply.ts:441-455`; `supervisor.service.ts:1250` | M |
| F-06 | Un cambio automático pisa lo que el dueño editó durante la llamada al modelo | servicio | Alta | corregido en 052 | `supervisor.service.ts:556-561`; `bots.service.ts:1004-1016` | M |
| F-07 | El enfriamiento WARM frena también las propuestas del modo manual | servicio | Media | corregido en 052 | `supervisor.service.ts:270`, `194-208` | S |
| F-08 | La lista de efectos solo prueba un escalón y el prompt promete los dos | efectos | Media | corregido en 052 | `apply.ts:657-672`; `decision.ts` | M |
| F-09 | Un efecto sale «sí» aunque los límites de riesgo del usuario lo vayan a rechazar | efectos | Media | corregido en 052 | `risk.service.ts:76-93`; `sanitize.ts:158-159` | M |
| F-10 | `failures` no vuelve a cero nunca: cinco fallos sueltos pausan el bot | servicio | Media | corregido en 052 | `supervisor.service.ts:647,679`; `supervisor.policy.service.ts:161` | S |
| F-11 | Un campo apagado con un cero se enciende solo al trasladar | traducción | Media | corregido en 052 | `apply.ts:253-262`; `market-maker-v2.ts:374-386` | S |
| F-12 | Un market maker de una capa convierte en WARM un cambio que era HOT | traducción | Media | corregido en 052 | `build.ts:503`; `market-maker.ts:374-386` | S |
| F-13 | El turno del aviso se pierde si falla una escritura posterior | servicio | Media | corregido en 052 | `supervisor.service.ts:482-494` | S |
| F-14 | La huella cambia cuando el latente cruza el cero | expediente | Media | corregido en 052 | `dossier.ts:411` | S |
| F-15 | Cada aviso se paga con una llamada de más | expediente | Media | corregido en 052 | `dossier.ts:421` | S |
| F-16 | Sin estado reciente el expediente dice «sin posición» y la guarda decide lo contrario | expediente | Media | corregido en 052 | `supervisor.service.ts:1142,1210` | S |
| F-17 | Una propuesta que nadie aprobó se vuelve a proponer igual, y otra vez a Telegram | expediente | Media | corregido en 052 | `supervisor.service.ts:1057-1067`; `supervisor.scheduler.ts:139` | S |
| F-18 | Se presentan como incidencias eventos que ninguna perilla arregla | expediente | Media | corregido en 052 | `dossier.ts:250-258`; `bot-runner.ts:949,2557` | S |
| F-19 | La huella se guarda antes de que exista la fila de la decisión | servicio | Baja | descartado | `supervisor.service.ts:308,415` | — |
| F-20 | Las perillas avanzan aunque la mitad del movimiento no tuviera efecto | servicio | Baja | descartado | plan del 051, «Decisiones» | — |
| F-21 | El enfriamiento WARM cuenta también los cambios que aprobó una persona | servicio | Baja | descartado | `supervisor.service.ts:196-207` | — |

Estados: `por confirmar` · `confirmado` · `corregido en NNN` · `seguimiento NNN` · `descartado`.

Los dieciocho confirmados se corrigieron en esta misma rama, con su test y su mutación, por
decisión del usuario del 2026-09-16: el spec 051 acaba de desplegarse y mergear algo que ya se sabe
defectuoso para arreglarlo en un 053 es peor negocio. Es el mismo razonamiento del 047.

## Fichas

### F-01 — Con posición abierta se puede estrechar el stop de verdad de `TREND_FOLLOW`

- **Síntoma**: `BLOQUEADOS_CON_POSICION` protege `stopLossPct` en las cuatro estrategias. En
  `TREND_FOLLOW` ese campo **no es el stop**: el validador lo rechaza si viene con valor
  (`trend-follow.ts:341-347`, «el stop lo pone la estrategia»), y el stop real sale de
  `atrStopMultiplier` (`trend-follow.ts:214`: `atrValor × atrStopMultiplier`). La perilla
  `diferencial` lo mueve (`build.ts:604`: `2,5 × FACTOR[spread]`), así que «diferencial MENOS»
  sobre un bot con posición abierta estrecha el stop de una posición viva.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:406`;
  `packages/strategy-core/src/strategies/trend-follow.ts:214,341`;
  `apps/api/src/modules/advisor/build.ts:604`.
- **Impacto**: el 046 le prohíbe al supervisor cerrar posiciones y el 051 escribió la guarda que lo
  hace verdad; en la única estrategia de tendencia la guarda vigila un campo que siempre está vacío
  —es código muerto— y deja libre el que dispara. Un largo que pierde un 3 % con el stop en 2,5 ATR
  puede salir en el siguiente tick si el multiplicador baja a 2.
- **Reproducción / test**: `apply.spec.ts` › «TREND con posición abierta: diferencial MENOS es
  CIERRE».
- **Propuesta**: `atrStopMultiplier` a `BLOQUEADOS_CON_POSICION.TREND_FOLLOW`.
- **Decisión**: corregir en este spec.

### F-02 — El traslado aditivo aplasta al mínimo las distancias de un market maker ajustado

- **Síntoma**: `trasladarCampo` suma al valor vivo la diferencia entre las dos generaciones, sin
  ninguna cota relativa. El generador trabaja con los números que él produciría; el bot puede tener
  otros mucho menores. Con un market maker ajustado a 6 bps y un generador que va de 22 a 8 bps, el
  delta es −14 y el bot acaba en el mínimo del descriptor (1 bps): cotizar por debajo de las
  comisiones.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:253-262` (`nuevo = v.plus(delta)`), con
  el acotado al descriptor justo debajo.
- **Impacto**: pérdida real y continua —cada par casado por debajo de comisiones pierde— sobre
  justamente los bots que el spec 051 vino a proteger. Es el mismo defecto del 051/H-05 con otra
  aritmética: allí se copiaba el valor generado, aquí se copia su salto.
- **Reproducción / test**: `apply.spec.ts` › «un escalón no mueve un campo más de un cuarto».
- **Propuesta**: cota relativa por escalón pedido (25 % del valor vivo por escalón), aplicada antes
  del acotado al descriptor.
- **Decisión**: corregir en este spec.

### F-03 — Un escalón de apalancamiento puede duplicar el tamaño y el tope de un bot sin posición

- **Síntoma**: los importes se trasladan en proporción (`v × d / a`) sin cota. La proporción la
  decide el generador: entre dos bandas de apalancamiento hay saltos de más del doble, y
  `maxBotPositionValue` sale de `totalInvestment × lev × …` (`build.ts:488`). Con el bot plano no
  hay guarda de posición que lo pare, así que el tamaño por lado y el tope de posición se
  multiplican de una vez.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:248-251`;
  `apps/api/src/modules/advisor/build.ts:488`.
- **Impacto**: una revisión sube el riesgo de un bot al doble sin que nadie mire. El tope de
  apalancamiento por revisión (`conTopeDeApalancamiento`, +1 punto) acota el apalancamiento pero no
  los importes que la perilla arrastra.
- **Reproducción / test**: `apply.spec.ts` › «los importes tampoco se mueven más de un cuarto por
  escalón».
- **Propuesta**: la misma cota relativa de F-02, que en un importe se aplica sobre la proporción.
- **Decisión**: corregir en este spec.

### F-04 — En modo «cantidad de moneda» el redondeo a dos decimales destruye la cantidad

- **Síntoma**: un importe se redondea a `max(decimales del valor vivo, 2)`. En modo `BASE`,
  `orderSizePerSide` **no es un importe**: es una cantidad de moneda, y `camposEfectivos` le pone
  como mínimo la `minQty` del venue (`common.ts:337-351`). Un bot de BTC con `0.01` y una
  proporción de 0,9 da `0.009`, que redondeado a dos decimales es `0.00` y acotado al mínimo acaba
  en `0.00001`: mil veces menos.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:250`;
  `packages/strategy-core/src/common.ts:337-351`.
- **Impacto**: en el mejor caso la propuesta muere en `preview()` como `VENUE` —el notional mínimo
  no se cumple— y el supervisor no puede ajustar nunca el tamaño de un bot en modo cantidad; en el
  peor, en un par barato donde el mínimo sí se cumple, el bot se queda cotizando polvo.
- **Reproducción / test**: `apply.spec.ts` › «modo BASE: la cantidad conserva los decimales del
  venue».
- **Propuesta**: redondear con `max(decimales del vivo, decimales del mínimo y del paso del campo
  efectivo, 2)`.
- **Decisión**: corregir en este spec.

### F-05 — El tope de un market maker que cierra baja contra una exposición de hace diez minutos

- **Síntoma**: `guardaDePosicion` permite bajar `maxBotPositionValue` de un market maker con
  `limitAction ≠ PAUSE_ENTRIES` si el tope nuevo queda por encima de la exposición × 1,25. La
  exposición viene del último estado del bot, que se acepta hasta con **diez minutos**
  (`SNAPSHOT_FRESCO_MS`). Un market maker acumula inventario en minutos: con la foto de hace diez,
  el tope nuevo puede quedar por debajo de lo que el bot tiene ahora.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:441-455`;
  `apps/api/src/modules/supervisor/supervisor.service.ts:1250`.
- **Impacto**: es exactamente lo que la guarda existe para impedir —`limitAction: CLOSE_ALL` cierra
  la posición entera al tocar el tope—, y la holgura del 25 % no cubre diez minutos de un market
  maker activo.
- **Reproducción / test**: `apply.spec.ts` › «con una exposición rancia no se baja el tope».
- **Propuesta**: `PosicionViva` lleva la antigüedad de la medida; para bajar el tope se exige
  fresca (dos minutos). Sin eso, `CIERRE`, como ya hace cuando no se conoce.
- **Decisión**: corregir en este spec.

### F-06 — Un cambio automático pisa lo que el dueño editó durante la llamada al modelo

- **Síntoma**: el supervisor lee la configuración vigente, tarda unos 25 s en la llamada al modelo y
  escribe con `updateConfig` la configuración **entera** que calculó sobre lo que leyó.
  `updateConfig` diferencia contra la revisión de ese momento, no contra la que se leyó, así que
  cualquier campo que el dueño cambiara mientras tanto vuelve atrás sin que nada lo señale. La ruta
  de aprobación por Telegram sí lo comprueba (`config_version_before !== bot.config_version`,
  `supervisor.service.ts:804`); la automática no.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:556-561`;
  `apps/api/src/modules/bots/bots.service.ts:1004-1016`.
- **Impacto**: un usuario que estrecha su stop o baja su tamaño mientras el supervisor piensa ve su
  cambio deshecho por un proceso automático, y en el histórico aparece como un cambio del
  supervisor, no como una reversión.
- **Reproducción / test**: `supervisor.service.spec.ts` › «si la configuración cambió durante la
  llamada, no se aplica»; `bots.service.spec.ts` › «`expectedVersion`».
- **Propuesta**: `UpdateConfigOptions.expectedVersion`, comprobada al leer y **dentro de la
  transacción** (`updateMany` con la versión en el `where`, contando filas). El supervisor la pasa;
  el rechazo se anota `CADUCADA`/`STALE` y no como fallo.
- **Decisión**: corregir en este spec.

### F-07 — El enfriamiento WARM frena también las propuestas del modo manual

- **Síntoma**: `permitirWarm` se calcula en `revisarBot` sin mirar el modo, y con él se calculan los
  efectos y la decisión. En MANUAL no se aplica nada: se propone y decide una persona. Aun así, un
  WARM aplicado hace una hora hace que durante seis horas el modelo vea «recolocar no está
  permitido» y no pueda proponérselo a nadie. Al aprobar, `rehacer` no mira el enfriamiento, así que
  lo que se prohíbe proponer sí se permite aplicar: la incoherencia lo delata.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:270`, `194-208`, `930`.
- **Impacto**: el modo manual —la mitad del encargo del 046— se queda sin su decisión más
  importante durante seis horas por un freno pensado para el automático.
- **Reproducción / test**: `supervisor.service.spec.ts` › «en manual el enfriamiento WARM no frena
  la propuesta».
- **Propuesta**: el enfriamiento se aplica solo cuando la decisión se va a aplicar sola (AUTO y sin
  `AI_AGENT_FORCE_MANUAL`).
- **Decisión**: corregir en este spec.

### F-08 — La lista de efectos solo prueba un escalón y el prompt promete los dos

- **Síntoma**: `movimientosConEfecto` prueba `MENOS` y `MAS` (un escalón). El prompt dice «Solo
  tienen efecto los movimientos marcados sí», y el contrato permite `MUCHO_MENOS` y `MUCHO_MAS`. Una
  perilla cuyo escalón se queda corto —el delta no llega al paso del campo, o la cota relativa lo
  recorta a nada— sale como «no cambia nada» aunque dos escalones sí cambien algo.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:657-672`;
  `apps/api/src/modules/supervisor/decision.ts` (prompt v2).
- **Impacto**: el modelo descarta el movimiento que sí servía, y el expediente miente en la sección
  que el 051 añadió precisamente para que dejara de pedir lo imposible.
- **Reproducción / test**: `apply.spec.ts` › «lo que no mueve un escalón pero sí dos sale como
  aplicable con dos».
- **Propuesta**: cuando un escalón da `SIN_CAMBIOS`, probar dos y marcarlo; el expediente lo dice
  («sí, con dos escalones») y el prompt lo explica.
- **Decisión**: corregir en este spec.

### F-09 — Un efecto sale «sí» aunque los límites de riesgo del usuario lo vayan a rechazar

- **Síntoma**: `decidirCambio` acota el apalancamiento a `MAX_SAFE_LEVERAGE`, al del venue y al
  `max_leverage` del usuario, pero no a sus **límites de notional** (`max_notional_per_bot`,
  `max_total_notional`) ni al tope por distancia de liquidación del mercado, que sí comprueba
  `assertWithinLimits` dentro de `updateConfig`.
- **Evidencia**: `apps/api/src/modules/risk/risk.service.ts:76-93,101-104`;
  `apps/api/src/modules/advisor/sanitize.ts:158-159`.
- **Impacto**: la propuesta se acepta, se aplica el tope diario de cambios, y `updateConfig` la
  rechaza con un 403: decisión `FALLIDA` y un `AI_FAILED` en Telegram cada vez. Es ruido evitable
  con la información que ya está en la base, y el spec 051 nació justamente de ruido evitable.
- **Reproducción / test**: `supervisor.service.spec.ts` › «con el notional al límite, subir
  apalancamiento no se propone».
- **Propuesta**: `RiskService.topeDeApalancamiento(userId, inversión, market, excludeBotId)` que
  devuelve el menor de los topes, y el supervisor lo pasa como `maxLeverageUsuario`. Así lo respetan
  a la vez la propuesta y la lista de efectos, sin duplicar la regla.
- **Decisión**: corregir en este spec.

### F-10 — `failures` no vuelve a cero nunca: cinco fallos sueltos pausan el bot

- **Síntoma**: el comentario dice «a los cinco **seguidos** se duerme seis horas», pero el contador
  solo se reinicia al apagar el Modo IA (`supervisor.policy.service.ts:161`). Cinco fallos sueltos
  repartidos en semanas —cinco cortes de OpenRouter— pausan el bot seis horas y mandan «el
  supervisor falla repetidamente».
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:647,679`;
  `apps/api/src/modules/supervisor/supervisor.policy.service.ts:161`.
- **Impacto**: aviso falso y seis horas sin vigilancia por un motivo que no existe.
- **Reproducción / test**: `supervisor.service.spec.ts` › «una revisión con respuesta pone los
  fallos a cero».
- **Propuesta**: al marcar una revisión con respuesta válida, `failures: 0` y `last_error: null`.
- **Decisión**: corregir en este spec.

### F-11 — Un campo apagado con un cero se enciende solo al trasladar

- **Síntoma**: `orderMaxAgeSeconds: 0` significa «las órdenes no caducan por edad»
  (`market-maker-v2.ts:374-386`, mínimo 0; `strategies.spec.ts:2686`). La cadencia lo mueve
  (`build.ts:546`), y el traslado aditivo lo lleva de 0 a 75: una función que el dueño apagó se
  enciende sola.
- **Evidencia**: `apps/api/src/modules/supervisor/apply.ts:253-262`;
  `packages/strategy-core/src/strategies/market-maker-v2.ts:374-386`.
- **Impacto**: cambia la conducta del bot en algo que su dueño desactivó a propósito; en un market
  maker, caducar órdenes cuesta comisiones y sitio en la cola.
- **Reproducción / test**: `apply.spec.ts` › «un cero no se enciende».
- **Propuesta**: la cota relativa de F-02 lo resuelve por construcción —el 25 % de cero es cero— y
  se documenta como regla: de cero no se sale por traslado.
- **Decisión**: corregir en este spec, con F-02.

### F-12 — Un market maker de una capa convierte en WARM un cambio que era HOT

- **Síntoma**: la perilla `diferencial` mueve `layerDistanceMultiplier` (`build.ts:503`), que es
  WARM. Con una sola capa ese campo **no hace nada** —no hay segunda capa que separar—, pero al
  moverlo el `diffConfig` entero pasa a WARM: pide permiso de recolocación, consume enfriamiento
  WARM y cancela y vuelve a tender las órdenes.
- **Evidencia**: `apps/api/src/modules/advisor/build.ts:503`;
  `packages/strategy-core/src/strategies/market-maker.ts:374-386` (mutabilidad WARM).
- **Impacto**: comisiones y pérdida de cola por un campo inerte; y con `allow_warm: false`, el
  cambio de diferencial —lo que más importa a un market maker— se descarta entero como `RESHAPE`.
- **Reproducción / test**: `apply.spec.ts` › «con una capa, el diferencial no arrastra la separación
  de capas».
- **Propuesta**: no trasladar `layerDistanceMultiplier` ni `layerSizeMultiplier` cuando
  `layers ≤ 1`.
- **Decisión**: corregir en este spec.

### F-13 — El turno del aviso se pierde si falla una escritura posterior

- **Síntoma**: el turno se devuelve si falla el `create` de la fila, pero después hay un `updateMany`
  (retirar las propuestas anteriores) sin protección: si falla, la excepción sube, el aviso no se
  manda, y la clave `ai:advice:<bot>` se queda puesta veinticuatro horas.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:482-494`.
- **Impacto**: un día entero sin poder avisar por un fallo de escritura que no tenía nada que ver.
- **Reproducción / test**: `supervisor.service.spec.ts` › «si falla retirar la anterior, el aviso se
  manda igual».
- **Propuesta**: retirar las anteriores es accesorio: `.catch()` con log, nunca aborta el aviso.
- **Decisión**: corregir en este spec.

### F-14 — La huella cambia cuando el latente cruza el cero

- **Síntoma**: el tramo del resultado latente tiene un corte **en 0** (`[-10,-5,-2,0,2,5]`). El
  latente de un market maker oscila alrededor de cero todo el rato: +0,1 % y −0,1 % caen en tramos
  distintos y producen huellas distintas.
- **Evidencia**: `apps/api/src/modules/supervisor/dossier.ts:411`.
- **Impacto**: la barrera que más ahorra se rompe justo en los bots que más revisiones tienen: cada
  cruce del cero es una llamada pagada sin información nueva.
- **Reproducción / test**: `dossier.spec.ts` › «el latente que cruza el cero no cambia la huella».
- **Propuesta**: banda muerta alrededor de cero: cortes `[-10,-5,-2,2,5]`.
- **Decisión**: corregir en este spec.

### F-15 — Cada aviso se paga con una llamada de más

- **Síntoma**: la huella lleva `aviso:0|1`. Mandar un aviso cambia la huella, así que la siguiente
  revisión —con todo lo demás igual— ya no coincide y gasta una llamada; al caducar el aviso, otra.
- **Evidencia**: `apps/api/src/modules/supervisor/dossier.ts:421`.
- **Impacto**: dos llamadas pagadas por aviso y por bot, provocadas por el propio supervisor. Es la
  misma familia que el 051/H-02: el supervisor reaccionando a su propio rastro.
- **Reproducción / test**: `dossier.spec.ts` › «haber avisado no cambia la huella».
- **Propuesta**: fuera de la huella. La línea sigue en el prompt —el modelo tiene que saber que ya
  se avisó—, pero no dispara una llamada.
- **Decisión**: corregir en este spec.

### F-16 — Sin estado reciente el expediente dice «sin posición» y la guarda decide lo contrario

- **Síntoma**: sin snapshot fresco, el expediente pone `posicionAbierta: false` («el expediente
  cuenta hechos») mientras `posicionDe` asume posición abierta si hay inventario. El modelo lee «sin
  posición abierta» y a la vez ve todos los movimientos bloqueados por `RIESGO`.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:1142` y `1210`.
- **Impacto**: el expediente se contradice y el modelo no puede entender por qué no puede mover
  nada; con la lista de efectos delante, es el camino directo a un `AVISAR`.
- **Reproducción / test**: `dossier.spec.ts` › «sin estado reciente se dice, y se dice que se decide
  como si hubiera posición».
- **Propuesta**: el expediente lleva si el estado es fresco y lo dice explícitamente.
- **Decisión**: corregir en este spec.

### F-17 — Una propuesta que nadie aprobó se vuelve a proponer igual, y otra vez a Telegram

- **Síntoma**: el historial pide `APLICADA`, `PROPUESTA` y `RECHAZADA`. Una propuesta que caduca sin
  respuesta pasa a `CADUCADA` (`supervisor.scheduler.ts:139`) y desaparece del expediente, así que
  el modelo no sabe que ya la hizo y la repite en cuanto la huella cambie. Cada repetición es otro
  mensaje de Telegram.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:1057-1067`;
  `apps/api/src/modules/supervisor/supervisor.scheduler.ts:139`.
- **Impacto**: en modo manual —el del market maker V2 de LIT— es ruido repetido sobre una decisión que su dueño
  ya ignoró una vez.
- **Reproducción / test**: `supervisor.service.spec.ts` › «una caducada aparece en el historial».
- **Propuesta**: incluir `CADUCADA` con `discard_reason = 'PLAZO'` en el historial, rotulada «nadie
  la aprobó a tiempo», y decírselo al modelo en el prompt.
- **Decisión**: corregir en este spec.

### F-18 — Se presentan como incidencias eventos que ninguna perilla arregla

- **Síntoma**: `incidencias()` excluye `AI_*`, `CONFIG_*`, `COMMAND_*`, `BOT_*`, `VENUE_*` y
  `STREAM_*`, pero deja pasar `TICK_SLOW` (el tick tardó más que su intervalo, casi siempre por el
  cupo del venue), `LEVERAGE_SKIPPED` y `POSITION_MODE_SKIPPED` (el venue no aceptó el ajuste, con
  posición abierta o porque no lo soporta). Los tres son WARN.
- **Evidencia**: `apps/api/src/modules/supervisor/dossier.ts:250-258`;
  `apps/worker/src/engine/bot-runner.ts:949,2557`.
- **Impacto**: el modelo ve una avería donde hay una limitación del venue y ninguna perilla la
  arregla; con la lista de efectos delante, el final es un `AVISAR`. Es la doctrina del spec 050
  aplicada a medias.
- **Reproducción / test**: `dossier.spec.ts` › «ni el tick lento ni el apalancamiento no aplicado
  son incidencias».
- **Propuesta**: añadirlos a la lista de exclusión. `FAIR_PRICE_*` se queda: ahí sí tiene que actuar
  una persona (cambiar la fuente de precio), y para eso está `AVISAR`.
- **Decisión**: corregir en este spec.

### F-19 — La huella se guarda antes de que exista la fila de la decisión

- **Síntoma**: `marcarRevisado` guarda la huella justo después de parsear la respuesta, y la fila de
  la decisión se crea después. Si el `create` falla, la huella ya está guardada y la misma situación
  no se vuelve a preguntar.
- **Evidencia**: `apps/api/src/modules/supervisor/supervisor.service.ts:308` y `415`.
- **Impacto**: acotado: hace falta un fallo de escritura en la base, y entonces hay problemas
  mayores. Lo que se pierde es una respuesta ya pagada.
- **Reproducción / test**: cubierto por el test de F-13.
- **Propuesta**: mínima: el `create` de la decisión ya devuelve el turno del aviso; se documenta que
  la huella es una barrera de coste y no un registro, y se deja.
- **Decisión**: se deja como está, documentado. Mover la escritura detrás de `aplicarDecision`
  obligaría a arrastrar la huella por tres funciones para cubrir un caso que solo ocurre con la base
  caída.

### F-20 — Las perillas avanzan aunque la mitad del movimiento no tuviera efecto (descartado)

Es una decisión tomada y documentada en el plan del spec 051: si el modelo mueve dos perillas y solo
una tiene efecto, las dos avanzan. Saber cuál tuvo efecto exige probar cada perilla por separado
después de aplicar, y la lista de efectos ya hace raro el caso. Se mantiene.

### F-21 — El enfriamiento WARM cuenta también los cambios que aprobó una persona (descartado)

`warmPermitido` mira las decisiones `APLICADA` con `apply_level = 'WARM'`, incluidas las que aprobó
una persona desde Telegram. Es lo correcto: lo que el enfriamiento protege es el **coste** de
recolocar la escalera —comisiones y sitio en la cola—, y ese coste es el mismo lo apruebe quien lo
apruebe. Lo que no puede hacer es frenar a la persona, y no lo hace: `rehacer` no lo consulta.

## Verificado OK

Lo que se revisó a fondo y está bien, para no volver a mirarlo:

- **La cadena de `decidirCambio`**: el orden de los pasos (perillas → generación → traslado →
  acoplamientos → fusión → topes → guarda → validate → preview → diff) no tiene ningún hueco por el
  que un campo COLD o intocable pueda colarse. La doble fusión es deliberada y está justificada.
- **`conStopQueSoloSeEstrecha`** y **`conTopeDeApalancamiento`**: correctos, incluidos los casos con
  `stopLossPct` ausente y con tope de usuario nulo.
- **El estrangulador de avisos**: `setnx` con TTL, turno devuelto si falla el `create`, y con Redis
  caído no se avisa. La decisión se guarda siempre.
- **El orden de las cuotas** (bot antes que global) y su negativa con Redis caído.
- **`realizado24h`**: se acusó de comparar contra un snapshot de «más de 24 h» en vez de exactamente
  24 h. Es correcto: se pide el más reciente **anterior** al corte (`lte: desde`, `orderBy desc`),
  que es la mejor aproximación disponible.
- **El bloqueo de `sizeGrowth` en la V1**: se acusó de silencioso. No lo es: la V1 no declara
  `layerSizeMultiplier` entre los campos que mueve esa perilla, y la lista de efectos lo dice.
- **Que el perfil no se desplace**, y con él la estabilidad de `limitAction`: verificado campo a
  campo, sigue en pie.
- **El expediente no lleva importes, nombres ni identificadores**: los tests del 051 lo comprueban y
  siguen valiendo con los cambios de este spec.

## Preguntas abiertas

Ninguna. El usuario decidió el 2026-09-16 corregir los veintiún hallazgos en este spec, mergear a
`main` con push, redesplegar producción y portar al fork OSS con commit local.

## Specs de seguimiento propuestos

Ninguno: todo lo confirmado se corrige aquí.
