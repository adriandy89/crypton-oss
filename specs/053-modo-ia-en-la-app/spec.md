# 053 — La lista de bots alineada y el Modo IA en la app

Estado: `hecho` (faltan CA-2 y CA-10 manuales) · Tipo: `cambio` · Rama: `spec/053-modo-ia-en-la-app`

## Objetivo

Que un administrador vea y gobierne el Modo IA desde donde vive el bot: la lista, el detalle y el
asistente de creación. Y que las tarjetas de la lista de bots casen en altura y en pie cuando
comparten fila. Se sabrá que está hecho cuando los criterios de abajo pasen, con los tests de la
API en verde, las mutaciones de las salvaguardas nuevas cazadas y el arnés del CSS midiendo lo que
se ve.

## Contexto

Petición directa del usuario del 2026-09-16, con una captura de la lista de bots en pantalla ancha
—tres market makers simulados en Modo IA— y la consigna «MUCHO CUIDADO»:

1. En la misma fila, una tarjeta con barra de liquidación mide más que su vecina, y los recuadros
   de nota quedan a alturas distintas. La causa es `align-items: start` en la rejilla de dos
   columnas (`bots-list.page.scss`, desde el primer diseño de pantallas grandes, sin incidente
   detrás). Las notas de un market maker ocupan una o dos líneas, así que empujar el pie abajo no
   basta para que casen arriba y abajo: hace falta `subgrid`.
2. El Modo IA (spec 046, revisado en el 047, el 051 y el 052) solo se ve en la consola de
   administración, en la ficha de un bot propio, y solo deja cambiar el modo. En la lista de bots no
   hay forma de saber qué bots vigila, ni con qué modo; y el disparador, el intervalo y el permiso de
   recolocar órdenes, que la API acepta desde el 046, no tienen mando (el 051 lo dejó aplazado).
3. Se pide también poder encenderlo al crear el bot.

Decisiones del usuario, preguntadas antes de planificar:

- El panel va **arriba de la pestaña Ajustes** del bot; la pastilla también en la cabecera del
  Resumen.
- La pastilla dice **`IA · PROPONE`** o **`IA · APLICA`**, y sale **en gris con contorno** cuando
  la IA no está actuando de verdad.
- El panel cambia **el modo y las opciones avanzadas**.
- Entran además: los nombres de los eventos `AI_*` y la marca «IA» en el historial, la pastilla en
  la consola de administración, y **los dos defectos del supervisor** encontrados al explorar
  (H-01 y H-02).

### Defectos que este spec corrige

- **H-01** (Media) — El spec 046, R-3, dice que activar o desactivar el Modo IA «deja un evento en
  el bot», y el comentario de `SetAiModeDto` lo repite. No se escribe ninguno: el cambio solo queda
  en la bitácora de actividad.
- **H-02** (Alta: red de seguridad documentada que es código muerto) — `SupervisorPolicyService`
  promete hacer cumplir en tres sitios que el Modo IA solo actúa sobre bots de un `ADMIN`. El
  barrido lo exige (`user: { role: ADMIN, disabled: false }`), pero la revisión que dispara un
  evento (`supervisor.scheduler.ts`, `onEvento`) no: un administrador degradado o una cuenta
  deshabilitada siguen recibiendo revisiones —y en `AUTO`, cambios— cada vez que su bot cierra un
  ciclo o salta una guarda.
- **H-04** (Baja) — `SetAiModeDto` usa `@IsOptional`, que deja pasar `null`. Un `trigger: null` o
  `allowWarm: null` llega a columnas `NOT NULL` y la API responde 500. `reviewEveryMinutes: null`
  sí funciona —vuelve al intervalo de la estrategia— pero nada lo declara.
- Del panel de la consola, al extraerlo: tokens CSS que no existen (`--line-1`, `--radius-2`), el
  estado «guardando» que se suelta antes de que termine el `PUT`, iconos sin registrar, «se
  reactiva el …» con fechas pasadas (`paused_until` no se limpia al recuperarse), un fallo de
  lectura pintado como «Apagado», y un texto fijo que ignora el disparador y el intervalo.

### Defectos que se reportan y NO se corrigen aquí

- **H-03** (Media) — Desvincular Telegram deja mudo un bot en `MANUAL`: el servidor solo exige el
  vínculo al encender el modo. Aquí solo se avisa en el panel.
