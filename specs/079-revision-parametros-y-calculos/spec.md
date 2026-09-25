# 079 — Revisión de parámetros y cálculos de todas las estrategias

Estado: `hecho` · Tipo: `revisión` · Rama: `spec/079-revision-parametros-y-calculos` (sale de
`main` en `bdb3f5e`)

## Objetivo

Revisar qué significa cada parámetro de cada estrategia, cómo se calcula cada cifra que la app
enseña antes de crear un bot, y si coincide con lo que el motor hará después. Cada defecto queda en
`findings.md` con severidad, evidencia y estado.

Estará hecho cuando `findings.md` recoja cada hallazgo confirmado en el código, y las decisiones del
usuario que salen de él queden anotadas para el spec de cambio (080).

## Contexto

El 2026-09-25 el usuario prepara un **Seguimiento de beneficio** en corto con estos datos: 15×,
120 USDC y objetivo del 15 % (el valor de fábrica). La pantalla «Revisión» le enseña:

| Cifra | Valor |
|---|---|
| Entrada | 84601 |
| Objetivo de beneficio | 71911 |
| Liquidación | 89184 |
| Aguanta un movimiento de | 5,60 % |
| Aviso | «15× liquida con un movimiento adverso de ~6,7 %» |

No entiende de dónde sale ninguna, y pide revisar **todos los parámetros y cálculos de todos los
tipos de bot**.

Reconstruido del código:

- **Objetivo:** el 15 % es del **precio**. 84601 × 0,85 = 71911, que a 15× es **+225 % del margen**.
- **Tres distancias a la liquidación en la misma pantalla:**
  - 5,42 % desde la entrada con la fórmula lineal;
  - 5,60 % desde el precio de hoy;
  - 6,7 % = `100/15`, sin mantenimiento.
- **Stop:** el de fábrica (5 % del precio = −75 % del margen) queda a 0,4 % de la liquidación y **no
  aparece**.

## Alcance

Las once estrategias de `packages/strategy-core/src/strategies/`, más:

- `common.ts` (`buildPreview`, `validateCommon`, `camposEfectivos`), `ladder.ts`, `stop-loss.ts` y
  `trailing-take-profit.ts`;
- `packages/shared/src/liquidation.ts`;
- lo que la API valida y genera: riesgo, asesor y supervisor;
- lo que la app enseña al crear un bot (`bot-create`, medidor de riesgo, recomendaciones);
- los rótulos, ayudas y guías de cada parámetro (`field-labels.ts`, `core/content/*.guide.ts`,
  `docs/`).

## Fuera de alcance

- Cambiar código. Todo lo que se corrige va al spec 080.
- Sondas contra los venues. Las fórmulas de liquidación se contrastan con la documentación
  oficial, sin llamar a sus APIs.
- La lógica de decisión de las IA (canal y agentes), salvo en lo que enseña su previsualización.

## Requisitos

- **R-1** — Cada hallazgo se comprueba leyendo el código antes de anotarlo, con `fichero:línea`.
  Lo que no se confirma se descarta.
- **R-2** — La fórmula de liquidación se contrasta con la documentación oficial de Hyperliquid,
  Lighter y Aster, con URL, fecha y cita literal.
- **R-3** — Severidad según la escala de `specs/README.md`.
- **R-4** — Las decisiones que solo puede tomar el usuario se le preguntan y se anotan con su
  respuesta.

## Criterios de aceptación

- **CA-1** — `findings.md` con línea base, referencias oficiales, resumen, fichas, lo verificado y
  las decisiones.
- **CA-2** — El caso del usuario reconstruido cifra a cifra.
- **CA-3** — Cada hallazgo, enlazado a la fase del 080 que lo corrige.

## Riesgos

Ninguno de ejecución: el spec no cambia código.

## Referencias oficiales

Ver `findings.md`, sección «Referencias oficiales».
