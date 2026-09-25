# 078 — El modelo no llega a tiempo

Estado: `hecho` (faltan CA-8 y CA-9 del usuario) · Tipo: `cambio` · Rama: `spec/078-modelo-a-tiempo`

## Objetivo

Que los agentes de IA (074) y el canal con IA (059) reciban la respuesta del modelo en vez de
cortarla a los 20 s. Y que lo que ocurre cuando falla —el coste, el seguimiento, la medición, la
pantalla— no engañe a nadie.

## Contexto

Incidente del 2026-09-25, 10:00 UTC:

- Un agente de simulación en modo IA (Hyperliquid, velas de 1 h, 7 pares)
  encuentra dos operaciones posibles, en ADA y LTC, y pregunta al modelo.
- La llamada se corta: `El modelo tardó más de 20000 ms en decision de un agente.`
- La ronda queda FALLIDA con `MODELO:TIEMPO` y no hay propuesta.
- La pantalla dice «Consultas al modelo 1 · 0,000 $» y «el modelo no respondió».

Causas encontradas en el código (`main` en `fb3ed13`):

1. **El plazo no deja terminar al modelo.**
   - `AI_DESK_REASONING=medium` con `MAX_TOKENS = 8_000`. OpenRouter da a Claude un presupuesto de
     razonamiento del 50 % de `max_tokens` (20 % en `low`, 80 % en `high`): **4.000 tokens**.
   - Esos tokens se generan y se cobran aunque `exclude: true` los oculte.
   - El plazo es de 20 s (`AI_DESK_TIMEOUT_MS`), y ninguna variable lo puede subir de 25 s. Hay dos
     topes: `ai-desk.config.ts:69` y `TIMEOUT_MS` en `openrouter.client.ts:45`, que se aplica en
     `decidir()` (`:515`).
   - Ese tope nació en el asesor, que tiene a una persona mirando la pantalla, y lo heredó una
     ronda que decide una vez por vela.
2. **El canal tiene el mismo problema**: `AI_CHANNEL_REASONING=medium`, `AI_CHANNEL_TIMEOUT_MS` a
   20 s y el mismo tope en la misma línea de `decidir()`.
3. **Cada corte se cobra y se anota a 0 $.**
   - Según OpenRouter, «for non-streaming requests or unsupported providers, the model will continue
     processing and you will be billed for the complete response».
   - `consumo.service.ts:86` anota `coste ?? '0'`, así que el tope `gastoDiaUsd` no ve ese gasto.
4. **Sin modelo, el seguimiento no decide.**
   - Usa la misma llamada (`seguimiento.service.ts:331-347`).
   - Si falla, o si el agente duerme, no tiene cupo o no hay clave, la vela se salta.
   - La decisión 4 del 075 era que cayera al juez de reglas. Estaba asignada al 076.
5. **La ronda de entrada fallida no guarda lo que vio.** Cierra (`rondas.service.ts:376-383`) antes
   de `guardarCandidatos` (`:387`), aunque su comentario (`:135-137`) promete que todo queda.
6. **«Analizar ahora» y «Revisar ahora» esperan al modelo dentro de la petición HTTP.** Con un plazo
   de más de 60 s chocan con nginx (`apps/app/nginx.conf:76`, 504) y con el interceptor global de
   80 s (500, mientras la ronda sigue corriendo).
7. **La pantalla engaña:**
   - «0,000 $» cuando el coste es desconocido;
   - «MODELO:TIEMPO» sin traducir, y sin decir que al 5.º fallo seguido deja de consultar 6 h;
   - «el modelo no respondió» también cuando se negó o la respuesta llegó truncada;
   - «EN_CURSO» sale tal cual.

**Por qué no lo cazó el 075**: todos los tests usan un modelo falso, y los falsos simulaban un
TIEMPO *con* coste, cosa que el cliente real nunca devuelve.

**Decisiones del usuario (2026-09-25):**
- se arreglan los agentes y el canal;
- **el canal aprovecha su minuto y sigue en `medium`**:
  - su solicitud caduca un minuto después del cierre de la vela (`expiresAt: cierreVela + 60_000`,
    `strategies/ai-channel.ts`), así que al modelo le quedan unos 45-55 s por mucho que suba el
    plazo;
  - la ventana no se toca y el esfuerzo tampoco;
  - lo que no llegue caduca con `PLAZO`: no cuenta como fallo, pero se cobra;
  - (el plan decía «seis minutos» por un error de lectura, corregido antes de implementarlo);
- **se adelanta aquí la decisión 4 del 075**: sin modelo, el seguimiento cae al juez;
- el coste de una llamada cortada se enseña como **desconocido**, sin estimar ningún importe.

## Alcance

- `apps/api`:
  - `modules/advisor/openrouter.client.ts`: tope por carga, plazo recomendado;
  - `modules/ai-desk`: configuración, rondas, seguimiento, vistas y el aviso de arranque;
  - `modules/ai-channel/ai-channel.service.ts`: su plazo y el aviso de arranque.
- `packages/shared`: el tope de fallos y la pausa, y el recuento sin coste en la vista.
- `apps/app`: el detalle del agente y de la operación, y los textos de las rondas y los fallos.
- `.env.example` de la API y de docker, `docker/docker-compose.yml`, `docs/agentes-ia.md` y
  `docs/administracion.md`.

