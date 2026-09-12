# 047 — Tareas

## Fase 0 — Línea base

- [x] `findings.md` con los ocho hallazgos, con evidencia y severidad
- [x] `spec.md` y decisiones del usuario anotadas
- [x] Línea base verde sobre `aaf5120`

## Fase 1 — Las dos Altas

- [x] F-02: `fallo()` guarda lo que de verdad pasó, y el historial del expediente solo lleva
      decisiones que el modelo puede reconocer como suyas
- [x] F-01: se guardan los rasgos del par al activar el modo (columna + migración) y el expediente
      los usa; test de que el prompt lleva el cambio de régimen

## Fase 2 — Las cinco Medias

- [x] F-04: aprobar desde Telegram recalcula; el texto de R-23 y de `docs/` pasa a ser cierto
- [x] F-09: el tope diario frena solo al automático
- [x] F-05: el barrido respeta el disparador
- [x] F-07: el expediente descarta un estado viejo y lo dice
- [x] F-06: un aviso tiene su propio estado terminal
- [x] F-03: la columna `model` guarda el modelo

## Fase 3 — La Baja y el cierre

- [x] F-08: `AI_AGENT_REVIEW_TTL_S` fuera de los tres sitios
- [x] `pnpm test` (6904), `pnpm lint`, `pnpm check:env` y `ng build`: todo en verde
- [x] Índice de `specs/README.md`; R-23 y `docs/administracion.md` ya dicen la verdad
