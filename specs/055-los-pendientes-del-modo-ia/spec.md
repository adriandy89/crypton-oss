# 055 — Los pendientes del Modo IA, y los errores que la app no veía

Estado: `hecho` (falta CA-8 manual; desplegar primero la API) · Tipo: `cambio` · Rama: `spec/055-los-pendientes-del-modo-ia`

## Objetivo

Cerrar todo lo que el 053 y el 054 dejaron reportado sin corregir, y un defecto de la API que
apareció al diseñar uno de esos arreglos. Se sabrá que está hecho cuando:

- cada defecto tenga un test que fallaba con el código anterior;
- las guías dejen de avisar de él;
- la verificación completa esté en verde y las mutaciones de los arreglos caigan.

## Contexto

Petición directa del usuario del 2026-09-16, tras el 054: «arregla todos los pendientes, luego
revisa y pasa al open source, y luego pasa todo a main. CUIDADO». Las decisiones que el usuario no
tomó se toman aquí con el criterio de la casa: la opción que menos cambia la conducta de un bot vivo
y que falla hacia el lado seguro.

### Los pendientes

- **054/H-01** (Alta; Media mientras solo actúe sobre simulados). En un market maker V2, cualquier
  decisión de la IA rebaja la distancia mínima que el dueño fijó por encima de las distancias
  (20 → 10 bps), aunque la perilla sea otra.
  - En la V2 esa configuración es legítima: el validador solo avisa («se elevarán hasta ahí»).
  - `enforceCouplings` la «repara» después del traslado, sin banda y con cualquier perilla.
- **054/H-02** (Media). En un market maker V2, «diferencial más» puede estrechar el diferencial
  efectivo, y «menos», ensancharlo. Pasa en torno a un 27 % de las propuestas, a la volatilidad que
  supone el generador.
  - El generador reparte el objetivo entre la distancia base y el multiplicador de volatilidad, y
    los mueve en sentidos contrarios.
  - El traslado acota cada campo por su lado y no conserva la suma.
- **053/H-03** (Media). Un bot en «propone y espera» sigue revisándose y gastando llamadas aunque
  sus sugerencias no puedan llegar a nadie. El servidor solo exige el Telegram al encender el modo,
  y el canal se pierde de tres maneras:
  - al desvincular Telegram;
  - al pedir un código nuevo, que borra la verificación;
  - al apagar los avisos de IA en las preferencias, que el servidor no mira nunca.
- **053/H-05** (Media). Un borrador de Ajustes guardado tarde reescribe la configuración entera y
  deshace en silencio lo que el supervisor aplicó entretanto: la app no manda `expectedVersion`, y
  la API ni siquiera lo acepta por REST.
  - **Encontrado al diseñar el arreglo (G-01), peor que H-05.** La pantalla decide si hay cambios
    sin guardar comparando el borrador con la configuración ACTUAL, no con la versión de la que
    nació.
  - Por eso, cuando el supervisor aplica un cambio y la pantalla se recarga, un borrador que nadie
    ha tocado parece editado:
    - el formulario se queda con los valores viejos;
    - sale la barra de guardar;
    - el aviso del 053 invita a «guardar igualmente», que es exactamente deshacer el cambio.
- **Los tipos de los tests de la API.** `tsc` sobre `apps/api` da tres errores que ya estaban en el
  053, en `advisor.spec.ts`, `bots-margin.spec.ts` y `supervisor.service.spec.ts`. Ni jest ni
  `nest build` los ven.

### Defecto encontrado al diseñar H-05 (G-02, Alta)

**La API no deja pasar a la app el detalle de sus errores.**

- **La regla del filtro.** Desde el 2026-08-21, `AllExceptionFilter` solo reenvía el cuerpo entero
  de un error si trae `code`; si no, solo reenvía su `message`.
- **Qué errores la incumplen.** Tres rechazos de configuración construyen un cuerpo con más datos y
  sin `code`, así que al cliente solo le llega el texto:
  - la petición de confirmación de un cambio WARM (`requiresConfirmation`);
  - los motivos de una configuración no válida (`issues`);
  - los campos que no se pueden cambiar (`coldFields`).
- **Efecto.** La app **no puede aplicar ningún cambio WARM desde Ajustes**. Espera
  `requiresConfirmation` para preguntar y volver a enviar confirmando, y recibe un texto: enseña
  «… Confirma para continuar» en un aviso que no tiene botón.
- **Evidencia.** Un test del filtro con los tres cuerpos devuelve solo el mensaje.
- **Lo que no afecta.** A los comandos no les pasa nada: los destructivos se confirman en la app
  antes de enviarlos.

