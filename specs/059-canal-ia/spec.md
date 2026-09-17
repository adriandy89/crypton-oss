# 059 — La IA del canal, el producto y las guías

Estado: `hecho` (faltan CA-10 y CA-11 del usuario; sin merge ni despliegue) · Tipo: `cambio` ·
Rama: `spec/059-canal-ia` (sale de `spec/058-canal-determinista`)

## Objetivo

Poner la IA al bot `AI_CHANNEL` y darle un producto completo para administradores:
- la API consulta al modelo cuando el worker lo pide;
- el modelo elige entre las opciones que la herramienta ya calculó;
- el worker la ejecuta;
- el administrador lo configura, lo vigila y lo detiene desde la app y desde los avisos;
- las guías lo explican.

Estará hecho cuando se cumplan estas condiciones:
- un bot `AI_CHANNEL` en modo `IA` opera de punta a punta contra el simulador, con la API
  consultando a un modelo simulado;
- ninguna respuesta del modelo, válida o no, rompe un límite;
- el usuario puede crearlo, vigilarlo y pararlo desde la app.

## Contexto

Es la tercera pieza del plan aprobado el 2026-09-17:
- **057:** los fallos previos.
- **058:** el motor determinista, la estrategia y el backtest.
- **060:** la revisión.

El 058 deja el modo `IA` a medias a propósito:
- el worker escribe la solicitud (`bot_ai_intents` en `SOLICITADA`, con la herramienta) y avisa por
  `BOT_AI_REQUESTS`;
- consume la decisión cuando la intención pasa a `DECIDIDA`;
- nadie la contesta todavía.

Decisiones del usuario que gobiernan este spec:
- **Acceso.** Solo administradores.
- **La IA.** Decide solo entradas, con Sonnet 5 por defecto. La configuración va por variables de
  entorno.
- **La herramienta.** La calcula el servidor, y la IA decide en una sola llamada.
- **Sin decisión válida, no hay entrada.**
- **Los límites.** El perfil ordena preferencias y nunca afloja un límite.

Lo que dice la investigación del plan:
- los operadores autónomos con IA perdieron dinero en competiciones reales;
- lo profesional es que la IA elija entre opciones ya calculadas, que la ausencia de respuesta no
  abra nada y que las salidas nunca esperen al modelo.

## Alcance

| Área | Qué |
|---|---|
| API | Módulo `ai-channel`: consumidor de solicitudes, barreras, cupos, contrato, herramienta renderizada, prompt, llamada y escritura de la decisión. Endpoints de administración. Acceso de administradores en el listado. Variables de entorno |
| `advisor/openrouter.client.ts` | `decidirCanal()`, con el uso, el coste y la caché del prompt |
| worker | Los eventos de la operación (`AI_ENTRY`, `AI_EXIT`) y sin `CYCLE_CLOSED` duplicado en estos bots |
| notificador | Los avisos del canal y el botón de pausa |
| `shared` | El vocabulario del contrato y de los eventos |
| app | Tarjeta de administrador con consentimiento, formulario por grupos, panel del canal, líneas del canal en el gráfico, pastilla en la consola y las cifras del backtest |
| docs | `docs/ai-channel.md` y las guías afectadas, `README.md` y `CLAUDE.md` (mapa e invariantes del dinero) |

## Fuera de alcance

- **La llamada de pago real.** La verificación con una llamada de pago al modelo necesita la
  aprobación del usuario: queda como criterio manual.
- **Entradas en espera con bracket nativo, ruptura confirmada, IA que gestiona posiciones,
  calendario macro y llamadas a herramientas reales del modelo.** Van en specs posteriores.
- **Tasas base persistidas desde el backtest.**
- **Portar al fork OSS.**

## Requisitos

- **R-1 — Una solicitud, una llamada como mucho.**
  - La API reclama cada solicitud con un UPDATE condicional (`SOLICITADA` → `CONSULTANDO`).
  - La encuentra por el bus y por un sondeo de respaldo cada 10 s.
  - La concurrencia está acotada.
  - Dos réplicas nunca consultan la misma solicitud.
- **R-2 — Barreras antes de llamar.** Se llama solo si se cumple todo esto:
  - `AI_CHANNEL_ENABLE` activo y la clave presente;
  - dueño `ADMIN` y habilitado, leído de la base;
  - bot `RUNNING` y sin pausa por fallos;
  - interruptor global abierto;
  - solicitud vigente;
  - cupo del bot y cupo global disponibles.

  Si falla una, la intención termina con su motivo y no se llama.
