# 056 — Hallazgos

Revisión de los specs 053, 054 y 055 antes de pasarlos a `main` y al fork. La severidad sigue la
escala de `specs/README.md`.

Rango revisado: `978f2f1..4c6b8a4` (`main` → la punta del 055 antes de la revisión) · Fecha:
2026-09-16 · Versiones: node 24.12.0, pnpm 10.28.1 · Hosts sondeados: ninguno (no hay ninguna regla
de venue por medio).

## Quién y cómo

Dos revisores independientes, en solo lectura y sobre lo commiteado (`git show`, `git diff`). No
ejecutaron nada.

- **Backend** (API, worker y `shared`): defectos de corrección, fugas por el filtro de excepciones,
  efectos sobre el dinero, el notificador y la coherencia entre código, comentarios y tests. Además
  revisaron todos los `throw` que llevan campos del contrato con la app.
- **App**: recorrieron a mano los escenarios del borrador de Ajustes:
  - primera carga;
  - eventos con y sin cambio de versión;
  - guardar y `applied: false`;
  - los dos 409 y el error de red;
  - descartar;
  - eventos durante un guardado.

## Por qué ninguno es Crítico

La escala exige una de cinco cosas:

- una posición sin su stop;
- exposición u órdenes duplicadas;
- la caída del worker;
- firmar contra la red equivocada;
- el rechazo sistemático de toda orden.

Nada de lo revisado firma, coloca o cancela. El supervisor escribe por `BotsService.updateConfig`,
la app guarda por la misma ruta que cualquier usuario y el notificador solo manda texto.

El más grave es **A-1**, un Alto. Guardar Ajustes podía deshacer un ajuste del Modo IA, lo que
cambia el riesgo de un bot sin que su dueño lo sepa, pero no es ninguna de las cinco.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| R-1 | Los bots que una barrera salta acaparan el barrido | supervisor | Media | corregido en 056 | `supervisor.service.ts:321-324`; `supervisor.policy.service.ts:356-376`; `supervisor.scheduler.ts:119-124` | M |
| R-2 | La app nueva contra una API anterior no puede guardar Ajustes | despliegue | Media | corregido en 056 (orden de despliegue) | `api/src/main.ts:92-96`; `bots/dtos/index.ts:111-114` | S |
| R-3 | Dos guardados simultáneos dan un 500 de Prisma, y su mensaje llega a Telegram | API | Baja | corregido en 056 | `bots.service.ts:1118-1152`; `supervisor.service.ts:661-688` | S |
| R-4 | Aprobar desde Telegram no exige un dueño administrador | supervisor | Baja | corregido en 056 | `supervisor.service.ts:853-985` | S |
| R-5 | El notificador puede perder o desordenar trozos de un lote | worker | Baja (sospecha) | corregido en 056 | `notifier.service.ts:347-349`; `telegram-client.ts:55-72` | S |
| R-6 | La exigencia de canal al encender tiene dos huecos | supervisor | Baja | (a) descartado · (b) corregido en 056 | `supervisor.policy.service.ts:190-193` | S |
| R-7 | El motivo del modelo puede dejar medio emoji | supervisor | Baja (sospecha) | corregido en 056 | `decision.ts:156` | S |
| R-8 | El comentario del filtro de excepciones quedó descolgado | API | Baja | corregido en 056 | `exception.filter.ts:14-59` | S |
| A-1 | La pantalla y el servidor deciden distinto qué está editado | app / `shared` | Alta | corregido en 056 | `shared/borrador.ts:42-47`; `strategy-core/mutability.ts:31-44`; `ui-field.component.ts:403-417` | M |
| A-2 | El aviso de la recolocación no se ve al guardar ni dice qué choca | app | Media | corregido en 056 | `bot-detail.page.html:799-806`; `bot-detail.page.scss:170-172`; `bot-detail.page.ts:824-827` | M |
| A-3 | = R-2, visto desde la app | app | Media | corregido en 056 (orden de despliegue) | `app/core/services/bots.service.ts:206-212` | S |
| A-4 | Tras tocar Telegram, lo que la pantalla dice del canal se queda viejo | app | Media | corregido en 056 | `telegram.page.ts:175-205`; `modo-ia.ts:200`; `modo-ia-panel.component.ts:252` | M |
| A-5 | El borrador del panel del Modo IA repite H-05 | app | Media | corregido en 056 | `modo-ia-panel.component.ts:222-226,257` | S |
| A-6 | Una lectura vieja del detalle se aplica igual | app | Media | corregido en 056 | `bot-detail.page.ts:630-643` | S |
| A-7 | El aviso de la recolocación puede quedar viejo o engañar | app | Baja | corregido en 056 | `bot-detail.page.ts:760-772` | S |
| A-8 | Un guardado correcto no mira si el borrador cambió mientras tanto | app | Baja | corregido en 056 | `bot-detail.page.ts:797-808`; `bot-detail.page.html:804,810` | S |
| A-9 | `guardarIa` no limpia `iaError` | app | Baja | corregido en 056 | `bot-detail.page.ts:606-610`; `admin/bot-detail.page.ts:337-341` | S |
| A-10 | Cuatro diferencias entre el panel y el servidor | app | Baja | (a), (b) y (d) corregidos en 056 · (c) descartado | `modo-ia-panel.component.ts:243`; `modo-ia-editor.component.ts:456-479` | S |
| A-11 | Accesibilidad del Modo IA | app | Baja | corregido en 056 | `modo-ia.ts:236-244`; `modo-ia-editor.component.ts:88-147` | S |
| A-12 | Textos y comentarios | app | Baja | corregido en 056 | `admin-bots.service.ts:75-82`; `bot-detail.page.ts:516-521`; `modo-ia.ts` (`LIMITES_IA`); `telegram.page.ts:186-190` | S |

