# 039 — Plan

## Enfoque

Dos capas, y en este orden: primero las funciones **puras** en `mm-shared` con sus tests
numéricos, y solo después el cableado. Así la aritmética queda fijada antes de que nadie pueda
confundir «el mando está mal» con «el mando está mal conectado».

### Decisiones que conviene no deshacer

**Dónde va cada corrección.** El microprecio y el desequilibrio van en el **ancla** —lo que se
congela en `quotedMid`—, no en el centro de cotización. Aplicarlos después de la congelación
movería los precios en cada tick sin recotizar, que es exactamente el defecto que el spec 029
arregló en `autoAdjustDistance`. El inventario y el funding van en el centro, como ya hacía el
sesgo de la V1.

**El signo del funding sale del funding, no del inventario.** `f > 0` son los largos pagando;
bajar el centro inclina el libro del bot hacia el lado que cobra, y eso vale igual estando largo
que corto. Mirar `q` habría dado la respuesta equivocada en dos de los cuatro casos.

**El castigo por markout entra antes del techo en la V2** y después del suelo en la V1. En la V2
la promesa «nunca cotizo más ancho de X» tiene que seguir valiendo; en la V1 no hay techo.

**Una sola eficiencia de Kaufman.** Estaba en la API y la iba a duplicar en `mm-shared`. Vive en
`shared` y la llaman las dos: son la misma pregunta sobre entradas distintas.

**Alternativas descartadas.** (a) Un único interruptor «modo inteligente»: esconde qué está
encendido justo cuando hace falta saberlo para leer la nota del bot. (b) Cambiar los umbrales
90/100 de la V2 ahora que tiene sesgo de inventario: es conducta de bots ajenos, y va con
decisión del usuario.

## Ficheros afectados

| Fichero | Qué cambia | Tests |
|---|---|---|
| `strategies/mm-shared.ts` | Siete funciones puras, `INTEL_FIELDS`, `INTEL_DEFAULTS`, `centroDeMercado`, `fundingAdverso`, Parkinson | `mm-inteligencia.spec.ts` |
| `shared/src/market-features.ts` | `eficienciaKaufman`, una sola vez | `market-features.spec.ts` |
| `strategies/market-maker.ts` · `market-maker-v2.ts` | Campos, cableado, `onFill` | `mm-inteligencia.spec.ts` |
| `shared/src/config-meta.ts` | El grupo `intelligence` | — |
| `apps/api/.../advisor/market-features.ts` | Llama a la función extraída | `advisor.spec.ts` (ya existía) |
| `apps/app/.../field-labels.ts`, `bot-create.page.ts`, `ui-strategy-help.component.ts` | El grupo nuevo y sus etiquetas | `ng build` |
| `apps/app/.../content/market-maker*.guide.ts` | Una entrada por mando (el tipo lo **exige**) | `ng build` |
| `docs/market-maker*.md` | Sección de microestructura | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base sobre `main` con 037 y 038 dentro | Verde |
| 1 | Funciones puras + tests numéricos | 34 tests nuevos |
| 2 | Campos compartidos, grupo nuevo, etiquetas | La app compila |
| 3 | Cableado en V1 y V2 | Los 367 de antes **siguen pasando**: R-10 |
| 4 | Tests de conducta, uno por mando | CA-1..CA-11 |
| 5 | Guías de la app (el tipo las exige) y de `docs/` | `ng build` |
| 6 | Cierre: índice, memoria | CA-13 |

## Verificación

```bash
pnpm build:packages
pnpm test:strategies                      # donde vive casi todo
pnpm --filter @crypton/shared test        # la eficiencia extraída
pnpm --filter api test                    # el asesor usa la misma función
pnpm --filter worker test · pnpm test:backtest
pnpm lint · pnpm test
pnpm --filter app exec ng build           # el typecheck real, y el que exige las guías
```

**El criterio que protege a los bots en marcha es que los 367 tests que existían antes de este
spec sigan pasando sin tocarlos.** Todo lo nuevo nace en cero; si alguno se moviera, es que algo
se ha encendido solo.