## Fuera de alcance

- **Las entradas sin modelo.** Sin respuesta válida no hay entrada (invariante 13); eso no cambia.
- **Estimar el coste de una llamada cortada.** Decisión del usuario. El gasto sigue acotado por el
  tope de consultas al día, que se cuenta antes de llamar.
- **Pedir en streaming** para poder cancelar la generación y conocer su id. Es otro transporte, y
  este lleva doscientas líneas de incidentes aprendidos.
- **El asesor y el supervisor**: siguen en 25 s. El asesor responde a alguien que espera; el
  supervisor no tiene este problema.
- **«Peor día» (F-24) y los límites sin formato (F-35)**: siguen en el 076 y el 077.

## Requisitos

- **R-1 — Plazo por carga.**
  - Cada carga de decisión tiene su tope. Los agentes y el canal llegan a **120 s**; el asesor y el
    supervisor se quedan en 25 s.
  - `AI_DESK_TIMEOUT_MS` y `AI_CHANNEL_TIMEOUT_MS` pasan a **90.000** por defecto, con el rango
    [1.000, 120.000].
  - El canal sigue recortando el plazo a lo que quede hasta que caduque su solicitud.
- **R-2 — Aviso al arrancar.** Si el plazo configurado queda por debajo del recomendado para su
  esfuerzo de razonamiento (low 45 s, medium 90 s, high 120 s), un WARN lo dice con los dos números.
- **R-3 — Lo que piensa el modelo, a la vista.** La decisión guardada de cada ronda (agentes)
  incluye el uso de la llamada: tokens de entrada, de salida y de razonamiento, y el coste.
- **R-4 — Lo manual no espera dentro de la petición.**
  - «Analizar ahora» y «Revisar ahora» responden con la ronda EN_CURSO en cuanto existe. El resto
    corre aparte y suelta su hueco al terminar.
  - El cerrojo manual dura un minuto más el plazo, para que dos clics seguidos no paguen dos
    llamadas.
  - La app recarga mientras esa ronda esté en curso y avisa del resultado.
- **R-5 — La vida de una propuesta** se cuenta desde que la propuesta existe, no desde que empezó
  la ronda.
- **R-6 — Sin modelo, el seguimiento decide el juez.**
  - Aplica en modo IA sin clave, dormido, sin cupo, con fallo del modelo o con respuesta fuera del
    contrato. La acción es la de `juezSeguimiento`, sobre las opciones que ya permite la autonomía,
    y sigue el mismo camino que en REGLAS.
  - La ronda se cierra COMPLETADA, con el motivo en `decision.sinModelo`, y no guarda huella.
  - Un fallo del modelo sigue contando en la racha.
- **R-7 — La ronda de entrada fallida guarda sus candidatos**, sin elección y con la del juez. La
  tarjeta de resultados no los cuenta al medir si la IA discrimina: esa ronda no decidió.
- **R-8 — El coste desconocido se dice.**
  - La vista del agente cuenta las consultas del día sin coste conocido.
  - La app enseña «N sin coste conocido» junto al gasto.
- **R-9 — Los fallos se entienden en la pantalla.**
  - «Fallos seguidos N de 5 · <por qué>», con la consecuencia al llegar al tope.
  - Una ronda fallida dice el porqué.
  - La ronda en curso dice «analizando…».

## Criterios de aceptación

- **CA-1** — Tests del cliente: con 90 s de plazo, el `AbortSignal` de agentes y canal dura 90 s; con
  200 s, 120 s; el asesor y el supervisor siguen en 25 s.
- **CA-2** — Tests de configuración: 90.000 por defecto y 120.000 de tope en los dos; el aviso de
  arranque sale con 20.000 y `medium`, y no sale con 90.000.
- **CA-3** — `analizarAhora` responde EN_CURSO con la llamada al modelo aún pendiente, y el hueco se
  suelta al terminar; lo mismo en `revisarAhora`.
- **CA-4** — Seguimiento: TIEMPO, CONTRATO, dormido, sin cupo y sin clave aplican o proponen la
  acción del juez, sin huella, y la racha sube cuando hubo fallo.
- **CA-5** — Una ronda de entrada FALLIDA por el modelo deja sus candidatos, sin elegido y con el
  del juez.
- **CA-6** — Los falsos de TIEMPO devuelven `uso: null`, como el cliente real, y la vista cuenta esa
  consulta como sin coste conocido.
- **CA-7** — `pnpm --filter api test`, `pnpm lint`, `pnpm check:env`, `pnpm check:labels`, la build
  de los paquetes y el typecheck de la app, en verde.
- **CA-8** — *(del usuario)* En la infra local o en producción, una ronda en modo IA termina
  COMPLETADA con `latency_ms` por encima de 20.000 y con el uso en su decisión. **Esa llamada se
  paga.**
- **CA-9** — *(del usuario, al desplegar)* El `.env` del servidor no fija `AI_DESK_TIMEOUT_MS` ni
  `AI_CHANNEL_TIMEOUT_MS` por debajo de 90.000, y el WARN de R-2 no sale en el log de la API.
