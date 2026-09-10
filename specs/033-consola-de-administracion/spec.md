# 033 — Consola de administración

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/033-consola-de-administracion`

## Objetivo

Dar a los administradores una consola para **mirar y contener**: ver todos los usuarios y todos
los bots de la plataforma, con paginación y filtros, y actuar cuando algo va mal —deshabilitar una
cuenta, cerrarle las sesiones, pausar o parar un bot— sin poder en ningún caso disponer del dinero
de nadie. Se sabrá que está hecho cuando un ADMIN pueda recorrer las cinco pantallas, un USER
reciba 403 en toda la superficie, y un usuario deshabilitado deje de operar contra la API **al
instante**, no dentro de quince minutos.

## Contexto

Hoy no hay forma de ver la plataforma por encima de un usuario. Cuando alguien reporta un problema,
el único camino es `psql` contra producción: no se puede saber qué bots hay en marcha, cuáles están
en `ERROR`, ni contener uno que se está portando mal, ni cerrar una cuenta comprometida.

Media pieza existe desde el spec 007: `admin/activity` ya demuestra el patrón completo
—`@Roles('ADMIN')` sobre `RolesGuard`, paginación con `PageDto`, servicio Angular, `adminGuard`,
página con «cargar más» y manejo del 403—. Falta todo lo demás.

CRYPTON es **no custodial**: el usuario deja sus fondos en el exchange y entrega una clave de firma
delegada. Un administrador que pudiera cerrar la posición de otro rompería la promesa del producto.
De ahí que el alcance sea deliberadamente estrecho y esté cerrado **por tipos**, no por convención.

Dos hechos del código condicionan el diseño y se descubrieron al planificar:

1. `JwtStrategy.validate()` devuelve el usuario de los claims firmados sin tocar la base de datos
   (`apps/api/src/modules/auth/strategies/jwt.strategy.ts:33`, y el comentario dice que es a
   propósito). `disabled` solo se mira en login, refresh y step-up. Sin más, «deshabilitar» sería
   una etiqueta: el token de acceso vigente seguiría valiendo hasta `JWT_ACCESS_TTL` (15 min).
2. `CANCEL_ALL_ORDERS` cancela **también el stop-loss nativo** del venue (invariante 6 de
   `CLAUDE.md`). Sobre un bot con posición apalancada abierta, la deja desnuda: es la única acción
   de «contención» capaz de dejar el dinero de un usuario peor protegido que antes.

## Alcance

- `apps/api`: módulo nuevo `modules/admin/` (dos controladores, dos servicios, DTOs); revocación de
  sesión en `modules/auth/`; `CacheService` (aditivo); `BotsSseService.dropUser`; tres retoques en
  `BotsService.command()` que **no tocan la autorización**.
- `packages/db/prisma`: **un solo índice**, `idx_bot_status_created` sobre `bots(status, created_at)`.
  Este spec es lo que autoriza esa migración, y no autoriza ninguna otra.
- `apps/app`: sección `/admin` con ruta padre, índice y cuatro pantallas nuevas; dos servicios
  cliente; `core/models/paging.ts`; enlace en Cuenta.
- `docs/`: la consola, sus límites y sus limitaciones conocidas.

## Fuera de alcance

- **Cambiar el rol de un usuario desde la UI.** Añade superficie de escalada de privilegios a
  cambio de un caso que ocurre dos veces al año y se resuelve por SQL.
- **Editar la configuración de bots ajenos.** Un admin que puede cambiar el apalancamiento de otro
  no está conteniendo, está operando.
- **`CANCEL_ALL_ORDERS`, `STOP_AND_CLOSE`, `CLOSE_NOW`, `PANIC`, `START`, `RESUME`,
  `REANCHOR_GRID`, `ADJUST_MARGIN`, `TAKE_PROFIT_NOW`, `ADD_SAFETY_NOW`, `REPAIR`.** Los cuatro
  primeros realizan el resultado o retiran protección; el resto abre riesgo o compromete margen.
- **Ver saldos de exchange.** Exige `openAdapter()`, que descifra la clave de firma del usuario
  (invariante 8). El módulo ni siquiera importa `ExchangeAccountsModule`, para que no se pueda.
- **Borrar cuentas o bots ajenos.**
- **Parar los bots de un usuario al deshabilitarlo.** Son dos acciones distintas y encadenarlas
  sería decidir por el usuario; se avisa en pantalla de que no ocurre (ver R-9).

## Requisitos

- **R-1** Toda ruta bajo `/admin/*` exige `JwtAuthGuard` + `RolesGuard` + `@Roles('ADMIN')`
  declarados **a nivel de clase**: `RolesGuard` restringe pero no protege por defecto, así que un
  método sin cobertura de clase sería público.
- **R-2** `GET /admin/users` y `GET /admin/bots` devuelven `PageDto` (`{ data, meta }`) con
  `PageOptionsDto` y filtros declarados; ningún listado devuelve la tabla entera.
- **R-3** Ninguna respuesta contiene `users.google_sub`, el sobre AES
  (`enc_payload`, `enc_dek`, `enc_iv`, `enc_tag`, `enc_key_id`), `telegram_links.link_code`,
  `telegram_links.chat_id` ni `subscriptions.external_ref`. Doble cierre: `select` explícito de
  Prisma **y** mapper `toPublic()` que enumera lo que sale.
- **R-4** Todo importe sale como `string` (invariante 1) y todo `BigInt` convertido.
- **R-5** El vocabulario de comandos del administrador es exactamente `PAUSE` y
  `STOP_KEEP_POSITION`, atado al enum real con `satisfies`, y comprobado en dos puertas: el DTO
  (protege la ruta) y el servicio (protege el método si otro controlador lo llama).
- **R-6** La propiedad de un bot no se relaja: `mustOwn(userId, id)` conserva su primer argumento
  obligatorio. El servicio de administración resuelve el dueño real y llama a `BotsService` con él.
- **R-7** `bot_commands.requested_by` guarda el id del **administrador**; el evento del bot queda
  con severidad `WARN` y dice que lo pidió soporte; y el mensaje del bus lleva el `userId` del
  **dueño**, para que el aviso llegue a quien le han tocado el bot.
- **R-8** Deshabilitar una cuenta o cerrar sus sesiones invalida sus access token **al instante**.
- **R-9** La ficha de usuario avisa de que deshabilitar **no para sus bots**, y muestra cuántos
  tiene vivos.
- **R-10** Las acciones sobre la cuenta o el bot de otro se auditan con `critical: true`, con
  motivo; las lecturas de listado y ficha se auditan a mano (son GET, el interceptor no los ve).
- **R-11** Un administrador no puede deshabilitarse a sí mismo ni dejar la plataforma sin ningún
  ADMIN activo.
- **R-12** Con Redis caído la API **no** se cierra: se pierde la revocación durante el corte, salvo
  para los usuarios ya conocidos como revocados, y la degradación queda registrada.

## Criterios de aceptación

- **CA-1** `it.each` sobre las rutas de `/admin/*`: un USER recibe 403 y sin token 401.
  (`pnpm --filter api test:e2e`)
- **CA-2** `GET /admin/bots` como ADMIN incluye el bot de otro usuario, mientras el test de
  aislamiento existente sigue probando que un USER no lo alcanza. (e2e)
- **CA-3** `JSON.stringify` de las respuestas de usuarios no contiene ninguno de los literales de
  R-3. (unitario + e2e)
- **CA-4** Cada uno de los once comandos prohibidos es rechazado y `BotsService.command` no llega a
  llamarse; `botCommand.count` sigue en cero. (`admin-bots-command.spec.ts` + e2e)
- **CA-5** `PAUSE` desde la consola deja `requested_by = admin.id` —no el del dueño—, un
  `bot_events` `WARN` que menciona soporte, y un mensaje de bus dirigido al dueño. (unitario + e2e)
- **CA-6** Un token emitido antes de la revocación recibe 401 con el mismo token que antes daba
  200; uno emitido después, 200. Incluido el borde del segundo. (unitario + e2e)
- **CA-7** Con Redis caído, un usuario ya conocido como revocado sigue revocado; uno desconocido
  pasa y se registra **una sola** degradación por ventana. (unitario)
- **CA-8** `PATCH /admin/users/:id` devuelve 404 y `{ role: 'ADMIN' }` en el cuerpo de una acción
  devuelve 400: no existe forma de cambiar el rol por la API de administración. (e2e)
- **CA-9** `Reflect.getMetadata(ROLES_KEY, Clase)` es `['ADMIN']` en los dos controladores.
  (`admin-guards.spec.ts`)
- **CA-10** `pnpm --filter app build` y `pnpm --filter app lint` pasan; ningún componente supera el
  presupuesto de estilos.
- **CA-11** *(manual, con la infra levantada)* Promover una cuenta a ADMIN por SQL, recorrer las
  cinco pantallas, pausar un bot **simulado** propio desde el panel y comprobar en otra sesión que
  el aviso llega al instante.

## Riesgos

- **Se toca el camino caliente de autenticación.** `JwtStrategy.validate()` pasa a ser `async` y a
  leer Redis: afecta a toda petición autenticada de la API. Mitigación: va en su propio commit, con
  los tres commits previos (cache, servicio, `TokenService`) sin cambio de conducta; el e2e de
  aislamiento entero es la red.
- **Se toca `BotsService.command()`, con bots en marcha.** Mitigación: el parámetro nuevo solo puede
  cambiar la **etiqueta**, nunca la autorización; test de regresión del camino normal escrito
  primero y comparando el mensaje carácter a carácter.
- **Migración sobre `bots`.** Prisma envuelve la migración en una transacción, así que no cabe
  `CREATE INDEX CONCURRENTLY`; con la tabla actual el bloqueo es despreciable. Si algún día no lo
  fuera, esa migración se escribe a mano fuera de transacción.
- **`AUDIT_LOG_ENABLE` apagado deja la consola sin bitácora.** Una consola de administración sin
  trazabilidad no debería existir: la variable tiene que estar encendida en producción.
- **`BigInt` revienta en el e2e y no en producción**: el parche de `main.ts:20` no corre en la
  suite, que monta la app con `createNestApplication()`. Se convierte en los mappers.

## Referencias oficiales

Ninguna: este spec no se apoya en el comportamiento de ningún venue ni SDK externo. Las reglas que
lo condicionan son internas y están citadas con `fichero:línea` en el contexto y en `plan.md`.
