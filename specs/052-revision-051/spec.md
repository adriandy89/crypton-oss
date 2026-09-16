# 052 — Revisión del spec 051

Estado: `en curso` · Tipo: `revisión` · Rama: `spec/052-revision-051`

## Objetivo

Revisar entero el spec 051 —el supervisor que solo avisaba— contra el código que quedó en `main`
(`060cf9c`), anotar cada defecto con evidencia y corregirlos todos antes de volver a desplegar.
Se sabrá que está hecho cuando cada hallazgo de `findings.md` tenga su test, la batería de la API
siga en verde y una mutación por salvaguarda nueva tumbe su test.

## Contexto

El spec 051 se escribió y se desplegó en una sola tarde, con tres bots simulados en producción
mandando un aviso cada media hora. Pasó sus 5625 tests, 29 de 29 mutaciones y un despliegue
limpio, y aun así una revisión posterior encontró **veintiún defectos reales**, seis de ellos
Altos. No es una sorpresa: es el patrón del spec 047 y del 041 —los tests verdes no cazan lo que
nadie pensó en probar— y por eso la casa revisa lo que acaba de escribir.

Los seis Altos tienen un aire de familia: el 051 cambió la traducción de «copiar lo que genera el
asesor» a «trasladar el delta», y el traslado **no tiene cota**. Un delta calculado sobre la
configuración que el generador produciría se aplica tal cual a la que el bot tiene, que puede ser
diez veces menor. Sobre bots ajustados a mano —los que el 051 vino a proteger— eso vuelve a
producir lo que el 051 quería impedir: distancias aplastadas al mínimo, tamaños multiplicados y
topes por debajo de la exposición.

Los tres bots en Modo IA de producción son **simulados**, así que hoy ningún defecto de esta lista
cuesta dinero. El código, en cambio, no distingue: en cuanto `AI_AGENT_DRY_RUN_ONLY` pase a `false`
y un bot real encienda el modo, todos se vuelven reales. La severidad de `findings.md` es la del
código, no la de los tres bots de hoy.

## Alcance

- `apps/api/src/modules/supervisor/*` (traducción, expediente, prompt y servicio) y sus tests.
- `apps/api/src/modules/bots/bots.service.ts`: una opción nueva en `updateConfig` para que quien
  escribe pueda exigir la versión de configuración que leyó (F-06). No cambia nada para quien no la
  pase.
- `apps/api/src/modules/risk/risk.service.ts`: exponer el tope de apalancamiento que ya calcula
  `assertWithinLimits`, para poder respetarlo antes de proponer (F-09).
- `docs/administracion.md` y `specs/README.md`.

## Fuera de alcance

- `packages/db/prisma`: ninguna corrección necesita columna nueva. Los motivos de descarte nuevos
  caben en el `VARCHAR(24)` que ya existe.
- El worker, `strategy-core`, `shared` y `exchange-core`: los defectos son todos de la API.
- La cola de decisiones en la app, aplazada desde el 046.
- Los valores por defecto de las estrategias y la semántica de sus parámetros (principio 6).

## Requisitos

- **R-1** Ningún traslado mueve un campo más de un **25 % de su valor vivo por escalón** pedido.
  Los dos escalones de `MUCHO_MAS` son un 50 %.
- **R-2** Un campo que el dueño dejó en **cero no se enciende** por traslado: el cero es una
  decisión, no un punto de partida.
- **R-3** Los importes se redondean con los **decimales del campo efectivo**, no con dos: en modo
  «cantidad de moneda» dos decimales destruyen la cantidad.
- **R-4** Con posición abierta no se toca **el stop que la estrategia usa de verdad**, sea cual sea
  su nombre.
- **R-5** El tope de un market maker que cierra al tocarlo solo baja con una medida de exposición
  **fresca**.
- **R-6** Un cambio automático no pisa una edición del dueño: se aplica **solo sobre la versión de
  configuración que se leyó**.
