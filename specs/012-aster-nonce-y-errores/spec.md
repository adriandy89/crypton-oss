# 012 — Aster: el nonce no choca ni caduca, y los errores se llaman por su nombre

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/012-aster-nonce-y-errores`

## Objetivo

Que ninguna petición firmada a Aster se rechace por un nonce repetido, retrasado o caducado, que un
rechazo por firma se trate como lo que es (credencial mala) y un rechazo por filtro como una regla del
mercado, y que la comisión de una ejecución no pueda sumar al realizado. Estará hecho cuando los tests
nuevos del adaptador y del clasificador pasen y los dependientes sigan en verde.

## Contexto

Hallazgos del spec 001 sobre el adaptador de Aster:

| F | Título | Sev. | Efecto hoy |
|---|---|---|---|
| F-69 | La API y el worker firman con el mismo `signer` y generan el mismo nonce en el mismo segundo | Alta | La segunda petición recibe `-4225`; si era el stop-loss, posición sin red hasta la siguiente ejecución |
| F-75 | El nonce se genera al firmar, antes de la cola, y `-4225` es FATAL | Alta | Con muchas peticiones encoladas la última sale con un nonce de hace más de diez segundos → FATAL → cuarentena |
| F-38 | Nonce no monótono ante un salto del reloj hacia atrás; sin guarda de deriva frente al servidor | Media | Un paso de NTP hacia atrás repite un nonce ya usado |
| F-77 | `-1022 Signature … not valid` es FATAL en vez de AUTH; los ocho rechazos por filtro son FATAL en vez de RULES | Media | Una credencial mal emparejada agota el cortacircuitos en vez de avisar en CRITICAL y soltar el bot |
| F-78 | Signo de `commission` sin definir en la doc (el ejemplo trae `-0.078` en un taker) | Media | Si Aster expresa lo pagado en negativo, el motor lo **suma** al realizado |

## Alcance

- `packages/exchange-core/src/adapters/aster.ts`: generador de nonce compartido por proceso, monótono y
  calculado al enviar; comprobación de deriva en `verify()`; comisión en valor absoluto.
- `packages/exchange-core/src/errors.ts`: patrones nuevos (`Nonce Expired` → RETRYABLE; `-1022` → AUTH;
  filtros de Aster → RULES).
- Tests: `adapters/aster.spec.ts` (nuevo), `errors.spec.ts`.

## Fuera de alcance

- Una fuente de nonce compartida entre procesos (Redis): la mitigación probabilística del desplazamiento
  por proceso basta mientras la API firme poco; se anota en la ficha de F-69.
- `positionSide` en Aster (011, R-3) y el resto de hallazgos de Aster (F-70, F-72, F-73, F-74 → 015;
  F-76 → 020; F-22, F-23, F-79 → 023).
- Confirmar el signo real de la comisión con una lectura firmada: prohibido por las reglas del agente. Se
  toma la decisión conservadora (coste) y se deja constancia.

## Requisitos

- **R-1** (F-38, F-69) El nonce es de **proceso**, no de instancia: microsegundos desde la época más un
  desplazamiento aleatorio por proceso dentro del milisegundo, y nunca menor que el anterior más uno. Dos
  adaptadores del mismo proceso no repiten nonce; un salto del reloj hacia atrás tampoco.
- **R-2** (F-75) El nonce (y la firma) se calculan **al enviar**, dentro del limitador y después del
  presupuesto, no al encolar.
- **R-3** (F-75, F-77) Clasificación: `Nonce Expired` → RETRYABLE; `Signature for this request is not
  valid` → AUTH; `Order would immediately trigger`, `Position is not sufficient`, `Reach max open order
  limit`, `Exceeded the maximum allowable position at current leverage`, `Quantity less/greater than
  min/max quantity`, `Price less/greater than min/max price`, `Price is higher than mark price multiplier
  cap` → RULES.
- **R-4** (F-38) `verify()` compara el reloj local con `/fapi/v3/time`: con más de veinte segundos de
  desvío devuelve `ok: false` con el motivo (la ventana de firma del venue es de ±60 s).
- **R-5** (F-78) La comisión de una ejecución (REST y WebSocket) se contabiliza en **valor absoluto**: una
  comisión es un coste. Si algún día Aster pagara rebates, habrá que distinguirlos con una lectura firmada.

## Criterios de aceptación

- **CA-1** `aster.spec.ts`: «es estrictamente creciente aunque el reloj retroceda», «dos adaptadores con el
  mismo firmante no repiten nonce», «el nonce se genera al enviar, no al encolar», «la comisión se
  contabiliza como coste sea cual sea su signo», «un reloj desviado más de veinte segundos se rechaza con el
  motivo» pasan.
- **CA-2** `errors.spec.ts`: las filas nuevas de Aster pasan; las existentes no cambian.
- **CA-3** `pnpm --filter exchange-core test`, `pnpm --filter worker test`, `pnpm test`, `pnpm lint` en verde.
- **CA-4** `grep -rn "F-38\|F-69\|F-75\|F-77\|F-78" docs/` sin bloques «Limitación conocida»; fichas del 001
  con la decisión.

## Riesgos

- El desplazamiento aleatorio no elimina la colisión entre procesos, la hace improbable (uno entre mil
  cuando coinciden en el mismo milisegundo). La solución completa exige compartir el nonce por `signer`;
  queda anotada.
- Contabilizar una comisión negativa como coste sobrestima el coste si fuera un rebate: es el error
  conservador (el realizado queda por debajo, nunca por encima).

## Referencias oficiales

Aster V3 (doc citada en `specs/001-revision-integral/informes/C-aster.md`): nonce en microsegundos,
últimos nonces por dirección de agente, ventana de diez segundos, `-4225 Nonce Expired … Please retry`;
ventana de firma de ±60 s frente a `serverTime`; capítulo de errores (`-1022`, `-2021`, `-2024`, `-2025`,
`-2027`, `-4004`, `-4005`, `-4013`, `-4016`); ejemplo de `userTrades` con `"commission": "-0.07819010"`.
