# 051 — Plan

## Enfoque

Tres frentes, en este orden, porque cada uno se apoya en el anterior:

1. **Que la traducción haga lo que dice** (`apply.ts`). Es lo único de este spec que puede cambiarle
   la conducta a un bot, así que va primero y con la matriz más dura.
2. **Que el servicio no mienta sobre lo que aplicó** (`supervisor.service.ts`): perillas guardadas,
   `applied: false`, cupo, enfriamiento WARM y estrangulador de avisos.
3. **Que el expediente diga la verdad** (`dossier.ts`, `decision.ts`): incidencias reales, market
   makers medidos por pares, efectos de cada movimiento, huella en tramos y prompt v2.

**El delta se traslada, no se copia.**

- Por cada campo que difiere entre `buildConfig(perillas de antes)` y `buildConfig(perillas de
  después)`:
  - los numéricos se desplazan sobre su valor vivo lo mismo que se desplazan en la generada
    (aditivo, redondeado al paso);
  - los importes, en proporción y redondeando hacia abajo;
  - enumerados y booleanos, solo si el valor vivo coincide con el generado de antes.
- Se descarta el campo que quedaría igual o se movería al revés.
- Lo que nadie mueve no se re-cuantiza: la configuración entera ya no pasa por `coerceConfig`.

**Las guardas miran campos, no perillas.** Qué perilla sube el riesgo depende de la estrategia: la
cobertura de una escalera y la de un market maker van en sentidos opuestos. Así que con posición
abierta se comprueba el resultado:

- una tabla de campos de riesgo por estrategia, cada uno con su sentido arriesgado;
- los campos que pueden disparar un cierre;
- en un MM que no pausa entradas, un tope de posición que no baje de la exposición con holgura.

**Alternativas descartadas:**

- **Todo aditivo:** en importes deja el tope en 1 (H-05 b).
- **Proporcional en todo:** con bases que el generador acota a 1 multiplica la distancia por 3 en un
  paso.
- **Mantener el recorte por perillas corrigiendo la cobertura:** sigue dependiendo de la semántica
  de cada perilla en cada estrategia, que es justo lo que falló.
- **Silenciar los avisos en el notificador:** el problema no es el canal, es lo que el modelo lee.
- **Subir el tope de campos:** con valores absolutos seguiría pudiendo mover un campo al revés.

## Ficheros afectados

| Fichero | Qué cambia | Tests |
|---|---|---|
| `apps/api/src/modules/supervisor/apply.ts` | `trasladarCampo`/`trasladarDelta`, `guardaDePosicion` con `CAMPOS_DE_RIESGO` y `BLOQUEADOS_CON_POSICION`, tope de 2 perillas, acoplamiento de capas, `movimientosConEfecto`. Fuera `recortarConInventario` y `MAX_CAMPOS_POR_CAMBIO`. | `apply.spec.ts`: matriz a mano, casos con nombre, tablas |
| `apps/api/src/modules/supervisor/supervisor.service.ts` | Estrangulador de `AVISAR`, huella tras respuesta válida, cupo del bot primero, posición en el contexto, `aplicar` que distingue `applied`, guarda perillas y `last_apply_at`, enfriamiento WARM, expediente con grupos por severidad, stats MM, realizado 24 h, historial y aviso vigente. | `supervisor.service.spec.ts` |
| `apps/api/src/modules/supervisor/dossier.ts` | `incidencias()`, bloque MM, liquidación, historial sin eco, efectos, huella `sha1` en tramos. | `dossier.spec.ts` |
| `apps/api/src/modules/supervisor/decision.ts` | Prompt v2 y `PROMPT_VERSION_REVISION = 2`. Mismo esquema. | `decision.spec.ts` |
| `apps/api/.env.example`, `docker/.env.example`, `docker/docker-compose.yml` | `AI_AGENT_ADVICE_COOLDOWN_H`. | `pnpm check:env` |
| `scripts/check-env.mjs` | Detecta `this.num('X', …)`. | `pnpm check:env` |
| `docs/administracion.md` | Sección del Modo IA. | Lectura |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Contención en producción (pausa de tres días) y línea base: rama, build, tests, lint, `check:env` | Pausa verificada con `SELECT`; línea base anotada en `tasks.md` |
| 1 | Traducción: traslado del delta, guardas de posición, tope de perillas, efectos | `apply.spec.ts` verde, con la matriz a mano y los casos de CA-2 a CA-4 |
| 2 | Servicio: aplicar, cupo, enfriamiento WARM, estrangulador, huella tras respuesta | `supervisor.service.spec.ts` verde (CA-7) |
| 3 | Expediente y prompt v2 | `dossier.spec.ts` y `decision.spec.ts` verdes (CA-5, CA-6) |
| 4 | Entorno y documentación | `check:env` ve la variable nueva; guía al día |
| 5 | Mutaciones y verificación completa | CA-1 y CA-8 |
| 6 | Merge, push, despliegue de la API, corrección de datos y vigilancia | CA-9 |
| 7 | Cierre: índice de specs, memoria | Estado `hecho` (CA-10 del usuario) |

## Verificación

**Desde Git Bash, nunca desde PowerShell:**

```bash
pnpm build:packages
pnpm --filter api test -- src/modules/supervisor      # durante el trabajo
pnpm test                                             # al final, todo
pnpm lint
pnpm check:env
```

- La API no tiene dependientes entre los paquetes, así que no hacen falta los tests de `worker`,
  `backtest` ni el typecheck de la app. `pnpm test` los corre igualmente.
- **Mutaciones:** un script en el scratchpad rompe cada salvaguarda nueva, corre su test con
  `--forceExit` y restaura. Comprueba en cada caso que la mutación se aplicó (el árbol es CRLF) y
  que el test compiló y cayó por el motivo esperado, no con 0 tests.

**Producción, tras desplegar, en solo lectura:**

- las decisiones nuevas llevan `prompt_version = 2`;
- los `AI_ADVICE` por bot desde el despliegue;
- el expediente guardado del market maker V2 de LIT: bloque de market maker y efectos, sin `AI_` ni `FILL` en
  las incidencias;
- los logs de la API, sin «sin cupo» sistemático.