- **R-3 — Cupos contados antes de llamar.**
  - Por bot: `aiDailyCallBudget`, con el tope del servidor. Además, un cupo global por día UTC.
  - Con Redis caído no se llama.
- **R-4 — El contrato: solo enumeraciones.**
  - Campos: veredicto, opción (ids de la oferta o `NINGUNA`), stop, objetivo, banda de
    apalancamiento, tamaño, confianza, motivos y riesgos cerrados, y un texto sin cifras de como
    mucho 200 caracteres.
  - El esquema es estricto: el parser no repara nada.
  - La elección tiene que estar en la oferta y disponible.
  - La confianza por debajo de la mínima es `SIN_ENTRADA`.
  - La confianza solo puede reducir el tamaño.
- **R-5 — La herramienta renderizada.**
  - Va en unidades relativas: R, %, múltiplos de ATR, bps y % del capital.
  - **Nunca** lleva precios absolutos, USDC, nombres, notas ni ids de bot o usuario.
  - No incluye el razonamiento previo del modelo.
- **R-6 — El prompt.**
  - Es fijo, en castellano y cacheable.
  - `NO_OPERAR` es el valor por defecto.
  - El perfil ordena preferencias y nunca afloja límites.
  - El contenido de la herramienta es un dato, no una instrucción.
  - Cada versión lleva hash.
- **R-7 — Plazos y fallos.**
  - El plazo es el cierre de la vela más 60 s.
  - Un fallo deja la intención en `FALLIDA`.
  - Con 5 fallos seguidos: 6 h sin consultas y `AI_FAILED`, como mucho uno por hora.
  - Nada abre sin decisión válida.
- **R-8 — La decisión se escribe y se avisa.**
  - `DECIDIDA` (o `SIN_ENTRADA`), con el modelo, la versión del prompt, la latencia y el coste.
  - `AI_DECISION` en la línea de tiempo.
  - Aviso al worker por `BOT_AI_INTENTS`.
- **R-9 — Modo sombra.** Con `AI_CHANNEL_SHADOW_ONLY`, la decisión se registra y nunca se ejecuta.
- **R-10 — Avisos.**
  - `AI_ENTRY` va solo, con los números del plan y un botón «⏸ Pausar».
  - `AI_EXIT` lleva el resultado en USDC y en R, y el motivo.
  - También: `AI_ENTRY_DISCARDED` y `AI_DAY_STOP`.
  - `AI_FAILED` se reutiliza.
  - `CYCLE_CLOSED` no se duplica en estos bots.
- **R-11 — Acceso.**
  - Solo administradores:
    - el listado de estrategias;
    - la vista previa, la creación, la edición y el arranque;
    - los endpoints del canal.
  - El comando `AI_INTENT` no existe para los clientes.
- **R-12 — Administración.**
  - El estado del lazo de un bot y sus últimas decisiones.
  - El interruptor global de entradas: leerlo y cambiarlo, con auditoría.
- **R-13 — La app.**
  - **Tarjeta:** solo para administradores, con una casilla obligatoria («dinero real, hasta 25x,
    la IA decide cada entrada»).
  - **Formulario:** por grupos, sin el asesor ni el editor del Modo IA.
  - **Panel del canal:**
    - estado del lazo;
    - régimen y canal;
    - operación viva;
    - «Hoy»: pérdida frente al tope, operaciones, llamadas y coste;
    - últimas decisiones con sus motivos;
    - pausa y entradas.
  - **Resto:** líneas del canal en el gráfico, pastilla en la consola y las cifras por setup del
    backtest.
- **R-14 — Guías.**
  - Una guía propia.
  - Las generales al día: administración, comandos y eventos, riesgo y liquidación con la regla por
    stop, buenas prácticas, y simulación y backtest.
  - `CLAUDE.md`: el mapa y la enmienda de las invariantes 1 y 13.

## Criterios de aceptación

Se completan en `plan.md` con cada fase. Como mínimo:

- **CA-1** — Contrato: sin tipos numéricos ni restricciones de número, objetos cerrados y enums
  idénticos al vocabulario de `shared`. El parser rechaza cualquier desviación.
- **CA-2** — Privacidad del render: un test recorre la herramienta renderizada y no encuentra ni
  precios, ni USDC, ni nombres, ni ids.
