# 047 — Revisión del spec 046

Estado: `aprobado` · Tipo: `revisión` · Rama: `spec/046-modo-ia-supervisor`

## Objetivo

Releer el spec 046 contra el código que lo implementa, antes de mergearlo, y corregir lo que no
cumple lo que el propio spec prometió.

Se sabrá que está hecho cuando los ocho hallazgos de `findings.md` estén corregidos con su test, y
cuando el prompt que recibe el modelo lleve de verdad la línea que el spec 046 llama «la que de
verdad decide».

## Contexto

El spec 041 dejó escrita la lección que motiva este: *«los tests genéricos cazan todo lo estructural
—guías, etiquetas, grupos, validación—, pero nada caza un requisito del propio spec que no se
implementó ni una conducta que solo aparece entre dos ticks. Para eso hay que releer el spec contra
el código»*. Eso es exactamente lo que ha pasado aquí: 6891 tests en verde y ocho hallazgos que
ninguno tocaba.

**Se corrige dentro y no en un spec de seguimiento**, y es una decisión del usuario que conviene
justificar. El protocolo de `specs/README.md` reserva la corrección dentro de un spec de revisión a
las Críticas confirmadas, y aquí no hay ninguna. Pero ese protocolo protege **código en
producción**: un arreglo al vuelo sobre bots que ya operan es lo que se quiere evitar. El 046 no
está mergeado, así que estos son defectos de un trabajo que todavía no ha salido, y mergear una
función que ya se sabe que decide con menos información de la que promete —para arreglarla en un
048— sería peor negocio.

## Alcance

- `apps/api/src/modules/supervisor/` — los siete hallazgos del supervisor.
- `packages/db/prisma` — una columna nueva para F-01, con su migración. **Autorizado por este
  spec**, como lo estuvo en el 046.
- `apps/api/.env.example`, `docker/.env.example`, `docker/docker-compose.yml` — F-08.
- `specs/046-modo-ia-supervisor/spec.md` y `docs/administracion.md` — el texto de R-23, que ahora
  será cierto.

## Fuera de alcance

- Todo lo que el 046 dejó fuera y sigue fuera: las otras cinco estrategias, la contención, el Modo
  IA para no administradores, backtestear la propuesta.
- La cola de decisiones en la app, aplazada en el 046 y que sigue aplazada.

## Requisitos

- **R-1** El expediente lleva los rasgos del par **de cuando se activó el Modo IA**, y el prompt
  muestra el cambio de régimen. Si no hay referencia, se dice; no se calla (F-01).
- **R-2** Una decisión fallida se guarda con lo que de verdad pasó, y **no entra** en el historial
  que ve el modelo. Ese historial solo lleva decisiones que el modelo puede reconocer como suyas
  (F-02).
- **R-3** `bot_ai_decisions.model` guarda el modelo que decidió (F-03).
- **R-4** Aprobar desde Telegram **recalcula** la configuración desde las perillas guardadas contra
  el mercado del momento, pasando otra vez por `validate()` y `preview()`. Si el recálculo ya no
  produce un cambio aplicable, la sugerencia caduca y se dice (F-04).
- **R-5** El barrido periódico respeta el disparador: un bot en `OPERACION` no se revisa por tiempo
  (F-05).
- **R-6** Un aviso no queda pendiente: tiene su propio estado terminal (F-06).
- **R-7** El expediente descarta un estado del bot que no sea reciente, y lo dice (F-07).
- **R-8** `AI_AGENT_REVIEW_TTL_S` desaparece de los tres sitios (F-08).
- **R-9** El tope de cambios diarios frena **solo al modo automático**. Una aprobación humana
  explícita se aplica siempre: quien pulsa el botón ha mirado el cambio y ha decidido (decisión del
  usuario, F-09).

## Criterios de aceptación

- **CA-1** `pnpm test`, `pnpm lint` y `pnpm check:env` en verde, y `ng build` de la app.
- **CA-2** Un test falla si el prompt renderizado no lleva el cambio de régimen habiendo referencia
  (R-1).
- **CA-3** Un test comprueba que una decisión fallida no aparece en el historial del expediente
  (R-2).
- **CA-4** Un test comprueba que aprobar desde Telegram vuelve a pasar por la traducción
  determinista, y que una propuesta que ya no cabe caduca en vez de aplicarse (R-4).
- **CA-5** Un test comprueba que un bot con disparador `OPERACION` no sale en el barrido (R-5).
- **CA-6** Un test comprueba que una aprobación manual se aplica con el tope diario agotado, y que
  el automático no (R-9).
- **CA-7** `grep AI_AGENT_REVIEW_TTL_S` no devuelve nada en todo el repositorio (R-8).
- **CA-8** Comprobación manual del usuario, junto con la CA-12 del 046.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Corregir ocho cosas a la vez sobre código recién escrito puede introducir defectos nuevos. | Un commit por hallazgo, cada uno con su test, y la batería completa entre medias. |
| La columna nueva obliga a una segunda migración en la misma rama. | Es aditiva como la primera, y **no se edita la del 046**: esa podría estar ya aplicada en algún sitio, y reescribir una migración aplicada es la peor forma de ahorrarse un fichero. |
| Recalcular al aprobar (R-4) cambia una conducta que ya tiene tests. | Los tests existentes se conservan; los que cambian de significado se reescriben diciendo por qué. |

## Referencias oficiales

Ninguna: este spec no habla con ningún venue ni con ningún SDK nuevo.
