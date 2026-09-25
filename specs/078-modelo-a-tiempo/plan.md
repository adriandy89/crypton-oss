# 078 — Plan

Un commit por corrección, en este orden, y cada test en rojo antes de su arreglo.

## A. El plazo (R-1, R-2, R-3)

| Fichero | Cambio |
|---|---|
| `apps/api/src/modules/advisor/openrouter.client.ts` | `CargaDecision.topeMs`; `TOPE_DECISION_MS = 120_000` para `decidirAgente` y `decidirCanal`; `decidir()` topa con `carga.topeMs`. `TIMEOUT_MS = 25_000` se queda en el asesor y el supervisor. `plazoRecomendadoMs(esfuerzo)`, pura. El comentario de `MAX_TOKENS` cuenta los tres esfuerzos |
| `apps/api/src/modules/ai-desk/ai-desk.config.ts` | `AI_DESK_TIMEOUT_MS`: 90.000, rango [1.000, 120.000] |
| `apps/api/src/modules/ai-channel/ai-channel.service.ts` | `AI_CHANNEL_TIMEOUT_MS`: lo mismo. El recorte a lo que queda hasta el plazo se queda |
| `ai-desk.scheduler.ts` y el arranque del canal | WARN si el plazo queda por debajo del recomendado |
| `rondas.service.ts` (`jsonDe`) y `seguimiento.service.ts` | La decisión guarda `uso` |
| `.env.example` ×2, `docker-compose.yml`, `docs/agentes-ia.md`, `docs/administracion.md` | 90000, tope 120000 |

Tests: `openrouter.agentes.spec.ts`, `openrouter.canal.spec.ts`, `ai-channel.service.spec.ts` (el
de 60000 → 25000 pasa a 60000 → 60000), uno nuevo de `AiDeskConfig` y del aviso.

## B. Lo manual, fuera de la petición (R-4, R-5)

- `rondas.service.ts`:
  - `iniciarEntrada()` reserva el hueco antes del primer `await`, lee el agente y crea la fila;
    devuelve `{ rondaId, fin }` o null;
  - `fin` corre la ronda, y su `finally` suelta el hueco;
  - `rondaEntrada()` sigue devolviendo lo mismo (`fin`), así que el barrido y sus tests no cambian;
  - `analizarAhora()` devuelve la fila EN_CURSO y deja `fin` con `.catch`.
- `seguimiento.service.ts`: lo mismo con `iniciarSeguimiento()` y `revisarAhora()`.
- El cerrojo manual pasa a `60 + ceil(plazo / 1000)` segundos.
- `expires_at` de la propuesta se cuenta con `Date.now()` al crearla. El plan sigue calculado con el
  `ahora` de la ronda, que es el instante de su lectura de mercado.
- App:
  - `agentes-acciones.service.ts`: con EN_CURSO avisa «Analizando…» y no enseña un motivo;
  - `agente-detalle.page.ts` y `propuesta-detalle.page.ts` recargan cada 4 s mientras la ronda
    lanzada siga EN_CURSO, con tope de 3 min, y avisan al terminar.

## C. El seguimiento sin modelo (R-6)

En `seguimiento.service.ts`, la ronda calcula `sinModelo`:

| Situación | `sinModelo` |
|---|---|
| Sin clave | `SIN_CLAVE` |
| Dormido | `DORMIDO` |
| Sin cupo | el motivo del cupo |
| Fallo del modelo | `MODELO:<fallo>` |
| Respuesta fuera del contrato | `CONTRATO` |

- Con `sinModelo`, la acción es la del juez y la ronda sigue hasta `actuar()`.
- La ronda se cierra COMPLETADA, con `sinModelo` en su decisión y sin la columna `huella`.
- Las barreras que no son del modelo siguen saltando: dueño, archivado, bot, pendiente y datos.

## D. La ronda fallida guarda sus candidatos (R-7)

`rondas.service.ts`: antes de cerrar FALLIDA por el modelo, `guardarCandidatos(deRonda, salida,
oferta, null, juez)`. Y `listados.service.ts` (`resultados`) deja fuera los candidatos de una ronda
FALLIDA: allí no se eligió ninguno porque el modelo no llegó a decidir, y contarlos como «no
elegidos» ensuciaría la tarjeta de «¿Discrimina la IA?».

## E. El coste y los textos (R-8, R-9)

- **shared**:
  - `TOPE_FALLOS_AGENTE` y `PAUSA_FALLOS_AGENTE_MS` (la API los importa de aquí);
  - `AgenteVista.consultasSinCoste`.
- **API**: un `groupBy` de las rondas del día UTC con `model` y sin `cost`, por agente, en la lista y
  en el detalle.
- **App**:
  - «Consultas al modelo N · X $ · M sin coste conocido»;
  - «Fallos seguidos N de 5 · <fallo>», con una nota;
  - `MOTIVO_RONDA.MODELO` → «sin respuesta válida del modelo», seguido del fallo de la ronda;
  - EN_CURSO → «analizando…»;
  - `FALLO_MODELO` se exporta desde `canal-ia.ts` y se reutiliza.

## Riesgos

- **Rondas que ocupan su hueco más tiempo.** Con 2 huecos y llamadas de 90 s, varios agentes con la
  misma vela se reparten los barridos de 30 s. Siguen dentro de su vela.
- **El canal y su minuto.**
  - La solicitud caduca un minuto después del cierre, así que la llamada se recorta a lo que quede
    (unos 45-55 s).
  - Con 90 s configurados, un tiempo agotado cuenta siempre como «plazo recortado»: caduca con
    `PLAZO`, no suma a la racha y se cobra. Es lo que el usuario aceptó al seguir en `medium`.
  - Con un plazo configurado que quepa en el minuto (p. ej. 20000), el tiempo agotado vuelve a
    contar como fallo, como antes.
  - Con 4 huecos, llamadas de hasta un minuto caben de sobra en los bots de hoy.
- **El `.env` del servidor** puede fijar 20000 a mano: CA-9.