## Decisiones

- **H-01.** El supervisor no aplica a una V2 la reparación de la distancia mínima. En la V1 sí: allí
  el validador la exige y la reparación nunca sale de la banda de la distancia que la provoca.
- **H-02.** Ninguna de las dos opciones del 054. Se elige una tercera, más conservadora: **con la
  perilla del diferencial, las distancias y el suelo de un market maker solo se mueven en el sentido
  pedido**.
  - **Qué hace.** Si el traslado los movería al revés, se quedan como estaban. Se propone el resto
    —multiplicador de volatilidad, techo dinámico, umbral de recotización, separación entre capas—,
    que el generador ya mueve en el sentido de la perilla.
  - **Por qué vale para cualquier volatilidad.** Así ningún componente del diferencial compuesto va
    al revés, sea cual sea la volatilidad.
  - **Por qué no se descarta la propuesta entera.** Porque dejaría la perilla sin ningún uso en un
    mercado en calma.
- **H-03.** Si el modo efectivo es «propone y espera» y el dueño no tiene canal —Telegram sin
  verificar o avisos de IA apagados—, **la revisión se salta antes de gastar**, como las demás
  barreras.
  - **Qué no se hace.** No se apaga el modo ni se toca la fila. Al volver el canal, el bot se revisa
    solo.
  - **Encender el modo.** Exige el mismo canal, avisos de IA incluidos.
  - **La app.** La pastilla sale en gris con el motivo, y el editor y el asistente usan la misma
    regla.
- **H-05.**
  - **La API.** Acepta `expectedVersion` en `PATCH /bots/:id/config` y responde 409 con
    `code: 'STALE_VERSION'`. Se mantiene `reason`, que es lo que lee el supervisor.
  - **Qué se considera editado.** La pantalla guarda la configuración de la que nació el borrador,
    y cuenta como cambio solo lo que difiere de ella.
  - **Si la versión cambió.** Guardar aplica **solo los campos que editaste**, sobre la versión
    nueva, con `expectedVersion`.
  - **Si la versión cambia en el momento de guardar.** Se recoloca el borrador sobre la versión
    nueva, se dice y se deja guardar de nuevo.
- **G-02.** El filtro reenvía entero cualquier cuerpo que lleve alguno de los campos del contrato
  con la app: `code`, `requiresConfirmation`, `issues` o `coldFields`.
  - Son cuerpos construidos a propósito por nuestro código, no mensajes de Prisma ni de un SDK.
  - Un error de validación de `class-validator` no trae ninguno de esos campos, y sigue saliendo
    como hasta ahora.

## Alcance

- **API.**
  - `supervisor/apply.ts` (H-01, H-02).
  - `supervisor/supervisor.service.ts` y `supervisor.policy.service.ts` (H-03), con la regla del
    canal en un módulo puro.
  - `admin/admin-ai.controller.ts`: el motivo va en los interruptores (H-03).
  - `bots/` (H-05): DTO, controlador y el `code` del 409.
  - `libs/common/filters/exception.filter.ts` (G-02).
  - Los tres tests con errores de tipos.
- **`packages/shared/src/borrador.ts`** (H-05), nuevo y con tests: qué campos editó el dueño y cómo
  se recoloca su borrador sobre otra versión. Va en `shared` por el mismo motivo que `series.ts`:
  la app no tiene tests, y esta regla decide si se deshace un cambio en un bot con dinero dentro.
- **App.**
  - `core/utils/modo-ia.ts` y sus tipos, más el editor, el panel y el asistente (H-03).
  - `features/bots/bot-detail.page.ts` y `core/services/bots.service.ts` (H-05).
- **Guías.** Quitar las limitaciones 054/H-01 y 054/H-02, reescribir las frases del 053 sobre H-03 y
  H-05, y poner al día la tabla de reparaciones.

## Fuera de alcance

- La historia publicada del fork, donde quedó el nombre de un bot. Reescribirla exige un push
  forzado, y eso solo lo decide y lo hace el usuario.
- Que la perilla del diferencial pueda ensanchar un V2 en un mercado en calma. El generador fija su
  objetivo en el suelo por coste, así que ahí no tiene nada que ensanchar. Es diseño del generador,
  que es del asesor y de todos los bots nuevos.
- `packages/db`, `strategy-core`, `exchange-core` y el worker. De `shared` solo entra un módulo puro
  nuevo (ver Alcance).

## Requisitos

- **R-1 (H-01)** — En una V2, ninguna propuesta del supervisor cambia `minAllowedDistanceBps` salvo
  la perilla del diferencial, dentro de su banda. En la V1 la reparación sigue existiendo.
