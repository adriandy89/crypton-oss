# 068 — Tareas

| # | Tarea | Estado |
|---|---|---|
| T-1 | `shared/ia-trader.ts`: el vocabulario, todo enumeraciones | hecho |
| T-2 | `trader/senal.ts`: los rasgos, con tasas reales por triple barrera | hecho |
| T-3 | `trader/esqueletos.ts`: la matriz 3 × 3, valorada y validada (R-3, R-4) | hecho |
| T-4 | `trader/construir.ts` y `cuantiza()`: la frontera del invariante 13 (R-5) | hecho |
| T-5 | `trader/juez.ts`: el brazo de control (R-6) | hecho |
| T-6 | `trader/config.ts` y `strategies/ai-trader.ts` con su `meta.fields` (R-7) | hecho |
| T-7 | Enum de Prisma + migración, espejo en `shared`, `ESTRATEGIAS_SOLO_ADMIN`, `registry.ts` | hecho |
| T-8 | El worker: `REANCHOR_NO_APLICA` y la reserva de cupo por venue, compartida | hecho |
| T-9 | El backtest: aviso de fidelidad | hecho |
| T-10 | La app: unión, los tres `Record`, la guía, las etiquetas y los cinco sitios sueltos | hecho |
| T-11 | Documentación y el renombrado visible de `AI_CHANNEL` a «Canal» | hecho |
| T-12 | Batería completa (8.246), `lint` y `check:env` (CA-3) | hecho |
| T-13 | Walk-forward y el veredicto en `findings.md` (CA-4 a CA-9) | hecho (2 de 3) |

## Fuera del plan, y por qué

| Qué | Por qué |
|---|---|
| `dimension.ts` | El dimensionado por tramos vivía dentro de `opcionDeStop`. Se **extrajo** en vez de copiarse: sesenta líneas que deciden cuánto dinero entra en una orden no pueden estar en dos sitios. `herramienta.spec.ts` pasa sin tocarlo, que es la prueba de que no se desvió. |
| `trader/estado.ts` | Hacía falta para la prueba contra BTC real, y vive en `strategy-core` —no en la API— porque el backtest tiene que poder generar el mismo estado byte a byte. |
| Umbrales de confianza recalibrados | Estaban en 0,90 copiados de la documentación del proveedor. Probando contra BTC real el modelo **no pasó de 0,61**: con 0,90 el bot no operaría jamás. |
| Tasas reales en la señal | La pregunta del histórico se quedaba en 0,2-0,36 porque no se le daba nada que juzgar. |
| `OfertaDecision` y `PlanDecision` | Cada estrategia tiene su forma de oferta y de plan, y las dos viven en la misma columna. Se distinguen por una clave propia, no por el nombre de la estrategia. |
