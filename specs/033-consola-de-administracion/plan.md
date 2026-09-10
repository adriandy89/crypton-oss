# 033 — Plan de implementación

Acompaña a `spec.md`. Aquí va el **cómo**: el enfoque, los ficheros, el orden de los commits y la
verificación. El qué y el por qué están en el spec.

## Por qué ahora

CRYPTON no tiene forma de ver la plataforma por encima de un usuario. Cuando alguien reporta
un problema, el único camino es `psql` contra producción: no hay manera de saber qué bots hay
en marcha, cuáles están en `ERROR`, ni de contener uno que se está portando mal, ni de cerrar
una cuenta comprometida.

Existe media pieza: `admin/activity` (spec 007) ya demuestra el patrón completo —`@Roles('ADMIN')`,
paginación `PageDto`, servicio Angular, `adminGuard`, página con «cargar más»—. Falta todo lo demás.

El objetivo es una consola que permita **mirar y contener**, nunca disponer del dinero ajeno.
Es una plataforma no custodial: un administrador que pueda cerrar la posición de otro rompe la
promesa del producto. Por eso el alcance es deliberadamente estrecho y está cerrado por tipos,
no por convención.

## Decisiones tomadas

| | Decisión |
|---|---|
| Bots | Lectura completa. Comandos: **solo `PAUSE` y `STOP_KEEP_POSITION`**. Los dos conservan el stop-loss nativo del venue. |
| `CANCEL_ALL_ORDERS` | **Fuera del panel.** Cancela también el stop-loss (invariante 6): es la única acción de contención que puede dejar una posición apalancada desnuda. La superficie que no existe no se puede usar mal. |
| Usuarios | Listar, ficha completa, deshabilitar/rehabilitar, cerrar sesiones. **El rol no se cambia desde la UI.** |
| Revocación | Inmediata: marca por usuario en Redis comparada contra el `iat` del token. |
| Aviso al dueño | Tiempo real: el evento se publica en el bus con el `userId` del **dueño**. |
| Navegación | Ruta padre `/admin` con `children` y página índice. La barra de pestañas no se toca. |

**No entra**: cambiar rol, editar configuración de bots ajenos, ver saldos de exchange (exige
descifrar la clave del usuario), cerrar posiciones, borrar cuentas.

---

## Parte 1 — Revocación inmediata de sesión

