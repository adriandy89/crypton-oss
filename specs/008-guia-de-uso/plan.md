# 008 — Plan

## Enfoque

Documentar lo que el código hace hoy, con números que salen del propio código, y decir de frente lo
que no hace. Se reutiliza la espina de `docs/market-maker.md` (que ya funciona) y el contenido ya
escrito de las guías in-app (`apps/app/src/app/core/content/*.guide.ts`), completado leyendo `plan()`
de cada estrategia. Los ejemplos no se calculan a mano: un script en el scratchpad ejecuta
`validate()` y `preview()` del `dist` contra los fixtures de `venue-markets.ts` y sus cifras se pegan.

Alternativas descartadas:

- Una sola guía larga: mezclaría narrativa con tablas de referencia que las siete guías necesitan
  enlazar por ancla.
- Generar las guías desde `*.guide.ts` con un script: la guía in-app está pensada para un panel de
  ayuda, no para leer de principio a fin, y varias de sus frases son justo las que hay que corregir.
- Corregir el código en vez de documentar la limitación: eso son los specs 009+, con test y decisión
  del usuario; la guía no puede esperar a que se cierren treinta hallazgos.
- Configuraciones «pegables» en JSON: ninguna pantalla acepta JSON (`SharedConfig` solo lo consume
  `POST /leaderboard/copy`); se pone la columna «% del capital» para escalar el ejemplo.

## Ficheros afectados

| Fichero | Qué cambia | Verificación |
|---|---|---|
| `docs/README.md` (nuevo) | índice, convenciones, mantenimiento | `comprobar-enlaces.cjs` |
| `docs/{grid-classic,neutral-grid,tdca,martingale,gridmart}.md` (nuevos) | guía completa por estrategia | `verificar-ejemplos.cjs`, `comprobar-parametros.cjs` |
| `docs/{buenas-practicas,riesgo-y-liquidacion,venues-y-minimos,simulacion-y-backtest,comandos-guardas-y-eventos}.md` (nuevos) | transversales | `comprobar-enlaces.cjs`, lectura cruzada con el código citado |
| `docs/market-maker.md`, `docs/market-maker-v2.md` | §«Limitaciones conocidas»; frases de «techo duro» (`:164`) y «una vez armado» (`:92`) | lectura |
| `README.md` | «seis» → «siete» (`:188`); «once» → «trece» con `REPAIR` y `ADJUST_MARGIN` (`:220-223`); enlace a `docs/` en el árbol y en «Estrategias»; enlace a `buenas-practicas.md` en «Pruebas» | `comprobar-enlaces.cjs` |
| `CLAUDE.md` | «Dónde leer más» → `docs/README.md`; regla `grep F-NN docs/` en SDD | lectura |
| `apps/app/src/app/core/utils/field-labels.ts` | `maxNotionalCapHelp`, `cooldownMinutes`, `reanchorOnDriftHelp`, `referencePriceHelp`, `positionModeHelp` (×2), `maxDynamicSpreadBpsHelp`, `activationModeHelp` | `pnpm --filter app build`, lint |
| `apps/app/src/app/core/content/{common-options,ladder-options,neutral-grid.guide,gridmart.guide,martingale.guide,market-maker.guide,market-maker-v2.guide}.ts` | fichas que hoy contradicen al código | ídem |
| `specs/README.md` | fila 008 | — |
| `specs/008-guia-de-uso/informes/*.md` | revisión de estrategias (la comparativa con la competencia queda en el repositorio privado) | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama desde `main` limpia; `pnpm build:packages`; baterías de tests, lint, `check:env`, typecheck de la app | verde (anotado en `tasks.md`) |
| A | Revisión: script de coherencia (C1-C8), tabla de estado por estrategia → `informes/revision-estrategias.md` | informe escrito |
| 1 | Script de ejemplos; corregir los ejemplos en rojo | `0 ejemplo(s) en rojo` |
| 2 | `riesgo-y-liquidacion.md`, `comandos-guardas-y-eventos.md` (anclas que usan las guías) | escritos |
| 3 | Guías: grid-classic → tdca → martingale → gridmart → neutral-grid | cada una pasa `comprobar-parametros.cjs` |
| 4 | `venues-y-minimos.md`, `simulacion-y-backtest.md`, `buenas-practicas.md`, `docs/README.md`; §5 y frases de los MM | enlaces en verde |
| 5 | README, CLAUDE.md, textos in-app | `pnpm --filter app build` en verde |
| 6 | Cierre: CA-1..CA-6, índice de specs, memoria | estado `hecho` |

## Verificación

```bash
pnpm build:packages
node <scratchpad>/verificar-ejemplos.cjs          # 0 ejemplo(s) en rojo
node <scratchpad>/coherencia-estrategias.cjs      # informe C1-C8
node <scratchpad>/comprobar-parametros.cjs        # H4 de cada guía == meta.fields
node <scratchpad>/comprobar-enlaces.cjs           # 0 enlaces rotos
grep -oh "F-[0-9][0-9]" docs/*.md | sort -u       # cada id existe en findings.md
pnpm --filter app build && pnpm --filter app lint
```

A mano: abrir el asistente de creación con la infra local, teclear cada configuración A/B/C y
comparar la vista previa con el bloque «Peor caso» de la guía (salvo F-88 y F-14, anotados).