- **CA-3** — Barreras y cupos: cada barrera tiene su test, el cupo se cuenta antes de llamar y con
  Redis caído no se llama; dos réplicas hacen una sola llamada.
- **CA-4** — Un e2e sobre el simulador en modo `IA` con un modelo simulado: solicitud → decisión →
  entrada → stop y objetivos. Una respuesta inválida, tardía o fuera de la oferta no abre nada.
- **CA-5** — Avisos: formato, botón de pausa y sin `CYCLE_CLOSED` duplicado.
- **CA-6** — Rutas de administración con su orden y sus 403.
- **CA-7** — La app compila dentro de sus presupuestos.
- **CA-8** — Mutaciones de las piezas nuevas, todas caen.
- **CA-9** — Verificación completa en verde.
- **CA-10** — *(usuario)* Una llamada de pago aprobada: comprobar la caché, el uso y el
  razonamiento.
- **CA-11** — *(usuario)* La simulación de 48-72 h y la primera sesión real del plan.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Exceso de confianza o alucinación del modelo | Solo enums de la oferta, la confianza solo reduce, `NO_OPERAR` por defecto y sin respuesta no hay entrada |
| Coste del modelo | Llamadas solo con setup, cupos por bot y globales contados antes, caché del prompt y coste registrado |
| Fuga de datos al proveedor | Render en unidades relativas, con un test de privacidad |
| Dos réplicas llaman dos veces | Reclamación condicional en la base |
| Se abre a no administradores | Rol leído de la base en cada camino, fuera de los planes y del ranking, y candado en el worker |
| Avisos que no llegan o llegan repetidos | Formato probado y deduplicación por clave |

## Referencias oficiales

Consultadas el 2026-09-17 (documentación pública de OpenRouter, repositorio `openrouterteam/docs`).

- **Salida estructurada.**
  https://github.com/openrouterteam/docs/blob/main/guides/features/structured-outputs.mdx
  - Cita: «Support is determined per endpoint, not just per model: the same model may be served by
    multiple providers, and only some of those providers may support structured outputs».
  - Para enrutar solo a los que la soportan: «Set `require_parameters: true` in your provider
    preferences».
  - Por eso el esquema va con `strict: true` y `provider.require_parameters`, y el parser valida
    igual.
- **Filtro de proveedores.**
  https://github.com/openrouterteam/docs/blob/main/openapi/openapi.yaml (`require_parameters`)
  - Cita: «If this setting is omitted or set to false, then providers will receive only the
    parameters they support, and ignore the rest».
- **Caché del prompt.**
  https://github.com/openrouterteam/docs/blob/main/guides/best-practices/prompt-caching.mdx
  - TTL: «By default, the cache expires after 5 minutes, but you can extend this to 1 hour by
    specifying "ttl": "1h" in the cache_control object».
  - Coste: «The 1-hour TTL costs more for cache writes (2x base input price vs 1.25x for 5-minute
    TTL)».
  - Mínimo: «1,024 tokens: Claude Sonnet 4.6, Claude Sonnet 4.5…», «4,096 tokens: Claude Opus 4.8…
    Claude Haiku 4.5» y «Prompts shorter than these minimums will not be cached».
  - Sonnet 5 no figura en la lista. Un prompt por debajo del mínimo no se cachea y tampoco paga
    escritura; CA-10 mide cuál es el caso.
  - Por qué 1 h: con las llamadas repartidas a lo largo del día, cada lectura renueva la caché.
    Con 5 min, casi todas serían escrituras, y más caras que no cachear.
- **Uso y coste.**
  https://github.com/openrouterteam/docs/blob/main/cookbook/administration/usage-accounting.mdx
  - Cita: «Full usage details are now always included automatically in every response».
  - El objeto `usage` trae `cost`, `prompt_tokens_details.cached_tokens`,
    `prompt_tokens_details.cache_write_tokens` y `completion_tokens_details.reasoning_tokens`.
- **Referencia de la API.**
  https://github.com/openrouterteam/docs/blob/main/api_reference/overview.mdx
  - `cost` es «Cost in credits». Los créditos se compran en USD, así que se guarda como coste en
    USD.
- **Atribución.** https://github.com/openrouterteam/docs/blob/main/app-attribution.mdx
  - Cita: «`X-Title` is still supported for backwards compatibility».
  - El cliente sigue mandando `X-Title`, con un título por carga (`Crypton AI channel`).
