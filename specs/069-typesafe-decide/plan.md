# Plan — Spec 069

## Orden de los commits

Cada uno deja el árbol compilando y en verde.

1. **El vocabulario se abre a dos formas de elección** (`packages/shared`)
   `DecisionIa.eleccion` es hoy `EleccionOperacion | null`, que es la forma del canal. Pasa a
   `EleccionDecision = EleccionOperacion | VeredictoTrader`, con `esEleccionCanal()` para
   estrecharla —por una clave que solo tiene una de las dos, como ya hacen `esOfertaCanal` y
   `esPlanCanal`, y no por el nombre de la estrategia—. Más `veredictoDe()`, que lee la columna
   JSON y devuelve un `VeredictoTrader` o null.

2. **El worker lee las dos** (`apps/worker/src/engine/ai-intents.store.ts`)
   `eleccionDe()` reconoce la forma del «Bot de IA» además de la del canal. Nada más cambia: el
   lazo de intenciones nunca mira dentro de la oferta.

3. **La estrategia pide y consume** (`packages/strategy-core/src/strategies/ai-trader.ts`)
   La rama de IA: si hay decisión de esta vela y es utilizable, se construye con ella; si no la
   hay, se escribe la solicitud. Las mismas puertas que el canal —plazo, huella, confianza— y una
   más que es propia: el **acuerdo** de las tres nouls. Y se quita el rechazo de `validate()`.

4. **El cliente de TypeSafe** (`apps/api/src/modules/ai-trader/typesafe.client.ts`)
   `fetch` a mano con `AbortSignal`, como `openrouter.client.ts`. No el SDK: `@typesafe-ai/sdk`
   es ESM puro y la API es CJS, así que haría falta un `await import()` dentro de un `@Injectable()`
   en una ruta con plazo, y lo que compra es un POST con tres cabeceras.

5. **Las preguntas y el contrato** (`preguntas.ts`, `contrato.ts`)
   Las ocho preguntas y el validador de la respuesta. Una respuesta que no encaja es `CONTRATO`,
   no una decisión a medias.

6. **El lazo** (`ai-trader.service.ts`, `ai-trader.scheduler.ts`, `ai-trader.module.ts`)
   Hermano del del canal: reclamo condicional, barreras en orden, cupo contado **antes**, racha de
   fallos con pausa de 6 h, modo sombra.

7. **El reparto de intenciones** (`ai-channel.service.ts`)
   El filtro por estrategia en el reclamo y en el sondeo, en los dos lazos. Con su test.

8. **Las variables** (`.env.example`, compose, `check:env`).

9. **La app, las guías y `CLAUDE.md`**: el mando deja de rechazarse, las guías dejan de prometer
   lo que no hay, y la línea del «único fichero que habla con un LLM» pasa a ser una lista de dos
   **con un test que la hace cumplir**.

## Las trampas conocidas de esta casa

- `pnpm build:packages` antes de tocar la API o el worker: resuelven `@crypton/*` por `dist/`.
- Los tests del worker usan `strategy-core` desde `dist`: cambiar el paquete sin recompilar da un
  verde falso.
- Los tests de la API **no construyen el grafo de Nest** (spec 049): un módulo nuevo mal declarado
  pasa los unitarios y tumba el arranque. Se comprueba con el build y con el test de arranque.
- Jest desde Git Bash, no desde PowerShell.

## Riesgos

- **Dependencia externa nueva en la ruta del dinero.** Mitigación: sin respuesta válida no hay
  entrada —nunca al revés—, el stop y los objetivos son órdenes nativas que no esperan al modelo,
  y la racha de fallos duerme el lazo 6 h.
- **Coste desconocido.** TypeSafe no publica tarifas. Mitigación: una evaluación por vela de
  15 min (96 al día como mucho), tope por bot, tope global, y el enfriado de `WRONG_ENVIRONMENT`
  que deja de preguntar durante unas velas. **Los bots simulados también gastan llamadas.**
- **Los dos lazos comparten tabla.** Es el riesgo real de este spec y por eso el filtro por
  estrategia lleva su propio criterio de aceptación.
