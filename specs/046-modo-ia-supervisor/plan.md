# 046 — Plan

## Enfoque

**El supervisor vive en `apps/api`.** El argumento que decide es uno: `BotsService.updateConfig`
(`apps/api/src/modules/bots/bots.service.ts:977`) es el único camino de escritura seguro, y concentra
en ciento treinta líneas la reinyección de campos COLD, el `diffConfig`, la guarda de reshape con
inventario, la confirmación WARM, `validate()`, `assertWithinLimits` y la transacción de revisión,
evento y aviso al worker. Desde el worker habría que llamarlo por HTTP o reimplementarlo, y un
segundo camino de escritura acaba perdiendo la comprobación de riesgo — no el primer día, pero sí el
día que alguien toque uno de los dos y no el otro.

Tres razones más, todas verificadas contra el código:

- `apps/worker/package.json` no depende de `apps/api`, así que ponerlo en el worker obliga a mudar
  `sanitize.ts`, `build.ts`, `market-features.ts`, `prompt.ts` y el cliente de OpenRouter a un
  paquete compartido, y a refactorizar `RiskService`. Eso toca el asesor que hoy está en producción.
- Meter una llamada de red ajena de veinticinco segundos en el proceso que descifra claves y firma
  (invariante 8) es superficie nueva en el peor sitio posible.
- El expediente ya está en la API: `MarketDataService.features()` cachea las dos series de velas
  —incluida la ausencia— y `BotsService.get()` ya construye casi el expediente entero, con los
  descriptores pasados por `camposEfectivos` «para que la pantalla de ajustes sepa qué puede
  cambiarse en caliente».

**Alternativas descartadas**, cada una en una línea:

- *El supervisor en el worker*: gana el estado vivo en RAM y Telegram en el mismo proceso, pero paga
  con el refactor de cinco ficheros, un segundo camino de escritura y un LLM dentro del motor.
- *El modelo emite perillas absolutas* (como el asesor): no sirve, porque `buildConfig` no es
  invertible y la configuración de un bot de tres semanas no dice con qué perillas nació.
- *El modelo emite parámetros con rangos en el esquema*: prohibido por la doctrina de `prompt.ts`, y
  con razón: `minimum`/`maximum` no los soportan todos los proveedores y OpenRouter enruta.
- *Telegram enviado desde la API con su propio cliente*: duplicaría la política de preferencias, la
  agrupación y el caudal, y el sondeo tendría que seguir en el worker igualmente porque `getUpdates`
  es de consumidor único.
- *Una tabla de buzón para las notificaciones*: entrega garantizada a cambio de una tabla, un sondeo
  y una purga nuevos, para decenas de mensajes al día. El bus ya existe y su pérdida ocasional es
  aceptable porque el estado auténtico vive en `bot_events`.

## El contrato con el modelo: desplazamientos, no valores

La doctrina de `apps/api/src/modules/advisor/prompt.ts` se conserva y se aprieta una vuelta más.
Allí el modelo emite **perillas**; aquí emite **desplazamientos sobre las perillas que el bot ya
tiene**. Tres razones, y ninguna es estética:

1. **`buildConfig` no es invertible.** La configuración de un bot que lleva tres semanas —tocada a
   mano, reparada por acoplamientos, ajustada por el capital— no dice con qué perillas nació. Sin un
   punto de partida guardado no hay desde dónde desplazarse, y por eso las perillas de referencia
   viven en `bot_ai_settings.knobs`, sembradas con `defaultKnobs` al activar el modo.
2. **Un desplazamiento acotado a ±2 bandas es una cota dura de conducta.** Por mucho que el modelo se
   equivoque, no puede saltar de prudente a apalancamiento máximo en una revisión. Con perillas
   absolutas sí podría.
