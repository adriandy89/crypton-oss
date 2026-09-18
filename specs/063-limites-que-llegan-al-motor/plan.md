# 063 — Plan

## Enfoque

Relectura periódica en el runner, con caché por usuario en el store. Es el mismo patrón que ya
resolvió el mismo problema para la ficha de mercado (`refreshMarketSpec`, `bot-runner.ts:3827`):
el dato se cargaba al adoptar y no se refrescaba jamás.

Alternativas descartadas:

- **Canal de bus desde la API al guardar los límites.** Inmediato, pero se pierde si el worker no
  está escuchando en ese instante: Redis aquí es aviso, no bandeja. Añade un canal que mantener para
  ganar cincuenta segundos.
- **Releer en cada tick sin caché.** Una consulta por bot cada quince segundos para leer una fila
  que casi nunca cambia.
- **Reanudar solo el bot al desaparecer la causa.** Contra el diseño: el motor no pone a operar lo
  que el usuario no pidió.

El refresco va cada 4 ticks (un minuto con el latido por defecto), no cada 40 como la ficha de
mercado: diez minutos es demasiado para un tope de riesgo. La caché de 20 s hace que N bots del
mismo usuario compartan la lectura.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `apps/worker/src/engine/bot-store.ts` | `riskGuards(userId, {fresco})` con caché por usuario; el mapeo de `risk_limits` a `RiskGuards` vive aquí y solo aquí. `ultimoMotivoDeRiesgo(botId)` para recuperar la marca tras un relevo | `bot-store.spec.ts` |
| `apps/worker/src/engine/engine.service.ts` | La adopción usa `store.riskGuards(userId, {fresco:true})` en vez de consultar y mapear a mano | los del runner, indirectamente |
| `apps/worker/src/engine/bot-runner.ts` | `guards` mutable; `refreshGuards()`; motivo caducado con marca `motivoDeRiesgoPuesto`; evento `RISK_GUARD_CLEARED` | `bot-runner.spec.ts` |
| `apps/app/src/app/core/utils/labels.ts`, `shared/chart/bot-overlay.ts` | Etiqueta del evento nuevo | typecheck de la app |
| `apps/app/src/app/features/account/risk.page.ts` | La frase dice el plazo real | — |
| `docs/riesgo-y-liquidacion.md`, `docs/comandos-guardas-y-eventos.md` | El plazo real y el evento nuevo | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, build, tests, lint | Verde o rojos conocidos anotados |
| 1 | Tests que fallan primero: subir el tope no libera, bajarlo no muerde, el RESUME rebota | Rojos por el motivo declarado |
| 2 | `BotStore.riskGuards` con caché, y la adopción usándolo | Fase 1 en verde salvo lo del motivo caducado |
| 3 | `guards` mutable y `refreshGuards()` en el tick | R-1 a R-4 en verde |
| 4 | El motivo caducado: marca, limpieza, evento, y su recuperación tras un relevo | R-5 y R-6 en verde |
| 5 | App y documentación | Etiqueta puesta, guías al día |
| 6 | Cierre: índice de specs, memoria | Estado `hecho` |

## Verificación

```bash
pnpm build:packages
pnpm --filter worker test      # desde Git Bash, no PowerShell
pnpm test                      # todo, sin e2e
pnpm lint
```

A mano, con `make infra`, `make api`, `make worker` y un bot **simulado**:

1. Bajar `maxLeverage` por debajo del apalancamiento del bot → se pausa con su motivo en ~1 min,
   sin tocar el bot.
2. Subirlo de nuevo → en ~1 min desaparece el aviso rojo de la tarjeta y aparece
   `RISK_GUARD_CLEARED`; el bot sigue **pausado**.
3. Reanudarlo → queda en `RUNNING` y no rebota.
