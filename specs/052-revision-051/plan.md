# 052 — Plan

## Enfoque

Cuatro grupos, cada uno con su commit, en orden de dependencia: primero la traducción (donde están
cinco de las seis Altas y la cota que arregla tres hallazgos de golpe), luego el servicio, luego el
expediente y el prompt, y al final documentación y verificación. Cada corrección empieza por el test
que falla.

## La pieza central: la cota relativa

Un solo cambio arregla F-02, F-03 y F-11:

```
TOPE_RELATIVO_POR_PASO = 0,25
tope = |vivo| × 0,25 × escalones     (escalones = 1 o 2, lo que pidió el modelo)
nuevo = min(max(nuevo, vivo − tope), vivo + tope)
```

Se aplica **antes** del acotado al descriptor, en `trasladarCampo`, tanto a los aditivos como a los
proporcionales. Tres consecuencias buscadas:

- Un delta calculado sobre números del generador no puede aplastar un valor vivo mucho menor
  (F-02), ni multiplicar un importe (F-03).
- **De cero no se sale**: el 25 % de cero es cero, así que un campo apagado por su dueño sigue
  apagado (F-11). Queda documentado como regla, no como efecto colateral.
- Un bot muy lejos de lo que el generador propondría tarda varias revisiones en llegar. Es lo que
  significa «ajuste relativo», y la lista de efectos y el prompt lo cuentan.

`trasladarCampo` gana un parámetro `escalones`; `trasladarDelta` lo recibe de `decidirCambio`, que
lo saca del mayor movimiento pedido.

## Fase 1 — Traducción (F-01, F-02, F-03, F-04, F-05, F-11, F-12)

`apply.ts`:

- `BLOQUEADOS_CON_POSICION.TREND_FOLLOW` += `atrStopMultiplier` (F-01).
- Cota relativa por escalón (F-02, F-03, F-11).
- Decimales del importe desde el campo **efectivo**: `max(decimales del vivo, del mínimo, del paso,
  2)` (F-04).
- `PosicionViva.medidaHace` (ms) y exigencia de frescura (2 min) para bajar el tope de un market
  maker que cierra (F-05).
- `camposInertes(kind, config)`: con `layers ≤ 1`, fuera `layerDistanceMultiplier` y
  `layerSizeMultiplier` (F-12).

## Fase 2 — Servicio (F-06, F-07, F-09, F-10, F-13)

- `bots.service.ts`: `UpdateConfigOptions.expectedVersion`. Se comprueba al leer la revisión vigente
  y **otra vez dentro de la transacción** (`updateMany` con la versión en el `where`; si no actualiza
  una fila, `ConflictException` con `reason: 'STALE_VERSION'`). Sin la opción, todo igual (F-06).
- `supervisor.service.ts`:
  - pasa `expectedVersion` y distingue el rechazo por versión: `CADUCADA`/`STALE`, sin `AI_FAILED`
    (F-06);
  - `warmPermitido` solo cuando la decisión se aplicaría sola (F-07);
  - `maxLeverageUsuario` sale de `RiskService.topeDeApalancamiento` (F-09);
  - `marcarRevisado(botId, huella, exito)` pone `failures: 0` con respuesta válida (F-10);
  - retirar las propuestas anteriores no puede tumbar el aviso (F-13).
- `risk.service.ts`: `topeDeApalancamiento(userId, inversión, market, opts)`, que es la misma cuenta
  que `assertWithinLimits` ya hace, extraída para poder consultarla antes.

## Fase 3 — Expediente, efectos y prompt (F-08, F-14, F-15, F-16, F-17, F-18)

- `apply.ts`: `movimientosConEfecto` prueba dos escalones cuando uno no mueve nada, y lo marca
  (F-08).
- `dossier.ts`: latente con banda muerta (F-14); aviso fuera de la huella (F-15); `estadoFresco` y su
  línea (F-16); `TICK_SLOW`, `LEVERAGE_SKIPPED` y `POSITION_MODE_SKIPPED` fuera de las incidencias
  (F-18); rótulo de la propuesta caducada (F-17).
- `supervisor.service.ts`: el historial pide también `CADUCADA` con `PLAZO` (F-17).
- `decision.ts`: `PROMPT_VERSION_REVISION = 3`, con los dos escalones, el ajuste relativo, el cero
  que no se enciende y la propuesta que nadie aprobó.

## Fase 4 — Documentación y verificación

- `docs/administracion.md` §Modo IA: la cota relativa y lo que implica.
- `specs/README.md`: fila del 052 y cierre del 051.
- Verificación: `pnpm build:packages`, `pnpm --filter api exec jest`, `pnpm lint`, `pnpm check:env`,
  `pnpm --filter strategy-core test` (no se toca, pero la API depende de sus tipos) y mutaciones: una
  por salvaguarda nueva, cada una tiene que tumbar su test.

## Ficheros

**Se tocan**: `apps/api/src/modules/supervisor/{apply,dossier,decision,supervisor.service}.ts` y sus
`.spec.ts`; `apps/api/src/modules/bots/bots.service.ts` y su spec; `apps/api/src/modules/risk/
risk.service.ts` y su spec; `docs/administracion.md`; `specs/README.md`.

**No se tocan**: `packages/db/prisma`, el worker, `strategy-core`, `shared`, `exchange-core`, la app.

## Despliegue

Decidido por el usuario: merge a `main`, push a origin y redespliegue de la API en producción con el
procedimiento de siempre (`git pull --ff-only` + `docker compose up -d --build api`), comprobando el
`dist` antes de tocar datos. El worker no se toca. Después, al fork OSS con commit local.