Hoy `JwtStrategy.validate()` devuelve el usuario de los claims firmados sin tocar la BD
([jwt.strategy.ts:33](apps/api/src/modules/auth/strategies/jwt.strategy.ts#L33)). Deshabilitar a
alguien no muerde hasta que caduque su access token (~15 min). Sin esto, «deshabilitar» es
una etiqueta.

**Mecanismo**: clave `auth:revoked:<userId>` = epoch ms, TTL `accessTtl + 60`. Se compara contra
el `iat` del token (verificado: `signAccess` no pasa `noTimestamp`, así que `iat` está).

- La marca se escribe **redondeada al segundo siguiente** (`(floor(now/1000)+1)*1000`). `iat` tiene
  granularidad de segundo y la marca de milisegundo, así que el segundo en que se revoca es
  ambiguo: un token firmado en `T.100` y una revocación en `T.500` comparten `iat = T`. Redondeando
  hacia arriba, ese segundo entero cuenta como revocado y el token muere, que es lo que debe pasar.
  El precio es que también muere uno emitido en `T.800` —después de la revocación—, caso que no se
  da en la práctica y cuyo remedio es volver a identificarse. Redondear hacia abajo sería el
  intercambio contrario: dejaría vivo hasta un segundo de tokens anteriores a la revocación.
- **Enganche en `JwtStrategy.validate()`**, que pasa a `async`. No en un `APP_GUARD` (corre antes
  que `JwtAuthGuard`, sin `req.user`) ni en un guard adicional (sería olvidable en el próximo
  controlador). Passport ya hace `await` del retorno: los controladores no cambian.
- Hay que **reescribir**, no borrar, el comentario de `jwt.strategy.ts:31-32`: sigue siendo cierto
  que no se toca la BD, pero ahora hay una lectura de Redis y el comentario debe contar por qué.

**Redis caído: fail-open acotado.** Decisión explícita, y es la contraria a la invariante 10 del
worker a propósito: allí el lease evita **duplicar órdenes**; aquí cerrar no evita ninguna orden,
la impide. Con la API en 401, un usuario con bots operando no puede llegar a su kill-switch.
El criterio ya está escrito en `audit.service.ts:21-25`.

Tres piezas para que el fail-open no sea silencioso:
1. `CacheService.isReady` + `getOrThrow()` — el `get()` actual devuelve `null` tanto si no hay clave
   como si Redis está muerto, y eso convertiría el fail-open en invisible. Añadidos aditivos:
   ningún llamante existente cambia.
2. Memoria de proceso con la última lectura buena (60 s): un usuario **ya conocido como revocado
   sigue revocado** durante el corte. El caso peligroso queda cubierto.
3. Ruido una vez por ventana, no por petición, + entrada `auth.revocation_degraded` con el recuento.

**API** (`apps/api/src/modules/auth/session-revocation.service.ts`, nuevo):

```ts
revoke(userId, motivo): Promise<RevocationResult>   // { aplicada, vigenteHasta }
isRevoked(userId, iatSec): Promise<boolean>          // nunca lanza
clear(userId): Promise<void>                         // al rehabilitar
```

`TokenService.revokeAll()` ([token.service.ts:128](apps/api/src/modules/auth/token.service.ts#L128))
pasa a llamar a `revoke()` además de matar las familias: hoy es un cierre a medias, y
`signOutEverywhere()` gana el corte real sin tocarse. Se expone `TokenService.accessTtl`.

**El SSE es un agujero aparte**: `/bots/stream` se autentica al abrir y vive horas. Hace falta
`BotsSseService.dropUser(userId)` (gemelo de `evictOldest`) y un canal `AUTH_REVOKED` en el bus
para las instancias que no atienden al admin.

Variables nuevas (a `.env.example` **y** al compose, o `pnpm check:env` falla):
`AUTH_REVOCATION_FAIL_OPEN=true` (comparar con `!== 'false'`: polaridad invertida respecto a
`AUDIT_LOG_ENABLE`, porque un valor mal escrito no puede tumbar la API), `AUTH_REVOCATION_STALE_MAX_MS=60000`.

---

## Parte 2 — Módulo `admin` en la API

Un solo módulo, `apps/api/src/modules/admin/`, con dos controladores y dos servicios. La propiedad
que importa es «*toda* la superficie está cerrada por rol», y con un directorio eso se comprueba
con un `grep` y un test. `activity/` se queda donde está sirviendo `admin/activity`.

Molde exacto: [activity.controller.ts](apps/api/src/modules/activity/activity.controller.ts) +
[activity.service.ts](apps/api/src/modules/activity/activity.service.ts). Cabecera a nivel de
**clase** en los dos controladores (`RolesGuard` restringe, no protege: un método sin cobertura
sería público):

```ts
@Controller('admin/users')  // y 'admin/bots'
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
```

`admin.module.ts` importa `BotsModule` y **no** `ExchangeAccountsModule` — es la puerta a
`openAdapter()`, que descifra la clave de firma (invariante 8). La ausencia va comentada, porque
el siguiente que necesite un saldo lo importará sin pensarlo.

### Endpoints

| Verbo | Ruta | Notas |
|---|---|---|
| GET | `/admin/users` | `q, role, disabled, withBots, sortBy, from, to` + `PageOptionsDto` |
| GET | `/admin/users/:id` | ficha completa |
| POST | `/admin/users/:id/disable` | body `{ reason? }` |
| POST | `/admin/users/:id/enable` | |
| POST | `/admin/users/:id/sessions/revoke` | |
| GET | `/admin/bots` | `userId, email, venue, symbol, strategy, status, dryRun, testnet, withError, sortBy` |
| GET | `/admin/bots/:id` | |
| GET | `/admin/bots/:id/{orders,fills,cycles,events,revisions,levels,snapshots}` | `HistoryQueryDto` |
| POST | `/admin/bots/:id/commands` | body `{ command, reason }` |

**Acciones nombradas, no `PATCH /admin/users/:id`.** Es la decisión de diseño clave del bloque:
un DTO de actualización parcial queda a un campo de ser una escalada de privilegios. Con tres
acciones no existe ningún cuerpo capaz de llevar `role`. Un test congela que `PATCH` da 404.

**Vocabulario de comandos, atado al enum real:**

```ts
export const ADMIN_COMMANDS = [
  'PAUSE',
  'STOP_KEEP_POSITION',
] as const satisfies readonly BotCommandName[];
```

`satisfies` no es adorno: renombrar un comando en `bots/dtos` rompe la compilación aquí en vez de
dejar una lista blanca que ya no casa. Doble puerta: `@IsEnum(ADMIN_COMMANDS)` en el DTO (protege
la ruta) **y** comprobación en el servicio (protege el método cuando otro controlador lo llame).
`reason` es obligatorio: es lo único que hace revisable después una acción sobre dinero ajeno.

### Reutilizar `BotsService` sin abrir agujeros

**No parametrizar `mustOwn`.** En cuanto su primer argumento admite `null`, la expresión
`mustOwn(user?.id, id)` compila en cualquier ruta de usuario normal y devuelve el bot de cualquiera,
sin excepción y sin log. Hoy eso no compila, y hay quince llamadas que dependen de ello.

En su lugar, `AdminBotsService.ownerOf(botId)` resuelve el dueño con un `select` de una columna y
llama a `BotsService` con el `user_id` **real**: la comprobación de propiedad sigue siendo cierta,
no relajada. Cuesta una consulta más por petición; en una consola que usa una persona no se nota.
Verificado que `detail`, `orders`, `fills`, `cycles`, `events`, `revisions`, `levels` y `snapshots`
no abren adaptador ni descifran nada.

**404 vs 403**: en `/admin/*` el `RolesGuard` deniega antes de mirar el `:id`, así que un USER recibe
**403** — no revela ninguna fila. Un ADMIN con un id inexistente recibe **404**. Contradice en
apariencia la cabecera de `isolation.e2e-spec.ts`, así que va explicado junto al test.

### Cambio en `BotsService.command()`

Tres retoques, ninguno toca la autorización ([bots.service.ts:1097](apps/api/src/modules/bots/bots.service.ts#L1097)):

1. `opts.requestedBy?` opcional — **etiqueta, nunca autoriza**: el primer argumento sigue siendo el
   dueño y `mustOwn` lo sigue exigiendo. Existe para que `bot_commands.requested_by` diga qué admin
   lo pidió; poner ahí el id del dueño sería falsificar la trazabilidad en la fila que existe para
   investigar.
2. Cuando `requestedBy !== userId`: severidad `WARN` y mensaje «solicitado por soporte».
3. El bus publica `userId: bot.user_id`, no el del solicitante (línea 1232). Hoy es latente —el único
   consumidor enruta por `botId`— pero es una mentira en el sobre, y con la consola el solicitante
   deja de ser el destinatario por primera vez.

Además, `AdminBotsService` publica un `BOT_EVENTS` con `userId: owner` y `type: 'ADMIN_COMMAND'`
para que la app del dueño se entere al instante (decisión tomada).

### Rendimiento

Un solo índice nuevo, justificado: `@@index([status, created_at(sort: Desc)])` en `bots`. El
existente `[user_id, status]` no sirve para «qué hay en marcha ahora» (`status` no es columna guía)
y no hay índice sobre `created_at`, que es el orden por defecto. Sirve al filtro, al orden y al
`count()` de la misma consulta.

El filtro por email **no se hace con un join**: `contains` sobre `users` genera una subconsulta
correlacionada con `LIKE '%q%'` que no puede usar índice y se ejecuta dos veces. Se resuelve en dos
pasos (usuarios → `take: 50` ids → bots por `user_id`, que está indexado).

CLAUDE.md prohíbe tocar `packages/db/prisma` sin un spec que lo pida: **el spec 033 lo pide, para
este índice y nada más**. Nombre `idx_bot_status_created` con `map:` (sin él, `migrate diff` sale
con deriva siempre).

### Auditoría

`admin.user.disable` / `.enable` / `.sessions_revoke` y `admin.bot.command` son **`critical: true`**
(el docstring de `recordNow` ya lista «acciones de ADMIN sobre la cuenta de otro»). Los GET
(`admin.users.list`, `admin.user.read`, `admin.bots.list`, `admin.bot.read`) se auditan a mano,
como en `activity.controller.ts:41-52`: leer la ficha completa de alguien es un evento de privacidad.
No se auditan las subrutas de histórico.

**Trampa**: `audit.interceptor.ts` solo rellena la columna `bot_id` si la acción empieza por `bot.`.
`admin.bot.command` quedaría sin correlación con `bot_events`, que es media investigación. Se
registra **a mano** con `recordNow` (que además es el único sitio que conoce el `ownerId` resuelto),
con un comentario para que nadie «arregle» la falta del decorador.

### Lo que no sale jamás

Doble cierre —`select` explícito de Prisma **y** mapper `toPublic()` que enumera lo que sale—:
`users.google_sub`, todo el sobre AES (`enc_payload/enc_dek/enc_iv/enc_tag/enc_key_id`),
`telegram_links.link_code` y `chat_id`, `subscriptions.external_ref`. Todo `Decimal` sale como
`string` (invariante 1) y todo `BigInt` con `.toString()`.

---

## Parte 3 — La app

Ruta padre **sin componente**, con `children` — el precedente es el bloque `auth`
([app.routes.ts:16-26](apps/app/src/app/app.routes.ts#L16-L26)), no `tabs`: aquí no hay shell, cada
pantalla trae su cabecera, y un padre con componente solo añadiría un outlet anidado. Lo que aporta
es tener los guardas escritos una vez: la séptima pantalla nace protegida.

```
/admin              admin.page.ts          índice
/admin/activity     activity.page.ts       existe — solo cambia defaultHref a /admin
/admin/users        users.page.ts
/admin/users/:id    user-detail.page.ts
/admin/bots         bots.page.ts
/admin/bots/:id     bot-detail.page.ts
```

`account.page.ts:288-300` pasa de tres enlaces potenciales a uno solo, `/admin` (`shield-outline`,
ya registrado; quitar `pulseOutline` del import y del `addIcons`).

**Servicios**: `core/services/admin-users.service.ts` y `admin-bots.service.ts`, molde de
`ActivityService` (HttpClient + `firstValueFrom`, params condicionales porque el servidor tiene
`forbidNonWhitelisted`). Sin señales de estado: estos datos son por pantalla, no compartidos.
**Fuera del barril** `core/services/index.ts`, que es alcanzable desde el chunk inicial vía
`app.component.ts:8`.

**`Paginated<T>` / `PageMeta` en `core/models/paging.ts`**, no en `packages/shared`. La forma
`{data, meta}` ya está duplicada a mano en `activity.service.ts:29-39` y con dos pantallas más serían
cuatro copias — pero `shared` es dominio y aritmética de dinero con tests, y tocarlo obliga a
`build:packages` + tests de worker y backtest por un `interface` de dos campos que nadie fuera de la
app va a leer. `ActivityPage` pasa a ser `Paginated<ActivityEntry>` y `activity.page.ts` no cambia.

**Pantallas**. Sin tablas: es un móvil, la unidad es la fila de dos o tres líneas dentro de
`ui-card flush`, calcada de `activity.page.ts:209-251`. Se reutiliza el design system entero
(`ui-status-pill`, `ui-badge`, `ui-stat`, `ui-notice`, `ui-liq-meter`, `ui-collapsible`,
`ui-empty-state`) y los helpers de `core/utils` (`labels`, `format`, `risk`, `config-text`).
Filtros con `ion-searchbar` + chips + `ion-select interface="action-sheet"`, como la pantalla
hermana. Paginación: se copia «cargar más» de Actividad — `ion-infinite-scroll` no se usa en ningún
sitio de la app y el rincón menos visitado del producto es el peor lugar para estrenar un patrón.

**El detalle de bot admin es una página nueva, no `bot-detail` generalizado.** Aquel son 30 KB de TS
+ 37 KB de HTML + 10,6 KB de SCSS con cinco pestañas, formulario editable, publicación al ranking y
nueve llamadas acotadas por `user.id`; darle «modo admin» significaría desviar las nueve y esconder
media plantilla tras `@if`. Lo que el admin necesita —de quién es, qué es, cuánto hay en riesgo, qué
falló, dos botones— son ~150 líneas. Sí se copia la *lógica*: respaldo de capital con `capitalActual`
de `@crypton/shared` (la app no suma dinero) y el umbral de liquidación de `bots-list.page.ts:599`.

**Un componente `<admin-forbidden />`** para el 403 real, usado por las cinco pantallas y también por
`activity.page.ts` (diff de seis líneas allí): el `adminGuard` es cosmético y el aviso no puede
desalinearse entre cinco copias. Los dos detalles añaden **404 → `ui-empty-state`**, nunca un toast
sobre una pantalla vacía.

**Confirmaciones** con `AlertController` (`window.confirm` aparece una sola vez en el repo, en el
kill-switch: es la excepción, no el patrón). El dueño va siempre en el mensaje —una confirmación
sobre dinero ajeno que no dice de quién es no es una confirmación— y un `input` de motivo que viaja
al `@Audit`.

**Aviso que hay que dar en pantalla, porque es contraintuitivo**: deshabilitar a alguien **no para
sus bots**. El worker no lee `disabled`; el motor sigue operando con su credencial. Va como
`ui-notice tone="warn"` permanente en la ficha, no dentro del diálogo, y la ficha muestra
«bots vivos: N».

---

## Verificación

**Unitarios** (`pnpm --filter api test`, sin infra):
- `session-revocation.service.spec.ts` — token anterior a la marca → revocado; posterior → no; **el
  borde del segundo** (revocar en `T.500`, `iat = T` → NO revocado); marca caducada por TTL; Redis
  caído con usuario ya conocido como revocado → sigue revocado; Redis caído desconocido → pasa y se
  registra **una** degradación.
- `jwt.strategy.spec.ts` — que se le pasa el `iat` del payload y no `Date.now()`.
- `token.service.spec.ts` — `revokeAll` mata familias **y** pone la marca.
- `admin-bots-command.spec.ts` — los dos permitidos pasan; `it.each` con los **once prohibidos**
  (`CANCEL_ALL_ORDERS` incluido) → `Forbidden` y `BotsService.command` **no llamado**; se delega con
  el `ownerId` como primer argumento y `requestedBy: admin.id`.
- `bots-command-actor.spec.ts` (en `modules/bots/`, obligatorio por CLAUDE.md) — regresión del camino
  normal carácter a carácter, y que el bus lleva `bot.user_id`.
- `admin-guards.spec.ts` — `Reflect.getMetadata(ROLES_KEY, Clase)` en los dos controladores. Es el
  test que hace falsa la frase «se me olvidó el decorador».
- `admin-users.service.spec.ts` — `JSON.stringify(resultado)` no contiene `google_sub`, `enc_*`,
  `link_code`, `chat_id` ni `external_ref`; `disable` llama a `revokeUser` una vez; auto-bloqueo
  (uno mismo, último ADMIN) → 409.
- `bots-sse.spec.ts` — `dropUser` cierra todas las del usuario y ninguna de otro.

**E2E** (`pnpm infra:up` + `pnpm --filter api test:e2e`), bloque nuevo en
[isolation.e2e-spec.ts](apps/api/test/isolation.e2e-spec.ts) — el helper `crearUsuario` gana un
parámetro `role`:
- `it.each` sobre las ~16 rutas: USER → 403, sin token → 401.
- `GET /admin/bots` como admin **sí** ve el bot de Alicia (es la prueba de que la consola cruza
  usuarios); el test existente sigue probando que Bruno no.
- `PANIC` / `CANCEL_ALL_ORDERS` / `START` → 400 y `botCommand.count` sigue en 0.
- `PAUSE` → 200, `requested_by === admin.id` (no el de Alicia), evento `WARN` con «soporte».
- Revocación: token válido → 200; `revokeAll` → **el mismo token** → 401; y el camino sin matar
  familias → refresh funciona → token nuevo → 200.
- `PATCH /admin/users/:id` → 404 y `{ role: 'ADMIN' }` en el cuerpo → 400 (`forbidNonWhitelisted`).
- Añadir `cache.del` de `auth:revoked:*` al `afterAll`.

**Sin aserciones sobre `activity_log` en el e2e**: dependen de `AUDIT_LOG_ENABLE`.

**App**: `pnpm --filter app build` (es quien ejecuta `strictTemplates` y los presupuestos de estilo)
y `pnpm --filter app lint`. Mantener cada `styles:[...]` por debajo de ~3 KB; si el detalle admin se
acerca a 6 KB es señal de que está reimplementando `bot-detail`.

**Manual**, con la infra levantada: promover una cuenta a ADMIN por SQL, recorrer las cinco
pantallas, pausar un bot **simulado** propio desde el panel y comprobar en la otra sesión que el
aviso llega al instante y que `requested_by` es el admin. Nada contra bots reales.

En Windows, jest desde Git Bash. `pnpm build:packages` antes de arrancar api/worker; `pnpm prisma:migrate`
para el índice.

---

## Orden de commits (rama `spec/033-consola-de-administracion`)

1. `specs/033-consola-de-administracion/` — es lo único que autoriza el índice en Prisma y el cambio
   en `bots.service.ts`.
2. `CacheService.isReady` + `getOrThrow` (aditivo, nadie cambia).
3. `SessionRevocationService` + spec. Aislado, sin cambiar comportamiento todavía.
4. `TokenService.accessTtl` + `revokeAll` delegando + spec.
5. `JwtStrategy` async + `iat` + comentario reescrito + spec. **Aquí se toca el camino caliente**, va solo.
6. `BotsSseService.dropUser` + canal `AUTH_REVOKED` + spec.
7. `BotsService.command()`: `requestedBy`, severidad, `userId` del dueño en el bus — con
   `bots-command-actor.spec.ts` **escrito primero, fallando**. El otro commit delicado, también solo.
8. DTOs + `AdminUsersService` + controlador + specs.
9. `AdminBotsService` (lecturas con `ownerOf`) + controlador + specs.
10. Comandos de contención + `admin-bots-command.spec.ts` + aviso SSE al dueño.
11. `admin.module.ts`, registro en `app.module.ts`, `admin-guards.spec.ts`.
12. Migración `idx_bot_status_created`.
13. E2E.
14. App: `paging.ts` + servicios + rutas + índice + enlace de Cuenta (ya hay algo navegable).
15. App: Usuarios lista y ficha.
16. App: Bots lista y ficha + confirmaciones.
17. `.env.example` + compose + `pnpm check:env`.
18. `docs/`: qué ve un administrador, qué no puede hacer y por qué, el fail-open con Redis caído como
    «Limitación conocida», y que deshabilitar no para los bots.

Sin `push`.

## Riesgos

- **`AUDIT_LOG_ENABLE` apagado deja la consola sin bitácora.** Una consola de administración sin
  trazabilidad no debería existir; el spec exige la variable encendida.
- **`BotsService.detail()` devuelve `...bot`** (la fila cruda de Prisma). Hoy `bots` no tiene columnas
  sensibles, pero añadir una mañana la publica en dos sitios. Es preexistente y compartido con el
  endpoint de usuario: **hallazgo aparte**, no se toca aquí (cambiaría el contrato del endpoint actual).
- **`BigInt` revienta en el e2e y no en producción**: el parche de `main.ts:20` no corre en la suite.
  Convertir en los mappers.
- **Degradar un ADMIN por SQL le deja hasta 15 min de admin** salvo que se le revoquen las sesiones.
  Documentarlo, ya que el cambio de rol queda fuera de la UI.
- `@Throttle({ limit: 10, ttl: 60_000 })` en `POST /admin/bots/:id/commands`: no protege de un admin
  malicioso, pero acota una consola en bucle contra la bandeja de comandos.