3. **Resuelve de raíz el problema de los campos de carácter.** `build.ts:506` hace
   `limitAction: k.profile === 'PRUDENTE' ? 'CLOSE_ALL' : 'PAUSE_ENTRIES'`. Si el modelo eligiera
   otro perfil, ese campo pasaría de «deja de entrar al llegar al límite» a «cierra la posición» — y
   como `limitAction` es `HOT`, ningún filtro de mutabilidad lo detendría. Con el perfil congelado,
   los campos que `buildConfig` deriva de él son estables **por construcción**, y basta una aserción
   de test en lugar de una lista blanca que alguien tendría que mantener.

El vocabulario, todo enumerado:

```
ACCIONES    = ['MANTENER', 'AJUSTAR', 'AVISAR']
MOVIMIENTOS = ['MUCHO_MENOS', 'MENOS', 'IGUAL', 'MAS', 'MUCHO_MAS']   // -2 .. +2
CONFIANZAS  = ['BAJA', 'MEDIA', 'ALTA']
```

`AVISAR` existe para que el modelo pueda decir «esto que lo mire una persona» sin pedir un cambio:
sus desplazamientos se ignoran y solo se notifica el motivo. No hay `CONTENER`: el usuario dejó la
contención fuera del alcance, así que el supervisor no emite ni un comando.

El esquema JSON exige todas las claves en `required` y `additionalProperties: false` en cada objeto.
No es una precaución de manual: un campo opcional o un `oneOf` rompe el modo estricto en unos
proveedores y en otros no, y el proveedor lo elige el enrutador. Es el mismo fallo intermitente que
`provider: { require_parameters: true }` ya existe para evitar en el asesor. Y la forma se valida en
`parse()` aunque el modo estricto la prometa, por lo mismo: la promesa la cumple el proveedor.

`MOVIMIENTOS` y las bandas se importan de `advisor/build.ts`; no se redeclaran. Dos contratos con las
mismas bandas derivando por separado es una avería con fecha de caducidad.

## La traducción determinista

En `apply.ts`, pura y sin Nest, como `sanitize.ts`. Se parte de la configuración **vigente**, no de
la generada: la del bot es la verdad y la generada es solo una propuesta.

1. `aplicarDesplazamientos(knobs, ajustes)` vía `shiftBand`, con tope en los extremos.
2. **Con inventario abierto** (`filledLevelIndexes.length > 0`) solo se honran los desplazamientos
   que bajan el riesgo; el resto se fuerza a `IGUAL`. Es el mismo criterio que `enforceCouplings`:
   se repara siempre hacia menos riesgo.
3. `buildConfig(kind, knobsNuevas, ctx)` con el capital fijado desde el bot vivo.
4. `camposEfectivos(fields, vigente, market)` — los campos activos dependen de la configuración y del
   mercado, así que no vale `meta.fields` en crudo.
5. **La fusión conservadora**: partiendo de `{ ...vigente }`, solo se pisan los campos del descriptor
   con `mutability !== COLD` que `buildConfig` haya producido. Todo lo demás conserva su valor: los
   COLD, los que no están en el descriptor y los que no se generaron. Y se refijan explícitamente
   `exchangeAccountId`, `symbol`, `direction` y `totalInvestment`, porque `buildConfig` los escribe
   incondicionalmente y ninguno es asunto del supervisor.
6. `coerceConfig` —con `vigente` de base, no `strategy.defaults()`— y `enforceCouplings`; **y la
   fusión otra vez**, porque la reparación puede tocar campos que en alguna estrategia son COLD.
7. Tope propio: el apalancamiento no sube más de un punto por decisión.
8. `validate()` decide: un solo `ERROR` y se descarta. **No se repara, no se reintenta** — insistir
   sobre un validador que no converge es como se llega al tiempo de espera. Después `preview()`, que
   es lo único que detecta violaciones de tick, paso y notional mínimo del venue.
