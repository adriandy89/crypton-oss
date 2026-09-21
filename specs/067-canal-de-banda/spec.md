# 067 — El canal de banda: que el bot de IA encuentre dónde operar

Estado: `hecho, sin desplegar` (CA-5 cumple 1 de sus 3 condiciones; ver `findings.md`. Falta CA-6, la simulación del usuario) · Tipo: `cambio` · Rama: `spec/067-canal-de-banda`

## Objetivo

Que `AI_CHANNEL` opere lo suficiente y con ventaja medible. El spec 066 dejó demostrado que el
problema no es ninguna puerta ni ningún parámetro, sino **dónde busca**: el mercado está en un canal
como lo define `detectarCanal` el **3,7 % del tiempo**, y de esos casi ninguno paga el viaje.

Se sabrá conseguido cuando el walk-forward sobre doce pares y ciento noventa días dé **≥ 2
operaciones al mes y par**, **R medio positivo con t > 2** y **≥ 4 de 6 ventanas positivas**. Son
los mismos tres números del 066, que allí fallaron por mucho: 0,46 · 0,39 · 2/6.

## Contexto: lo que sí midió ventaja

Sobre los **mismos** 12 pares y 190 días de velas de 5 min, y con el mismo motor de estadística del
repo (`canal/estadistica.ts`), una regla mucho más simple:

- velas de **15 min**;
- banda de **Bollinger(20, 2)** sobre los cierres;
- solo con **ADX(14) < 20** — el filtro de régimen que el bot ya tiene;
- entrada cuando el precio toca la banda (%B ≤ 0,1 largo, ≥ 0,9 corto);
- **stop a 2 ATR(14)**;
- objetivo en la **media de la banda** — que es exactamente `EsquemaObjetivo.MEDIA`;
- tope de 24 velas — que es `maxHoldBars`;
- y la puerta del 066: el objetivo, en múltiplos del coste de ida y vuelta.

| Objetivo mínimo | n | R medio | t | pares + | meses + |
|---|---|---|---|---|---|
| ≥ 25× coste | **1.804** | +0,060 | **2,12** | — | **5/8** |
| ≥ 30× coste | 1.244 | +0,073 | **2,13** | — | 5/8 |

Es el único resultado positivo y estadísticamente distinguible de cero de toda la investigación, y
aparece **unas doscientas veces más a menudo** que un canal de giros (1.804 frente a 9).

Dos avisos, por delante:

1. **Depende del venue.** Con costes de Hyperliquid la misma regla es negativa. Sobrevive a un
   deslizamiento de 2 a 4 puntos básicos y **muere a 6**. Es una estrategia de venue sin comisión.
2. La medición es de **etiquetado por triple barrera**, no del motor completo. El motor añade
   confirmaciones, spread, dimensionado, stop nativo, breakeven y cierre por tiempo. CA-5 es el que
   manda, no esta tabla.

## La idea, y por qué cabe en lo que ya hay

Casi todo lo que hace ganar a esa regla **ya está en el bot**: el filtro de régimen, el objetivo en
la media, el tope de velas, la puerta de coste y el motor entero. Solo cambian dos piezas:

1. **Dónde están las líneas.** Un tipo de canal nuevo, `BANDA`, cuyo soporte y resistencia son las
   bandas de Bollinger y cuya media es la media móvil. Todo lo que hay aguas abajo —los setups, la
   herramienta, el juez, la IA, el motor— trabaja contra `CanalDetectado` y **no tiene que
   enterarse** de cómo se trazaron esas líneas.
2. **Lo lejos que va el stop.** `ATR_POR_STOP` pasa a depender del tipo de canal. Un borde de giros
   es un precio que el mercado defendió de verdad y el stop puede ir pegado; una banda es una
   frontera estadística, y ahí el stop tiene que ir **fuera**: 1 / 1,5 / 2,5 ATR en vez de
   0,25 / 0,5 / 1.

## Requisitos

- **R-1** `TipoCanal.BANDA`, con su validación en las vistas compartidas. No es un enum de Prisma,
  así que **no hay migración**.
- **R-2** `detectarBanda()` en `canales.ts`, evaluada junto a las otras y compitiendo por
  puntuación. Le aplican las puertas que significan algo para una banda —contención, anchura en ATR,
  anchura en costes, cruces, media vida, toques y recencia— y **no** le aplican las que solo tienen
  sentido sobre dos rectas trazadas desde giros: alternancia de pivotes, R² de las rectas,
  paralelismo y pendiente plana. Cada exclusión, con su razón escrita en el código.
- **R-3** La escalera de stops depende del tipo de canal, con el porqué en el comentario.
- **R-4** `allowedChannels` admite `BANDA`, y `TODOS` la incluye. **El defecto no cambia** hasta que
  CA-5 diga que debe cambiar: hay bots en marcha.
- **R-5** Guía in-app, etiquetas y `docs/ai-channel.md`, con los números medidos y los dos avisos.

## Criterios de aceptación

- **CA-1** Una serie con la banda ancha y el precio contenido detecta canal `BANDA`; una en
  tendencia, no. Test en `canales.spec.ts`.
- **CA-2** Las puertas de pivote no se le aplican: una banda sin un solo giro alternado se detecta.
- **CA-3** El stop de una `BANDA` sale a 1 / 1,5 / 2,5 ATR y el de un `HORIZONTAL` sigue a
  0,25 / 0,5 / 1. Test en `herramienta.spec.ts`.
- **CA-4** Batería completa en verde y typecheck de la app.
- **CA-5 — el que decide.** Walk-forward con `runReplay` sobre 12 pares × 190 días: **≥ 2
  operaciones al mes y par**, **R medio positivo con t > 2**, **≥ 4 de 6 ventanas positivas**.
- **CA-6 (manual, usuario)** Un bot simulado por par durante dos semanas antes de dinero real.

## Criterio de parada

Si CA-5 no se cumple, el tipo `BANDA` se queda **apagado por defecto** y el spec se cierra con el
resultado en `findings.md`. No se afloja ninguna puerta para forzar el número: el 066 ya demostró
que por ahí no se sale.

## Lo que NO se toca

- El filtro de régimen, el motor, el stop nativo, el apalancamiento por stop y el vigilante.
- Los defectos de los bots que ya operan.
- Las dos puertas de coste del 066, que son las que hacen que la banda solo se opere donde paga.
