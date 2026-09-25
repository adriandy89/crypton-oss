# 075 — Revisión del spec 074 antes de operar con dinero real

Estado: `hecho` · Tipo: `revisión` · Rama: `spec/075-revision-074` (sale de
`spec/074-agentes-ia`)

## Objetivo

Revisar, antes de ningún merge, despliegue u operación real, todo lo que el spec 074 cambia: los
agentes de IA, su operación `AGENT_TRADE`, el cambio del runner, el módulo `ai-desk`, Telegram y
la app. Cada hallazgo tiene que quedar con severidad, evidencia y estado.

Estará hecho cuando:
- `findings.md` esté completo;
- cada hallazgo confirmado tenga su test o su evidencia;
- los que el usuario apruebe corregir estén corregidos con el protocolo de la constitución.

## Contexto

- **La petición.** El plan del 074, aprobado por el usuario el 2026-09-24, cierra con una revisión
  «antes de dinero real sobre la rama, como 047 con 046»: el 074 opera con dinero real desde el
  primer día, con los frenos del servidor apagados por decisión del usuario.
- **Lo que enseñaron las anteriores.** El 047 encontró catorce defectos con 6891 tests en verde; el
  060, 63 con tres Críticos. Los tests en verde no bastan: hace falta leer el código con la escala
  de la constitución delante.

## Alcance

`git diff c7fec40..spec/074-agentes-ia`: 17 commits y 188 ficheros. Una revisión independiente por
área:

| Área | Qué |
|---|---|
| OP | La operación `AGENT_TRADE` y la gestión de posición movida del canal (`operacion/gestion.ts`) |
| MO | El motor de los agentes: límites, familias, herramienta, juez, propuesta, seguimiento y medición |
| WK | El worker: el contexto de operación del runner, el vigilante del stop, `detener`, los avisos, el notificador y el poller de Telegram |
| AP | La API: aprobación, recálculo, conciliación, recuperación, rondas, cupos, seguimiento y la exención `soloReduceRiesgo` de `updateConfig` |
| AC | Acceso, datos y operación: guardas y rutas, *kill switch*, esquema, migraciones e índices, retención, medición, listados y variables |
| UI | La app y la exactitud de las guías |

## Fuera de alcance

- Llamadas reales al modelo o firmadas a los venues (los CA-12 a CA-14 del 074 son del usuario).
- Cualquier cambio que no nazca de un hallazgo.

## Requisitos

- **R-1** — **Revisión independiente.** Cada área la revisa alguien que no modifica nada. Cada
  hallazgo se verifica leyendo el código antes de anotarlo.
- **R-2** — **Formato de los hallazgos.** Cada uno lleva id `F-NN`, severidad según la escala de
  `specs/README.md`, evidencia `fichero:línea` y un escenario concreto.
- **R-3** — **Confirmación.** Un hallazgo confirmado tiene un test que falla o una evidencia
  equivalente.
- **R-4** — **Correcciones.** Solo con la aprobación del usuario, que ve antes la lista. Se sigue el
  protocolo de la constitución: test que falla, arreglo mínimo y un commit por hallazgo.

## Criterios de aceptación

- **CA-1** — `findings.md` con resumen, fichas, lo verificado y las preguntas abiertas.
- **CA-2** — Cada Crítica confirmada con un test que falla por el motivo declarado.
- **CA-3** — Las correcciones aprobadas, un commit cada una, con los tests del paquete y de sus
  dependientes en verde.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un revisor que «arregla» al revisar | Los revisores no editan: devuelven hallazgos, y cada uno se verifica antes de anotarlo |
| Falsos positivos que disparan cambios | Una Crítica sin test que falle queda «por confirmar» y no toca código |
| Corregir de más dentro de la revisión | Solo Críticas confirmadas y aprobadas; lo demás, a specs de seguimiento |
