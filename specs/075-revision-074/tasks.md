# 075 — Tareas

- [x] Línea base (`build:packages`, `test`, `lint`, `check:env`, `check:labels`): verde
- [x] Revisión OP — la operación `AGENT_TRADE` y la gestión movida del canal (8 hallazgos)
- [x] Revisión MO — el motor de los agentes (7)
- [x] Revisión WK — el worker y Telegram (5, más 6 preguntas)
- [x] Revisión AP — la API: aprobación, rondas, seguimiento y `soloReduceRiesgo` (11)
- [x] Revisión AC — acceso, datos y operación (6, dos con test que falla)
- [x] Revisión UI — la app y las guías (12)
- [x] Verificación de cada hallazgo en el código y `findings.md`: 43 fichas tras fundir los
  repetidos (1 Crítica, 5 Altas, 18 Medias, 19 Bajas). F-01 confirmada con un test de la estrategia
  que falla por el motivo declarado (en el scratchpad hasta el arreglo); F-03 y F-08, con los tests
  del revisor AC, que también fallan
- [x] Aprobación del usuario de las Críticas a corregir (F-01) y respuesta a las preguntas abiertas:
  un cuestionario con 20 decisiones el 2026-09-25 («Respuestas del usuario» en `findings.md`)
- [x] Correcciones aprobadas, una por commit, con su test que falla primero: F-01 en `a0116c9`
  (`agent-trade.f01.spec.ts` falla antes por el motivo declarado; cada mitad del arreglo, saboteada,
  hace fallar su caso). strategy-core 994, worker 681 y backtest 75 en verde, más el typecheck, el
  lint y la build de la app
- [x] Seguimientos asignados: F-02 a F-24 (lo Alto y lo Medio) al 076, con las decisiones del
  cuestionario; F-25 a F-43 (lo Bajo) al 077, un lote de limpieza tras el 076, que confirma antes
  F-42. Sus specs se escriben al empezarlos
- [x] Mezcla a `main` de 073, 074 y 075 a petición del usuario (2026-09-25), sin esperar al 076:
  `AI_DESK_ENABLE` sigue apagado en producción hasta que el 076 esté hecho