9. `diffConfig`: `NONE` no escribe revisión; `COLD` es un fallo nuestro y se registra como `ERROR`;
   `reshapes` con inventario se descarta aquí, antes de que `updateConfig` lance.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `apps/api/src/modules/supervisor/apply.ts` | **nuevo**, puro: desplazamientos a configuración candidata | `apply.spec.ts` |
| `apps/api/src/modules/supervisor/decision.ts` | **nuevo**, puro: esquema, prompts, versión del contrato | `decision.spec.ts` |
| `apps/api/src/modules/supervisor/dossier.ts` | **nuevo**, puro: expediente, render y huella cuantizada | `dossier.spec.ts` |
| `apps/api/src/modules/supervisor/supervisor.service.ts` | **nuevo**: puerta, cupo, decidir, aplicar o proponer | `supervisor.service.spec.ts` |
| `apps/api/src/modules/supervisor/supervisor.scheduler.ts` | **nuevo**: cron con cerrojo y suscripción al bus | `supervisor.service.spec.ts` |
| `apps/api/src/modules/supervisor/supervisor.policy.service.ts` | **nuevo**: activar y desactivar, con la frontera del 033 | `supervisor.policy.spec.ts` |
| `apps/api/src/modules/admin/admin-ai.controller.ts` | **nuevo**: la superficie HTTP con `@Roles('ADMIN')` | `admin-guards.spec.ts`, `supervisor.policy.spec.ts` |
| `apps/api/src/modules/advisor/openrouter.client.ts` | método `revisar()` con modelo e interruptor propios | `openrouter.client.spec.ts` |
| `apps/api/src/modules/advisor/build.ts` | exportar `shiftBand` | `apply.spec.ts` |
| `apps/api/src/modules/bots/bots.service.ts` | `updateConfig` acepta `opts.appliedBy` | `supervisor.service.spec.ts` |
| `apps/api/src/libs/bus/bus.service.ts` | `entregaForzada` en `BusMessage` | — (tipo) |
| `apps/worker/src/libs/bus/bus.service.ts` | lo mismo: los dos ficheros son gemelos | — (tipo) |
| `apps/worker/src/notifications/notifier.service.ts` | escotilla de origen, preferencia `ai`, eventos nuevos | `notifier.service.spec.ts` |
| `apps/worker/src/notifications/telegram-client.ts` | teclados, `answerCallbackQuery`, `callback_query` | `notifier.service.spec.ts` |
| `apps/worker/src/notifications/telegram-poller.service.ts` | rama de callback, autorización y vuelta por el bus | `ai-approval.spec.ts` |
| `apps/worker/src/engine/retention.service.ts` | purga del expediente y cierre de propuestas vencidas | `retention.service.spec.ts` |
| `apps/api/src/modules/admin/admin-bots.service.ts` | el evento de `ADMIN_COMMAND`, con severidad y mensaje | `notifier.service.spec.ts` |
| `packages/db/prisma/schema.prisma` + migración | enum `AiMode`, `bot_ai_settings`, `bot_ai_decisions` | — (migración) |
| `packages/shared/src/enums.ts` | `AiMode` calcado valor a valor | `enums.spec.ts` si existe |
| `apps/app/src/app/features/admin/` | panel del Modo IA y cola de decisiones | typecheck |
| `.env.example` (api), `docker/.env.example`, `docker/docker-compose.yml` | las variables nuevas | `pnpm check:env` |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama, spec, línea base | `build:packages`, `test`, `lint` y `check:env` con su resultado anotado |
| 1 | Telegram: `entregaForzada`, preferencia `ai`, y el arreglo de `ADMIN_COMMAND` | Test de `ADMIN_COMMAND` que falla antes y pasa después; el camino sin marca no cambia |
| 2 | Esquema: enum, dos tablas, migración, `AiMode` en `shared` | La migración corre en limpio; `prisma generate`; typecheck de las dos apps |
| 3 | `apply.ts` — el corazón, puro | Matriz exhaustiva en verde, sin una sola salida muda |
| 4 | `decision.ts` y `OpenRouterClient.revisar()` | El esquema no tiene ni un `minimum`; asesor y supervisor independientes |
| 5 | `dossier.ts` | Ni dinero ni texto libre en el prompt renderizado |
| 6 | Política y superficie de administración | La frontera del 033 se hace cumplir en los tres sitios |
| 7 | El lazo, solo en `MANUAL`: escribe propuestas, no aplica nada | Filas con expedientes sensatos y ni un cambio de configuración |
| 8 | Modo automático: aplicar, cuotas, cortacircuitos, `FORCE_MANUAL` | La revisión producida es idéntica en forma a una de `updateConfig` |
| 9 | Botones de Telegram y la vuelta por el bus | Aprobar desde el móvil sobre un bot simulado |
| 10 | La app: panel en la ficha del bot y cola de decisiones | Recorrido manual del usuario |
| 11 | Cierre: `docs/administracion.md`, índice de specs, `CLAUDE.md`, memoria | Estado `hecho` |

