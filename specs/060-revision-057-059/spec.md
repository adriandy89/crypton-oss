# 060 — Revisión de los specs 057 a 059 antes de desplegar

Estado: `en curso` · Tipo: `revisión` · Rama: `spec/060-revision-057-059` (sale de
`spec/059-canal-ia`)

## Objetivo

Revisar, antes de cualquier merge o despliegue, todo lo que la cadena 057 → 058 → 059 cambia
respecto de `main`. Cada hallazgo tiene que quedar con severidad, evidencia y estado.

Estará hecho cuando:
- `findings.md` esté completo;
- cada hallazgo confirmado tenga su test o su evidencia;
- los que el usuario apruebe corregir estén corregidos con el protocolo de la constitución.

## Contexto

- **La petición.** El usuario la hizo el 2026-09-17, al cerrar el 059: «Revisa todos los cambios y
  la lógica para estar seguros quedó todo bien».
- **Lo que decía el plan aprobado.** El 060 era la revisión de 058-059 tras 48-72 h de simulación.
  Esto adelanta la parte estática y amplía el alcance al 057, que tampoco está en `main` y es lo
  primero que se despliega.
- **Lo que queda para después.** La parte que necesita datos de la simulación (al menos 100
  decisiones reales) es la fase 2 de este mismo spec.

## Alcance

`git diff main...spec/059-canal-ia`: 38 commits y 196 ficheros. Una revisión independiente por
área:

| Área | Qué |
|---|---|
| EX | `exchange-core`, `reconcile`, Tendencia, velas y el resto de correcciones del 057 |
| MA | Las piezas numéricas del canal y la regla del apalancamiento por stop |
| ES | La herramienta, el juez, la configuración y la estrategia `AI_CHANNEL` |
| WK | El worker: runner, almacenes, motor, avisos y retención |
| IA | El lazo de la IA en la API, el cliente del modelo y el botón de pausa |
| AC | El acceso de administradores, el riesgo, la base de datos y el backtest |
| UI | La app, las vistas compartidas y la exactitud de las guías |

## Fuera de alcance

- Llamadas reales al modelo o firmadas a los venues (el CA-10 del 059 sigue siendo del usuario).
- La simulación de 48-72 h (fase 2).
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
- **CA-2** — Cada hallazgo tiene estado.
- **CA-3** — Los corregidos tienen su test (antes y después), la verificación completa en verde y
  la mutación de su arreglo cazada.
- **CA-4** — *(usuario, fase 2)* La revisión de al menos 100 decisiones reales tras la simulación.

## Riesgos

- **Falsos positivos de los revisores.** Cada hallazgo se verifica en el código y, cuando se puede,
  con un test.
- **Bots en marcha.** Nada se despliega sin aprobación, y las correcciones van solo en la rama.
