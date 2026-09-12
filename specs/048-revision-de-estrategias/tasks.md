# 048 — Tareas

## Fase 0 — Revisión

- [x] Las nueve estrategias leídas una por una: `validate()`, `preview()`, `plan()` y descriptor
- [x] Barrido de parámetros muertos: ninguno en las nueve
- [x] Contraste entre estrategias, que es lo que destapó H-01 y H-02
- [x] `findings.md` con los tres hallazgos, dos de ellos medidos
- [x] Candidato a Crítica (entrada a mercado en `orders`) verificado y **descartado**

## Fase 1 — Correcciones

- [x] Los tres tests, escritos antes y **fallando por el motivo declarado**
- [x] H-02 · TDCA: la compra se recorta al hueco que queda bajo el tope
- [x] H-01 · NEUTRAL_GRID: el tope acota lo que se tiende, con el patrón de la rejilla clásica
- [x] H-01b · la proyección usa precio y cantidad **ya redondeados**: sin eso, una línea que cabía
      por céntimos dejaba de caber al mandarse (el redondeo de una venta va hacia arriba)
- [x] H-03 · la proyección de la línea extrema sigue la ley de la retícula
- [x] Test de control: con el tope holgado se tiende la retícula entera

## Cierre

- [x] `pnpm test` (6791), `pnpm lint`, `ng build`
- [x] Índice de `specs/README.md`
- [ ] CA-5: comprobación manual del usuario
