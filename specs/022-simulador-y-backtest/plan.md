# 022 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, un commit (un solo hallazgo). Cambian
textos de avisos y se añade un contador; el resultado numérico del replay no cambia.

Decisiones de diseño tomadas aquí:

- **Declarar, no disfrazar.** Planificar en cada sub-tick o a «cadencia real» habría multiplicado el coste
  por veinte para ejecutar contra un recorrido intra-vela inventado. Los avisos dicen exactamente qué no se
  reproduce, con los números de la configuración del usuario.
- **Los avisos conocen la estrategia.** `fidelityWarnings` recibe `strategy` y `config` (opcionales, para no
  romper a quien no los pase); la API los tiene a mano en el mismo sitio donde compone el resultado.
- **Los rechazos se cuentan en el motor del replay**, que es donde ocurren, y salen como un aviso más con
  hasta tres motivos distintos: añadir un campo al resultado habría arrastrado tipos por API y app para un
  dato que solo se lee junto a los demás avisos.
- **La cadencia real para medir F-81** queda fuera: F-81 se corrigió en el spec 017 por otro camino
  (histéresis por línea) y su medida es su test unitario.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `backtest/src/warnings.ts` | `strategy`/`config`; avisos del market maker; aviso de guardas sin promesas | `warnings.spec.ts` (nuevo) | `5f6efcd` |
| `backtest/src/engine.ts` | los rechazos al colocar se cuentan y salen en los avisos | `engine.spec.ts` | `5f6efcd` |
| `api/.../backtests.service.ts` | pasa la estrategia y la configuración | `pnpm --filter api test -- backtests` | `5f6efcd` |
| `docs/simulacion-y-backtest.md`, `docs/neutral-grid.md` | el bloque de F-65 pasa a describir lo que dicen los avisos | enlaces | cierre |

## Verificación

```bash
pnpm test:backtest && pnpm build:packages && pnpm --filter api test -- backtests
pnpm --filter @crypton/backtest lint && pnpm --filter api lint
```