- **R-7** El enfriamiento WARM frena lo que se aplica solo, no lo que se le propone a una persona.
- **R-8** La lista de efectos dice la verdad sobre los **dos** escalones, y no promete lo que los
  límites de riesgo del usuario van a rechazar.
- **R-9** Los fallos consecutivos se cuentan como tales: un acierto los pone a cero.
- **R-10** La huella no cambia por nada que haya hecho el propio supervisor, ni por el signo de un
  número que vale casi cero.
- **R-11** El expediente no presenta como incidencia lo que ninguna perilla arregla, y dice cuándo
  no sabe si hay posición.
- **R-12** Una propuesta que caducó sin respuesta llega al modelo como lo que fue.

## Criterios de aceptación

- **CA-1** Un market maker con 6 bps de distancia y un generador que pide bajar a 1 no baja de 4,5
  bps con un escalón (test `apply.spec.ts`).
- **CA-2** Un bot con `orderMaxAgeSeconds: 0` sigue en 0 tras cualquier movimiento de cadencia.
- **CA-3** Un market maker en modo BASE con `orderSizePerSide: 0.01` y `minQty` 0,00001 conserva
  cinco decimales al trasladar; nunca acaba en el mínimo del venue.
- **CA-4** `TREND_FOLLOW` con posición abierta y `diferencial MENOS` → `CIERRE` (hoy pasa y
  estrecha el stop de ATR).
- **CA-5** Un market maker `CLOSE_ALL` con posición y un estado de hace más de dos minutos no puede
  bajar su tope: `CIERRE`.
- **CA-6** Si la versión de configuración cambia entre la lectura y la escritura, la decisión queda
  `CADUCADA`/`STALE`, no `FALLIDA`, y no hay `AI_FAILED` en Telegram.
- **CA-7** Un bot en modo MANUAL recibe propuestas WARM aunque el supervisor haya aplicado un WARM
  hace una hora; en AUTO no.
- **CA-8** Una perilla cuyo escalón no mueve nada pero cuyos dos escalones sí, sale como aplicable
  «con dos escalones» y el prompt lo dice.
- **CA-9** Con un límite de notional por bot que impide subir el apalancamiento, `leverage MAS` no
  sale como aplicable y no se propone.
- **CA-10** Una revisión con respuesta válida pone `failures` a cero.
- **CA-11** Dos expedientes que solo difieren en que se avisó, o en que el latente pasó de +0,1 % a
  −0,1 %, dan la **misma** huella.
- **CA-12** `TICK_SLOW`, `LEVERAGE_SKIPPED` y `POSITION_MODE_SKIPPED` no aparecen entre las
  incidencias.
- **CA-13** Sin estado reciente, el expediente lo dice y el modelo lee que se decide como si
  hubiera posición.
- **CA-14** Una propuesta caducada aparece en el historial como caducada sin respuesta.
- **CA-15** Batería completa de la API en verde, `pnpm lint` sin errores, `pnpm check:env`
  coherente, y una mutación por salvaguarda nueva que tumba su test.

## Riesgos

- **El tope relativo puede dejar quieto lo que antes se movía.** Un bot cuyo valor vivo está muy
  lejos del generado tarda ahora varias revisiones en llegar, en vez de saltar de una vez. Es la
  conducta buscada —eso es lo que significa «ajuste relativo»— pero cambia lo que el modelo ve como
  aplicable, así que la lista de efectos y el prompt tienen que contarlo.
- **`updateConfig` es el camino de escritura de todos.** La opción nueva es opcional y no cambia
  nada para quien no la pasa; aun así se prueba que sin ella se comporta exactamente igual.
- **Bots en marcha**: ninguna corrección cambia valores por defecto ni semántica de parámetros. Lo
  que cambia es lo que el supervisor puede hacer con ellos, siempre hacia menos.

## Referencias oficiales

Ninguna: todos los hallazgos son de lógica propia, sin reglas de venue ni de SDK por medio.
