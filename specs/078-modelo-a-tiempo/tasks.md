# 078 — Tareas

- [x] Línea base: `pnpm --filter api test` en verde en `main` (88 suites, 6295 tests)
- [x] A — Plazo por carga, 90 s de fábrica con tope de 120 s, aviso al arrancar y uso en la
  decisión (`2619504`). 16 tests en rojo antes del arreglo. El canal se queda con su minuto y en
  `medium`, por decisión del usuario, tras corregir el dato de «seis minutos» del plan
- [x] B — «Analizar ahora» y «Revisar ahora» fuera de la petición; cerrojo de un minuto más el
  plazo; vida de la propuesta contada desde que existe; la app espera la ronda (`e0f9132`)
- [x] C — Sin modelo, el seguimiento decide el juez (decisión 4 del 075), sin huella y con la
  racha (`444acb7`)
- [x] D — La ronda de entrada fallida guarda sus candidatos, y la tarjeta no los cuenta al medir si
  la IA discrimina (`c8ce0ce`)
- [x] E — Consultas sin coste conocido (agente y tarjeta), «N de 5» con su consecuencia, el porqué
  de cada ronda fallida y del juez en lugar del modelo (`ce1eb65`). Los dos contadores, saboteados,
  hacen fallar su test
- [x] Guías, `.env.example` y compose; el 075 anota que su decisión 4 se hizo aquí
- [x] Verificación (2026-09-25): build de paquetes; shared 250, strategy-core 994, exchange-core
  517, worker 681, backtest 75 y API 6327 (89 suites) en verde, paquete a paquete; lint, check:env y
  check:labels sin errores; typecheck y build de la app
- [ ] CA-8 y CA-9 (del usuario)