Estados: `por confirmar` · `confirmado` · `corregido en NNN` · `seguimiento NNN` · `descartado`.

Las líneas son las de `4c6b8a4`.

**Por qué se corrigen aquí.** Ninguno de estos cambios está en `main`, así que los confirmados se
corrigen dentro de esta revisión, en la rama del 055. Es el razonamiento del 047 y del 052: mergear
algo que ya se sabe defectuoso para arreglarlo después es peor negocio. Cada arreglo lleva su test,
o su verificación si es de la app, que no tiene tests, y su mutación.

## Fichas

### R-1 — Los bots que una barrera salta acaparan el barrido

- **Síntoma.**
  - La barrera del canal del 055 sale por `saltar()` sin llamar a `marcarRevisado`, así que la
    última revisión no avanza.
  - `pendientesDeRevision` ordena por `last_review_at` (primero los nulos) y se queda con
    `AI_AGENT_SWEEP_MAX` filas, 5 por defecto.
  - Resultado: los bots saltados se quedan en cabeza para siempre.
- **Escenario.** Un administrador tiene cinco o más bots en «propone y espera» y apaga los avisos
  del Modo IA (o pide un código nuevo). Desde entonces:
  - cada barrido elige esos cinco, los salta y no revisa ningún otro;
  - eso incluye sus bots en automático y los de otros administradores que sí tienen canal;
  - la pastilla de los automáticos sigue en color, así que el fallo es silencioso.
- **Ya pasaba antes con otra causa.** Con `AI_AGENT_DRY_RUN_ONLY=true`, que es el valor de fábrica,
  un bot real con el modo encendido tampoco rota.
- **Impacto.** El supervisor deja de revisar bots que sí debería revisar, sin ningún aviso.
- **Arreglo** (`2c1cdf4`). La cola solo recibe lo que se va a revisar:
  - con «solo simulados», los reales quedan fuera en la consulta;
  - los que proponen sin canal se quitan en código y **antes** del tope. Se lee hasta 200 políticas,
    porque la población son bots de administradores: decenas.
  - Por qué en código: en la consulta, `prefs` es JSON y una clave ausente compara como NULL, así
    que un filtro sobre ella dejaría fuera a quien tiene las preferencias de antes del Modo IA.
  - El barrido pasa los interruptores del servidor.