- **H-05** (Media) — Un borrador de Ajustes guardado tarde reescribe la configuración entera y
  deshace en silencio lo que el supervisor aplicó entretanto: la app no manda `expectedVersion`.
  Aquí solo se avisa cuando la versión cambió mientras se editaba. El arreglo de fondo es de la API
  y de todos los usuarios, y pide spec propio.

## Alcance

- `apps/api/src/modules/admin/admin-ai.controller.ts`, `admin.module.ts` (comentario) y un test de
  rutas nuevo.
- `apps/api/src/modules/supervisor/`: `supervisor.policy.service.ts`, `supervisor.service.ts`,
  `supervisor.scheduler.ts`, `dtos/index.ts` y sus tests.
- `apps/api/test/isolation.e2e-spec.ts`: la superficie de administración.
- `apps/app`: la lista de bots, el detalle, el asistente de creación, la consola (ficha y lista),
  los servicios de administración, un servicio y dos componentes nuevos del Modo IA, y las
  etiquetas de eventos.
- `docs/administracion.md`, `docs/comandos-guardas-y-eventos.md`, `docs/README.md` y
  `specs/README.md`.

## Fuera de alcance

- `packages/db/prisma`: no hace falta migración (`bot_events.type` es `VarChar(48)`).
- `packages/shared`, `strategy-core`, `exchange-core` y el worker.
- La conducta de ningún bot, salvo H-02. Los valores por defecto del Modo IA no cambian.
- La cola de decisiones en la app, aplazada desde el 046.
- Sembrar las perillas desde la recomendación del asesor al crear: la recomendación no las trae y
  el servidor siembra `EQUILIBRADA`, como hoy.
- `daily_call_limit`, que la API no expone.
- El arreglo de fondo de H-03 y H-05.
- Consultar el Modo IA de bots ajenos: la consola sigue sin poder leerlo (spec 033).
- Despliegue, `push` y fork OSS, salvo que el usuario lo pida.

## Requisitos

### Tarjetas

- **R-1** Desde 900 px, las dos tarjetas de una fila miden lo mismo, y el recuadro de pie de las
  dos empieza y termina a la misma altura aunque sus textos ocupen distinto número de líneas. Una
  fila sin notas no gana espacio y por debajo de 900 px nada cambia. Sin `subgrid`, al menos las
  alturas y el borde inferior casan.

### API

- **R-2** `GET /admin/ai` (solo `ADMIN`) devuelve los interruptores efectivos del servidor
  (`encendido`, `forzarManual`, `soloSimulados`), las estrategias que cubre el Modo IA y el Modo IA
  de los bots **propios** que lo tienen encendido, sin perillas, rasgos ni huella.
- **R-3** `GET /admin/bots/:id/ai` añade `cubierta` e `interruptores`; `PUT` añade `cubierta`. Las
  dos rutas conservan su URL.
- **R-4** (H-01) Cambiar el modo escribe un evento `AI_MODE` en el bot, con el modo y el motivo, y
  lo publica sin entrega forzada: refresca la app y no llega a Telegram.
- **R-5** (H-02) La revisión por evento exige, como el barrido, que el dueño sea `ADMIN` y no esté
  deshabilitado.
- **R-6** (H-04) `trigger` y `allowWarm` a `null` son un 400. `reviewEveryMinutes: null` es «el
  intervalo de la estrategia».

### App

- **R-7** Solo un `ADMIN` ve la pastilla, el panel y la sección del asistente, y solo para él se
  pide `/admin/ai`.
- **R-8** La pastilla dice el modo configurado y sale en gris con contorno —con el motivo— cuando
  el interruptor global está apagado, cuando el servidor solo deja actuar sobre simulados y el bot
  es real, cuando está dormida por fallos, cuando el bot no está en marcha o cuando el servidor
  fuerza el modo manual sobre uno automático.
- **R-9** El panel del bot cambia modo, disparador, intervalo y permiso de recolocar, con motivo
  obligatorio y confirmación. En `AUTO` sobre un bot real, la confirmación dice que es dinero real.
  El `PUT` lleva el modo y solo lo que cambió.
- **R-10** El panel dice la verdad: un fallo de lectura no se pinta como «Apagado», el sueño por
  fallos solo se anuncia si no ha vencido, `MANUAL` sin Telegram se avisa, y la frase de cuándo
  revisa sale de la configuración real.
