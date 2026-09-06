# 021 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, dos commits (lo que relanza y lo que se
captura en el runner y el notificador; la salud, las escrituras best-effort, el código de salida y la
retención). Todo en `apps/worker` más el compose y su `.env.example`.

Decisiones de diseño tomadas aquí:

- **F-06**: `safely()` relanza `AUTH` y `THROTTLED` antes de mirar el mensaje, en vez de sacar el `place()` del
  reemplazo fuera de `safely()`: así la cancelación del reemplazo sigue protegida por la regex de «ya no
  existe» y las dos clases que importan llegan a `onTickError` por el mismo camino que desde `toPlace`.
- **F-07**: `catch` con registro en las tres promesas sueltas, no un manejador global que trague: el
  `unhandledRejection` de `main.ts` sigue existiendo para lo que no se haya previsto.
- **F-18**: la salud es una función pura (`health.ts`) para poder probarla sin levantar el motor; el dato de
  Redis es `client.isReady` del cliente del lease (sin él no se sostiene ningún lease). Las escrituras
  best-effort no se convierten en errores de tick —perder una marca de agua no justifica parar un bot—, solo
  dejan rastro. El código de salida distingue fatal (1) de señal (0); reiniciar por «unhealthy» es del
  orquestador.
- **F-40**: el `catch` va en el `cacheSet`, no en un `try` aparte, para que el resto del camino de éxito
  (reprogramar el sondeo) no cambie.
- **F-41**: se alinea el compose con el `.env.example` (encendido), no al revés: el incidente más grave del
  motor se registra en `activity_log`.
- **F-39**: solo los comandos **ejecutados** (`executed_at IS NOT NULL`), por lotes como las demás purgas; las
  revisiones de configuración se conservan porque son el historial y `bot.config_version` apunta a una fila.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `worker/src/engine/bot-runner.ts`, `notifications/notifier.service.ts` | `safely` relanza; `catch` en `acquireFairPrice` y en la suscripción | `bot-runner.spec.ts` | `ebfc5e0` |
| `worker/src/engine/{engine.service,health,lease.service,bot-store,command-inbox.service,retention.service}.ts`, `marketdata/price-source.service.ts`, `main.ts` | `evaluarSalud`, `redisReady`, `mudo()`, registro en el reclamo, código de salida, `purgeCommands`, `cacheSet` con `catch` | `health.spec.ts`, `retention.service.spec.ts`, `price-source.service.spec.ts` | `86b38ac` |
| `docker/docker-compose.yml`, `apps/worker/.env.example` | `AUDIT_LOG_ENABLE` a `true`; `RETENTION_COMMAND_DAYS` | `pnpm check:env` | `86b38ac` |

## Verificación

```bash
pnpm --filter worker test -- --forceExit && pnpm --filter worker lint && pnpm check:env
pnpm test && pnpm lint
```