- **Tests.**
  - `supervisor.policy.spec.ts` › «lo que se saltaria no entra en la cola»: cuatro casos.
  - `supervisor.scheduler.spec.ts` › «El barrido pide solo lo que se va a revisar».

### R-2 / A-3 — La app nueva contra una API anterior no puede guardar Ajustes

- **Síntoma.** La app nueva manda siempre `expectedVersion`. La API valida con
  `forbidNonWhitelisted: true`, y una anterior al 055 responde 400 («property expectedVersion should
  not exist») a todo guardado de Ajustes.
- **Contradicción.** La tabla de riesgos del 055 decía que las dos combinaciones funcionaban. Es
  falso para esta.
- **Arreglo.**
  - Se despliega **primero la API** y después la app.
  - La tabla de riesgos del 055 está corregida.
  - El orden va en el informe de entrega.
  - No se añade un reintento sin el campo: sería volver a guardar sin la protección que el campo
    existe para dar.

### R-3 — Dos guardados simultáneos dan un 500 de Prisma, y su mensaje llega a Telegram

- **Síntoma.** La transacción de `updateConfig` insertaba primero la revisión, que tiene índice
  único por versión. Con dos escrituras sobre la misma versión, la segunda chocaba con ese índice
  antes de llegar al `updateMany` con guarda.
- **Impacto.**
  - **App:** un 500 genérico en vez del 409 que recoloca el borrador.
  - **Supervisor:** el error de Prisma no era `versionRancia`, así que la decisión quedaba `FALLIDA`
    y el `AI_FAILED` llevaba a Telegram el mensaje crudo de Prisma.
- **Arreglo** (`e672795`, `6df0fed`).
  - La fila del bot se escribe **antes** que la revisión, y siempre con la versión leída en el
    `where`. La segunda escritura espera al bloqueo, vuelve a evaluar el `where`, no escribe nada y
    responde `STALE_VERSION`.
  - Un error que no es HTTP se guarda entero en la decisión y en el log. A Telegram solo llega «un
    error interno al escribir la configuración».
- **Tests.**
  - `bots-reshape.spec.ts`: la versión en el `where`, el orden de las dos escrituras y el 409 sin
    `expectedVersion`.
  - `supervisor.service.spec.ts` › «un error que no es HTTP se guarda entero, pero a Telegram no
    llega».

### R-4 — Aprobar desde Telegram no exige un dueño administrador

- **Síntoma.** `canjearVale` no comprobaba `DUENO_CON_MODO_IA`, aunque el barrido y la revisión por
  evento sí (053/H-02). Una cuenta a la que le quitan el rol, o que se deshabilita, podía aplicar
  una sugerencia pendiente durante su plazo (60 min).
- **Arreglo** (`6df0fed`). El canje lee el rol y el estado del dueño. Si ya no cumple, la sugerencia
  se descarta con `discard_reason: 'DUENO'`, sin aplicar nada.
- **Tests.** `supervisor.service.spec.ts`: el rol y la cuenta deshabilitada, y que la consulta los
  pida.

### R-5 — El notificador puede perder o desordenar trozos de un lote

- **Síntoma** (sospecha, no reproducida contra Telegram).
  - `trocear` producía varios mensajes seguidos, sin pausa. `sendMessage` no reintenta un 429.
  - Si un envío tardaba más que la ventana del lote (4 s), el lote siguiente podía colarse entre los
    trozos del anterior.
- **Arreglo** (`4499312`).
  - Los envíos van en fila por chat.
  - Entre dos trozos de un mismo lote hay 1,1 s de pausa: Telegram pide no pasar de un mensaje por
    segundo por chat.
