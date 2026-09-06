# 012 — Plan

## Enfoque

Todo en `exchange-core`, con el protocolo de `specs/README.md`: test rojo, diff mínimo, tests del paquete y
del worker (dependiente), lint, un commit por corrección. Orden: nonce (R-1, R-2, una pieza), clasificación
(R-3), deriva (R-4), comisión (R-5).

Alternativa descartada: nonce compartido en Redis por `signer`. Es la solución completa a F-69, pero mete
Redis en el adaptador (que hoy no depende de nada del motor) y la API ya casi no firma con el `signer` del
worker; el desplazamiento por proceso reduce la colisión a uno entre mil milisegundos coincidentes.

## Ficheros afectados

| Fichero | Qué cambia | Tests |
|---|---|---|
| `adapters/aster.ts` | `nextAsterNonce()` de módulo (monótono, desplazado por proceso); firma dentro de `limiter.run`; `verify()` mira `/fapi/v3/time`; `fee` en valor absoluto | `adapters/aster.spec.ts` (nuevo) |
| `errors.ts` | patrones AUTH / RULES / RETRYABLE de Aster | `errors.spec.ts` |
| `docs/venues-y-minimos.md`, `docs/comandos-guardas-y-eventos.md`, fichas del 001 | bloques F-38, F-69, F-75, F-77, F-78 | grep |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama desde `spec/011`; build; baterías | verde |
| 1 | Nonce de proceso, monótono, al enviar (F-38, F-69, F-75) | tres tests de nonce |
| 2 | Clasificación (F-75, F-77) | `errors.spec.ts` |
| 3 | Deriva de reloj en `verify()` (F-38) | test de deriva |
| 4 | Comisión en valor absoluto (F-78) | test de comisión |
| 5 | Cierre: docs, fichas, índice, memoria | CA-4 |

## Verificación

```bash
pnpm --filter exchange-core test && pnpm build:packages && pnpm --filter worker test
pnpm test && pnpm lint
grep -rn "F-38\|F-69\|F-75\|F-77\|F-78" docs/
```
