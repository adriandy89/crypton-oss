# 060 — Tareas

## Fase 1 — Revisión

- [x] Rama `spec/060-revision-057-059` desde la punta del 059, `spec.md`, `plan.md` y fila del índice
- [x] Siete revisiones independientes (EX, MA, ES, WK, IA, AC, UI)
- [x] Revisión transversal: `bot_ai_intents` entre worker, API y migración (F-04)
- [x] Verificación de cada hallazgo: las Críticas y F-07 con test en el repo que falla por su motivo
- [x] `findings.md`: 63 hallazgos (3 Críticos, 9 Altos, 18 Medios, 33 Bajos)

## Fase 2 — Correcciones (con la aprobación del usuario)

- [x] Lista aprobada (2026-09-17): F-01, F-02, F-03, F-07 y F-15, con el pico rearmado al reanudar
- [x] Un commit por hallazgo, con su test que fallaba y sus mutaciones cazadas
      (`523f11d`, `be0fdaf`, `ebc5c9e`, `2a78e47`, `93b1ef1`)
- [x] Verificación completa: 8073 tests en verde (shared 201, strategy-core 758, exchange-core 482,
      worker 580, backtest 64, API 5988), lint sin errores, `check:env` coherente y las tres builds
- [x] Guías: bloques «Limitación conocida» de F-04, F-05, F-06, F-08 y F-12

## Fase 3 — Tras la simulación (usuario)

- [ ] Revisión de al menos 100 decisiones reales