- **Tests.** `notifier.service.spec.ts`: la pausa (y que un lote de un solo trozo no la lleve), y el
  orden con un envío lento.

### R-6 — La exigencia de canal al encender tiene dos huecos

- **(a) Automático forzado.**
  - Con `AI_AGENT_FORCE_MANUAL=true`, encender el automático sin canal se acepta, y el bot no se
    revisa.
  - **Descartado.** El forzado es un interruptor del servidor, temporal por naturaleza. Negar el
    automático mientras está puesto impediría configurar el modo que el bot tendrá cuando se quite.
  - La pastilla ya lo pinta en gris con el motivo, y desde R-1 ese bot no ocupa sitio en el barrido.
- **(b) Opciones bloqueadas.**
  - Un bot en «propone y espera» que ha perdido el canal no podía cambiar su disparador, su
    intervalo ni su permiso de recolocar: el guardado lleva siempre `mode=MANUAL` y recibía un 403.
  - **Corregido** (`2c1cdf4`). El canal se exige solo al **pasar** a manual.
  - La app sigue la misma regla: ver A-10.
- **Tests.** `supervisor.policy.spec.ts`: el bot que ya está en manual puede cambiar sus opciones,
  y pasar a manual desde automático sigue sin poder.

### R-7 — El motivo del modelo puede dejar medio emoji

- **Síntoma** (sospecha).
  - `motivo.slice(0, 240)` corta por unidades UTF-16. Un emoji justo en el límite deja un sustituto
    suelto.
  - Desde el 054 ese motivo viaja en los avisos de Telegram, y un texto que no es UTF-8 válido
    puede hacer que Telegram rechace el lote entero.
- **Arreglo** (`4499312`).
  - El recorte no parte pares.
  - El notificador cambia por «�» cualquier sustituto suelto de una línea, venga de donde venga.
- **Tests.**
  - `decision.spec.ts` › «el motivo se recorta sin partir un emoji».
  - `notifier.service.spec.ts` › «un sustituto suelto no llega a Telegram».

### R-8 — El comentario del filtro de excepciones quedó descolgado

El comentario de `CAMPOS_DEL_CONTRATO` se metió entre el de la clase y la clase. Ahora va encima de
la constante, y el de la clase vuelve con su clase (`dd4233e`).

### A-1 — La pantalla y el servidor deciden distinto qué está editado

- **Síntoma.** Las dos partes usaban reglas distintas:
  - `edicionesDe` (app) comparaba **texto**;
  - `diffConfig` (servidor) compara **números** (`sameValue`);
  - los botones − y + de un campo escriben `String(Number(v))`;
  - el generador guarda cadenas con ceros de relleno, como `"12.50"`.
- **Escenario.**
  1. El tamaño por lado vale `"12.50"`. El dueño pulsa − y + (queda `"12.5"`) y cambia otro campo.
  2. La IA sube el tamaño a 15.
  3. Al recolocar, la pantalla trata el 12.5 como editado y lo conserva encima del 15.
  4. Guardar lo aplica: se deshace el ajuste que la guía promete conservar.
- **Arreglo** (`252bd89`, `a899709`).
  - La igualdad del servidor pasa a `shared` como `mismoValorDeConfig`, y la usan `edicionesDe` y
    `diffConfig`. Una sola función.
  - Un test de `strategy-core` compara lo que decide cada uno sobre varios borradores.
  - Tras un guardado que el servidor da por vacío (`applied: false`), el borrador vuelve a lo
    guardado.
  - Vaciar un campo que ya estaba vacío no cuenta como edición. Sin esto, con la regla del servidor
    `''` frente a `null` es un cambio.
- **Tests.**
  - `borrador.spec.ts`: el escenario, y la igualdad (`"12.50"`/`"12.5"`, `20`/`"20.0"`,
    booleanos, vacíos y texto).
  - `strategies.spec.ts` › `diffConfig` › «decide lo mismo que la pantalla».

