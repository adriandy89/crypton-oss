# 079 — Plan

## Enfoque

Tres revisiones independientes, en paralelo y de solo lectura:

1. rejillas y escaleras (rejilla clásica, rejilla neutral, martingala, TDCA, GridMart);
2. MM V1 y V2, tendencia, seguimiento de beneficio, AI_CHANNEL y AGENT_TRADE;
3. lo transversal: `buildPreview`, stop, liquidación, riesgo en la API, asesor y pantalla de
   creación.

Cada afirmación se vuelve a leer en el código antes de pasar a `findings.md`.

La fórmula de liquidación se contrasta con la documentación oficial de los tres venues. Las
decisiones que cambian la conducta de un bot las toma el usuario, con la referencia de cómo lo hace
Binance.

Descartado: corregir aquí. El usuario quiere todo corregido y sin lógica vieja, y ese cambio es de
semántica y de contrato: pide su propio spec (080).

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `specs/079-revision-parametros-y-calculos/*` | Nuevo | — |
| `specs/README.md` | Fila del índice | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base en el worktree | Anotada en `findings.md` |
| 1 | Tres revisiones en paralelo | Informe de cada una |
| 2 | Comprobación en el código de cada afirmación | Cada hallazgo con `fichero:línea` |
| 3 | Referencias oficiales de liquidación y ROI | Citas con URL y fecha |
| 4 | Decisiones del usuario | D-1 a D-6 y P-1 a P-9 anotadas |
| 5 | Cierre | Índice actualizado; el 080 recoge todos los hallazgos |

## Verificación

No hay código que verificar. Los hallazgos numéricos se demuestran con tests en rojo en el 080,
antes de cada corrección.