- **R-11** El asistente de creación permite elegir el Modo IA en su último paso. Si el `PUT`
  posterior falla, el bot queda creado y se avisa; nunca se deshace la creación.
- **R-12** La pestaña Eventos nombra los `AI_*`, y el historial de configuración marca con «IA»
  los cambios que aplicó el supervisor.
- **R-13** La consola marca con la pastilla los bots propios, y dice que el Modo IA de otros
  administradores no se puede consultar desde ahí.
- **R-14** (H-05, solo aviso) En Ajustes, si la configuración cambió mientras había un borrador sin
  guardar, se avisa antes de guardar.

## Criterios de aceptación

- **CA-1** El arnés del CSS mide, a 1100 px, altos iguales por fila y bordes superior e inferior de
  los pies iguales con notas de una y dos líneas, sin espacio de más en una fila sin notas, y la
  separación de siempre entre filas. A 390 px no cambia nada (R-1).
- **CA-2** Con una cuenta `USER` no hay pastilla, panel ni sección, y la app no llama a
  `/admin/ai` (R-7). Comprobación manual.
- **CA-3** Un test comprueba que `encendidosDe` filtra por el dueño y por los modos encendidos y
  que no selecciona `knobs`, `features_at_enable` ni `last_bucket`; el e2e, que la administradora
  no ve el Modo IA de un bot ajeno (R-2).
- **CA-4** Un test de rutas monta los dos controladores de `admin/bots` y comprueba que
  `GET /admin/ai` llega a su manejador y no al detalle, que las rutas del Modo IA siguen donde
  estaban, que un `PUT` sin motivo es 400 y que un `USER` recibe 403 sin consultar nada (R-2, R-3).
- **CA-5** Un test comprueba que `set` escribe y publica `AI_MODE` con el motivo, sin
  `entregaForzada`, y que si el evento falla el cambio de modo no falla (R-4).
- **CA-6** Un test comprueba que la consulta de `onEvento` exige dueño `ADMIN` habilitado, y
  **falla antes del arreglo** (R-5).
- **CA-7** Un test de validación comprueba que `null` en `trigger` o `allowWarm` no pasa y en
  `reviewEveryMinutes` sí, y otro que `null` se escribe como `null` (R-6).
- **CA-8** Un test comprueba que `interruptores()` refleja las variables y la clave, y que dice lo
  mismo que hace `revisarBot` (R-2, R-8).
- **CA-9** API y app compilan (`nest build`, `ng build` con presupuestos), pasan el lint y los
  tests; `check:env` es coherente; cada mutación de las salvaguardas nuevas tumba un test.
- **CA-10** Comprobación manual del usuario con la infraestructura levantada y una cuenta `ADMIN`:
  un bot simulado de market maker pasa por los tres modos y cambia de opciones desde Ajustes, con
  motivo; la pastilla cambia en la lista sin recargar; «Modo IA cambiado» aparece en Eventos; se
  crea un bot con Modo IA; y la consola muestra la pastilla y su leyenda (R-8 a R-14).

## Riesgos

- **Bots en marcha.** Ningún cambio toca la decisión del supervisor ni la configuración de un bot.
  H-02 solo quita revisiones a bots cuyo dueño ya no es administrador, que es lo que el spec 046
  prometía.
- **Mover el prefijo del controlador** podría cambiar URLs: un test de rutas lo impide.
- **`subgrid`** depende de cómo el navegador reparte el margen de la tarjeta; el arnés lo mide y
  hay una variante preparada. Sin soporte, el `@supports` deja el respaldo.
- **Presupuestos de estilos.** Las hojas del detalle y del asistente están a 2 bytes del aviso: no
  reciben CSS; los componentes nuevos llevan el suyo.
- **App y API se despliegan por separado.** La app nueva frente a una API vieja no pinta pastillas
  (la ruta nueva no existe) y trata `cubierta` ausente como desconocida.
- **Encender `AUTO` sobre dinero real** queda a dos toques y un motivo: la confirmación lo dice.

## Referencias oficiales

No aplica: no se toca ningún venue ni SDK. La especificación de `subgrid` (CSS Grid Level 2, §9)
se contrasta con el arnés en lugar de citarse.