### A-2 — El aviso de la recolocación no se ve al guardar ni dice qué choca

- **Síntoma.**
  - El aviso estaba debajo del historial. La barra de guardar es fija, así que quien editaba arriba
    guardaba sin verlo.
  - No decía en qué campos la edición sustituía a lo que cambió debajo, y ese aviso es la única
    mitigación del «gana el dueño».
  - El diálogo WARM caía siempre en «Se recolocarán las órdenes», aunque el 409 trae `changed`.
- **Arreglo** (`a899709`).
  - El aviso va **dentro** de la barra fija (`.bd-save`, en `global.scss` por el presupuesto de la
    hoja de la página).
  - `recolocarBorrador` devuelve los `choques` y el aviso los nombra mientras sigan editados.
  - `parseHttpError` expone `changed`, y el diálogo lista «campo: antes → después», un cambio por
    línea.

### A-4 — Tras tocar Telegram, lo que la pantalla dice del canal se queda viejo

- **Síntoma.**
  - La pantalla de Telegram no hacía releer el Modo IA.
  - La pastilla miraba solo el dato del servidor.
  - El panel y el editor usaban `sinCanalDe(cliente) ?? servidor`. Como `??` también salta con el
    `null` del cliente («sí hay canal»), tras vincular seguía el aviso rojo.
- **Arreglo** (`a899709`).
  - Una sola regla, `canalEfectivo`: el dato del cliente si se conoce, y si no, el del servidor. La
    usan la pastilla (`ModoIaService.conCanal`), el panel, el editor y el asistente.
  - El resumen del Modo IA relee también el Telegram de quien mira.
  - La pantalla de Telegram lo refresca tras vincular, desvincular o tocar el aviso del Modo IA.

### A-5 — El borrador del panel del Modo IA repite H-05

- **Síntoma.** El `linkedSignal` conservaba el borrador ENTERO en cuanto había una edición, y
  guardar mandaba también lo no tocado.
- **Escenario.** Otro dispositivo apaga el modo; aquí se cambia «recolocar» y se guarda: el modo
  vuelve a encenderse.
- **Arreglo** (`a899709`). `rebasarBorradorIa`, campo a campo: lo tocado conserva su valor y lo demás
  toma el de la lectura nueva. Es la regla de `recolocarBorrador`.

### A-6 — Una lectura vieja del detalle se aplica igual

- **Síntoma.** `load()` no llevaba secuencia. Una respuesta que llegaba tarde anclaba el borrador a
  la versión anterior a un guardado, o lo recolocaba hacia atrás («versión 6 → 5»).
- **Arreglo** (`a899709`).
  - Solo se aplica una lectura más nueva que la última aplicada. Así no se descarta todo mientras
    lleguen eventos seguidos.
  - El borrador nunca va a una versión menor que su base.

### A-7 — El aviso de la recolocación puede quedar viejo o engañar

- **Síntoma.**
  - El aviso no se limpiaba si el borrador quedaba limpio sin volver a anclarse, y reaparecía con la
    edición siguiente.
  - Además decía «quizá por un ajuste del Modo IA» a quien no tiene Modo IA.
- **Arreglo** (`a899709`).
  - Una edición que empieza sobre un borrador limpio borra el aviso.
  - Una recolocación que no deja ediciones vuelve a anclar.
  - La mención al Modo IA sale solo para un administrador.

### A-8 — Un guardado correcto no mira si el borrador cambió mientras tanto

- **Síntoma.**
  - «Descartar» seguía activo durante el guardado.
  - Al terminar, la base se fijaba con lo enviado aunque el borrador ya fuera otro. Un segundo
    «Guardar» revertía el propio cambio.
  - Además, la base se fijaba después de esperar al aviso de éxito.
- **Arreglo** (`a899709`).
  - Un contador de generación del borrador: el guardado solo toca la base si el borrador sigue
    siendo el suyo.
  - La base se fija antes del aviso.
  - «Descartar» se desactiva mientras se guarda.