El orden no es arbitrario. La fase 1 va primero porque arregla un defecto que existe hoy y porque
todo lo demás depende de que un aviso del supervisor pueda llegar a alguien. La fase 3 va antes que
la 4 porque la traducción determinista se puede probar entera **sin modelo**: si esa matriz no está
en verde, el contrato con el modelo da igual. Y el modo automático (fase 8) va después del manual
(fase 7) a propósito: primero se mira qué propondría el supervisor sin que pueda tocar nada.

## Verificación

```bash
pnpm build:packages            # OBLIGATORIO antes de api y worker: resuelven @crypton/* por dist/
pnpm test:strategies           # strategy-core
pnpm --filter api test
pnpm --filter worker test
pnpm test:backtest
pnpm lint
pnpm check:env                 # falla si una variable no esta en los tres sitios
pnpm prisma:migrate            # solo en la fase 2
```

Jest se ejecuta **desde Git Bash**, nunca desde PowerShell: allí `2>&1` falsea el código de salida.
Y tras tocar `packages/shared` o `strategy-core` hay que recompilar antes de pasar los tests del
worker, que consumen esos paquetes desde `dist`.

Recorrido manual de principio a fin, con `make infra` levantado:

1. Crear un bot **simulado** de market maker, o reutilizar uno.
2. Activar el Modo IA en `MANUAL` desde la consola de administración, con su motivo.
3. Forzar una revisión bajo demanda.
4. Comprobar que llega a Telegram un mensaje propio —no agrupado con otros— con dos botones.
5. Pulsar «Aplicar» y ver la revisión nueva en el historial de configuración del bot, con el
   `applied_by` del supervisor y el diff campo a campo.
6. Pulsar el mismo botón otra vez y comprobar que no aplica una segunda.
7. Cambiar la configuración a mano y comprobar que una propuesta anterior queda caducada sin tocar
   el bot.

## Notas de implementación

- **CRLF.** El árbol está en CRLF y los ficheros creados con herramientas de escritura salen en LF:
  hay que detectar el fin de línea antes de cada sustitución.
- **`callback_data` admite 64 bytes.** Un identificador de 32 caracteres más el verbo cabe de sobra;
  no hay que meter nada más ahí, y desde luego no el identificador del bot.
- **`MarketDataModule` ya importa `BotsModule`.** El módulo nuevo necesita los dos, así que no puede
  exportar nada que `BotsModule` consuma o se crea un ciclo.
- **`AdminModule` no importa `ExchangeAccountsModule` a propósito**: es la puerta a descifrar una
  clave de firma. El módulo del supervisor respeta la misma regla — necesita mercados, riesgo y
  bots, nunca adaptadores.
- **El `default` de `buildConfig` devuelve `{}`**, pero las cuatro estrategias del alcance tienen
  generador propio, así que ninguna cae ahí. Conviene un test que lo fije por si alguien amplía el
  alcance sin darse cuenta.