- **R-2 (H-02)** — En los dos market makers, con la perilla del diferencial, `buyDistanceBps`,
  `sellDistanceBps` y `minAllowedDistanceBps` nunca se mueven en sentido contrario al pedido. En la
  V2, el diferencial efectivo de la primera capa, por los dos lados, nunca va al revés a ninguna
  volatilidad.
- **R-3 (H-03)** —
  - Sin canal para las sugerencias, un bot en «propone y espera», configurado o forzado por el
    servidor, no se revisa: ni turno, ni cupo, ni llamada, ni fila.
  - En automático, el canal no hace falta.
  - Encender «propone y espera» exige canal y dice cuál falta.
  - Las respuestas del Modo IA llevan el motivo en los interruptores, y la app lo pinta.
- **R-4 (H-05)** — Estas reglas, en la API y en la app:
  - `expectedVersion` es opcional: sin él, todo sigue igual; con él, un bot en otra versión responde
    409 con `code: 'STALE_VERSION'`, y un `null` responde 400.
  - La app lo manda siempre.
  - Un cambio externo sin ediciones propias refresca el formulario.
  - Con ediciones, guardar aplica solo esas ediciones sobre la versión nueva.
  - Un 409 por versión recoloca el borrador y lo dice.
- **R-5 (G-02)** — Un error con `code`, `requiresConfirmation`, `issues` o `coldFields` llega entero
  al cliente. Uno sin ellos llega como antes, y uno que no es HTTP sigue siendo genérico.
- **R-6** — `tsc --noEmit -p apps/api/tsconfig.json` sin errores.
- **R-7** — Las guías no avisan de nada corregido y explican lo nuevo: la barrera del canal y el
  guardado sobre la versión nueva.

## Criterios de aceptación

- **CA-1 (R-1)** — Un test con una V2 de suelo por encima de las distancias:
  - con perillas que no son el diferencial, no propone tocar el suelo;
  - con el apalancamiento, que solo arrastraba la reparación, no propone nada.
  - Falla con el código anterior.
- **CA-2 (R-2)** — Un test sobre la matriz de mercados: en ninguna propuesta del diferencial se
  mueve una distancia al revés, ni cambia en sentido contrario el diferencial efectivo de la V2 en
  calma, a la volatilidad de referencia y al doble. Falla con el código anterior.
- **CA-3 (R-3)** — Tests del servicio: en manual y en automático forzado a manual, sin vínculo o con
  los avisos apagados, no se llama al modelo ni se consume turno; en automático, sí.
  - Tests de la política: encender manual sin vínculo o con los avisos apagados responde 403 con el
    motivo.
  - Tests de la regla del canal.
- **CA-4 (R-4)** — Tests del DTO: `expectedVersion` entero ≥ 1, opcional y sin `null`.
  - Del controlador: lo pasa a `updateConfig`.
  - Del servicio: el 409 lleva `code`.
- **CA-5 (R-5)** — Test del filtro con los casos de R-5. Falla con el filtro anterior.
- **CA-6 (R-6)** — `tsc` limpio sobre la API.
- **CA-7** — `ng build` y `ng lint` limpios; `pnpm test`, `pnpm lint`, `pnpm check:env` y los builds
  de la API y del worker en verde; las mutaciones de cada arreglo caen.
- **CA-8** — Comprobación manual del usuario:
  - un cambio WARM se confirma y se aplica desde Ajustes;
  - con un borrador a medias, un ajuste de la IA no se deshace al guardar;
  - un bot en «propone y espera» con Telegram desvinculado sale en gris y no gasta.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El filtro nuevo deja salir algo que no debía | Solo cuerpos de `HttpException` con los campos del contrato: los construye nuestro código. Test con los casos. |
| La app antigua contra la API nueva, o al revés | La app antigua contra la API nueva funciona como antes: `expectedVersion` es opcional y el filtro solo AÑADE campos. **Al revés, no**: la API valida con `forbidNonWhitelisted`, y una API anterior responde 400 a todo guardado de Ajustes que lleve `expectedVersion`. Se despliega **primero la API** y después la app (corregido en la revisión, spec 056 R-2/A-3). |
| Recolocar el borrador pisa un campo que la IA cambió y el dueño también | Gana el dueño: lo editó a mano y se le dice que la versión cambió. |
| La barrera del canal deja sin revisar un bot que sí tiene canal | Misma regla que el notificador del worker (vínculo verificado, `chat_id` y `prefs.ai`), con test. |
| H-02 deja el diferencial de la V2 sin efecto en calma | Es honesto: el generador no tiene nada que ensanchar ahí. Se dice en la guía. |
