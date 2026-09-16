# 051 — Tareas

## Fase 0 — Contención y línea base

- [x] Producción: `paused_until = now() + 3 días` en los tres bots en Modo IA (2026-09-15 21:22 UTC,
      `UPDATE 3`, verificado con `SELECT` antes y después; al volver a mirar antes de desplegar, 0
      decisiones y 0 eventos `AI_*` desde la pausa)
- [x] Rama `spec/051-el-supervisor-que-solo-avisa` desde `main` limpio (`0d3ad2e`)
- [x] `pnpm build:packages`: verde
- [x] API: 41 suites, 5556 tests en verde. La primera pasada no corrió ni un test:
      `pnpm --filter api test -- --silent` le pasa `--silent` a jest como patrón de ruta («No tests
      found»). Se repitió con `pnpm --filter api exec jest --silent`
- [x] `pnpm lint`: verde, con los 3 warnings previos de la API
- [x] `pnpm check:env`: coherente

## Fase 1 — Traducción (H-05, H-06, H-08, H-15; R-9 a R-12) — `a632d52`

- [x] Tests: matriz de bots ajustados a mano (semilla fija, las cuatro estrategias, con la pasada con
      posición abierta); lit 12/14 → 14/16; MM 300/2000 → ≈200/≈1333,33; `RIESGO`, `CIERRE`,
      `DEMASIADAS_PERILLAS`; todo `IGUAL` con reparación pendiente; tablas de `trasladarCampo` (ida y
      vuelta exacta en aditivos, sin ganar dinero en importes) y `guardaDePosicion`; efectos
- [x] `trasladarCampo` / `trasladarDelta`: aditivo con redondeo simétrico, importes proporcionales
      hacia abajo, enumerados solo si el vivo coincide, sin `coerceConfig` de la config entera
- [x] `guardaDePosicion`, `CAMPOS_DE_RIESGO` (verificados contra los descriptores) y
      `BLOQUEADOS_CON_POSICION`
- [x] Tope de dos perillas y acoplamiento de capas (suelo 1,05 del generador)
- [x] `movimientosConEfecto`
- [x] Pasó a la primera (44 tests), así que se rompió cada salvaguarda a propósito (Fase 5)

## Fase 2 — Servicio (H-01, H-04, H-10, H-11, H-13, H-14; R-1, R-13 a R-15) — `ec7dad9`

- [x] Tests: aviso repetido (sin evento, sin bus, sin `SUPERSEDIDA`), TTL por variable, Redis caído,
      turno devuelto si la fila no se escribe, perillas y `last_apply_at` (también desde Telegram),
      `applied: false`, fallo posterior, WARM reciente (y aprobación humana exenta), cupo del bot
      antes que el global, huella tras fallo del modelo, posición del estado fresco
- [x] Estrangulador de `AVISAR`
- [x] `aplicar` reestructurado: el `try` solo envuelve `updateConfig`
- [x] Cupo del bot antes que el global
- [x] Enfriamiento WARM, leído de las decisiones `APLICADA` WARM
- [x] Huella guardada solo tras respuesta válida

## Fase 3 — Expediente y prompt (H-02, H-03, H-07, H-09, H-12; R-2 a R-8) — `ec7dad9`

- [x] Tests: fixture real de lit (importes cambiados), incidencias, liquidación, historial sin
      prosa, aviso una sola vez, bloque MM, efectos, huella (hash, ruido, régimen, reloj,
      incidencias, posición, efectos, aviso), tamaño, CA-5 del 046 con los importes nuevos
- [x] `incidencias()` y consulta por tipo y severidad
- [x] Bloque de market maker y realizado de 24 h
- [x] Liquidación e historial sin eco
- [x] Efectos en el expediente
- [x] Huella `sha1` en tramos
- [x] Prompt v2 (y su test de frases)

## Fase 4 — Entorno y documentación (R-16, R-17) — `ced1325`, `246bdbd`

- [x] `AI_AGENT_ADVICE_COOLDOWN_H` en `apps/api/.env.example`, `docker/.env.example` y compose
- [x] `check-env.mjs` ve `this.num('X'`
- [x] `docs/administracion.md` y el comentario de «cuatro parámetros» de `apps/api/.env.example`

## Fase 5 — Verificación

- [x] Mutaciones: **29 de 29 caen**, cada una en su test y con el resto saltado (script
      `mutaciones-051.cjs` en el scratchpad: aplica, corre `jest -t`, restaura y compara con una
      copia). Una salvaguarda no tiene mutación que la tumbe: la guarda de sentido de
      `trasladarCampo`, porque acotar al descriptor nunca invierte el sentido del delta. Es defensa
      sin camino que la active; se deja y se anota
- [x] API: 41 suites, **5625 tests** en verde (69 más que la línea base), con el test de arranque del
      049
- [x] `pnpm lint`: 0 errores. Cazó dos aserciones de tipo innecesarias en código nuevo, corregidas
      antes del commit; quedan los 3 warnings previos
- [x] `pnpm check:env`: coherente
- [x] `tsc --noEmit` de la API: solo los 2 errores previos en `advisor.spec.ts` y
      `bots-margin.spec.ts`, ficheros que este spec no toca y que jest compila sin diagnóstico
- [x] Criterios de aceptación CA-1 a CA-8, con test; CA-9 es de producción y CA-10 del usuario

## Fase 6 — Despliegue

- [x] Merge a `main` (`060cf9c`) y `push` a `origin` (`0d3ad2e..060cf9c`)
- [x] Servidor: `git pull --ff-only` a `060cf9c` y `docker compose ... up -d --build api`. Imagen de
      las 22:20 UTC del 2026-09-15; el job `migrate` salió limpio; `healthy` a las 22:21:23 y
      «Supervisor de IA activo» en el log. El worker no se tocó
- [x] Antes de tocar datos, comprobado que el `dist` desplegado lleva `AVISO_REPETIDO` y
      `PROMPT_VERSION_REVISION = 2`. Trampa: el primer `grep` abortó porque TypeScript compila a
      CommonJS con un `exports.PROMPT_VERSION_REVISION = ... = void 0;` al principio y el patrón
      cogió esa línea. Se repitió exigiendo `= 2;`
- [x] Datos (22:23 UTC): el market maker de BTC con las perillas de la decisión 80 (spread BAJA, cadencia ALTA)
      y su `last_apply_at`; los tres sin pausa y sin huella (`UPDATE 1` y `UPDATE 3`, con `SELECT`
      antes y después)
- [ ] Vigilancia de solo lectura (CA-9). Los tres bots tenían agotado el cupo de llamadas del día,
      así que la primera revisión con el modelo llega tras las 00:00 UTC

## Cierre

- [ ] Índice de `specs/README.md`
- [ ] Memoria