### A-9 — `guardarIa` no limpia `iaError`

Si una relectura fallaba con el guardado en vuelo, el panel se quedaba en «No se pudo leer». Ahora
un guardado correcto lo limpia, en el detalle y en la consola (`a899709`).

### A-10 — Cuatro diferencias entre el panel y el servidor

- **(a)** Las opciones de un bot manual sin canal acababan en 403. Corregido en el servidor con R-6.
- **(b)** Con manual guardado y sin canal, tras pulsar otro modo ya no se podía volver a manual.
  - **Corregido:** el editor recibe `modoGuardado` y solo bloquea **pasar** a manual.
- **(c)** El aviso «dormido hasta …» no caduca solo: es un `computed` sobre la hora.
  - **Descartado.** El panel se relee con cada evento `AI_*` y al entrar en el bot. Un temporizador
    por panel no compensa para un aviso que, pasada la fecha, solo dice una hora del pasado.
- **(d)** Un campo numérico con texto que no es un número entrega `''`, que se guardaba como «el
  intervalo de la estrategia», al contrario de lo que decía su comentario.
  - **Corregido:** `validity.badInput` distingue los dos casos, y lo inválido deja el borrador
    inválido.

### A-11 — Accesibilidad del Modo IA

- **(a)** La pastilla gris solo decía el motivo en `title`.
  - **Arreglo:** lleva el motivo en un texto que solo leen los lectores de pantalla (`.solo-lector`).
- **(b)** El segmento «Cuándo revisa» no tenía nombre accesible.
  - **Arreglo:** ahora lo tiene.
- **(c)** Los modos eran un `radiogroup` que no se movía con las flechas.
  - **Arreglo:** pasan a ser un grupo de botones con `aria-pressed`, un patrón que no promete
    flechas.

### A-12 — Textos y comentarios

- JSDoc huérfanos en `admin-bots.service.ts` y en `bot-detail.page.ts`.
- `LIMITES_IA` decía que la IA no puede cancelar órdenes, y el interruptor de recolocar dice que sí.
- Desvincular Telegram no avisaba a un administrador de que sus bots en «propone y espera» dejan de
  revisarse.

Los tres, corregidos (`a899709`).

## Áreas sin hallazgos

- **Fugas por el filtro (G-02).** Se revisaron todos los `throw` con `code`, `issues`,
  `coldFields` o `requiresConfirmation`:
  - llevan códigos, texto fijo o la configuración del propio dueño, y siempre después de `mustOwn`;
  - ningún camino envuelve un error del sistema en una `HttpException`;
  - solo el detalle del bot usa `requiresConfirmation`, así que ningún comando se autoconfirma.
- **Control de acceso.** Guardas y `@Roles('ADMIN')` a nivel de clase, `mustOwnAsAdmin`, rutas sin
  colisiones y el filtro por dueño en `onEvento` (salvo R-4).
- **`apply.ts` (054/H-01 y H-02), dinero.**
  - Ningún campo se mueve en sentido arriesgado ni sin cota.
  - El suelo que se conserva en la V2 solo puede ensanchar.
  - Si el techo queda por debajo del suelo, la propuesta se descarta por validación, que es el lado
    seguro.
- **`expectedVersion`** (salvo R-2 y R-3).
  - Se comprueba después de `mustOwn` y antes de pedir la confirmación WARM.
  - `null` da 400.
  - Un borrador recolocado no puede autorizar más cambios que los editados.
- **`canal.ts` frente al notificador.** La misma regla: chat, verificación y `prefs.ai`. Un fallo de
  lectura cuenta como «sin canal».
- **Suscripciones y efectos de la app.**
  - Las suscripciones llevan `takeUntilDestroyed`.
  - Los efectos escriben dentro de `untracked`.
  - `cargarIa` tiene su secuencia.
- **Nombres entre la app y la API**: coinciden.
- **Presupuestos de estilos**: sin cambios en las dos hojas que están en el límite.
