# 066 — Plan

## Enfoque

El spec no inventa aritmética nueva: usa un número que `opcionDeStop` **ya calcula** y que hoy solo
se le enseña a la IA como información —`costeR`, la parte del presupuesto de riesgo que se van las
comisiones y el deslizamiento— y lo convierte en **puerta**. Y añade la segunda puerta que la
medición señala: el objetivo medido en múltiplos del coste, no en múltiplos del stop.

Las dos son **campos de usuario** con su defecto, no constantes escondidas: el valor sale de siete
meses de un mercado y hay que poder moverlo sin desplegar.

## Pasos

1. `canal/config.ts` — `maxCostPerTradeR` (0,2) y `minTargetCostMultiple` (15) en `DEFAULTS_CANAL`,
   sus lectores y sus dos campos en `ConfigCanal` (`maxCosteR`, `minObjetivoCoste`).
2. `canal/herramienta.ts` — las dos puertas en `opcionDeStop`, justo después de `porUnidad`, con sus
   motivos `COSTE` y `OBJETIVO_CORTO`. La segunda reutiliza `costeIdaVuelta`, que ya existe.
3. `strategies/ai-channel.ts` — los dos campos en `meta.fields` (grupo `risk`, marcados de riesgo) y
   en la interfaz `AiChannelConfig`, que es la que consume la guía de la app.
4. Los **fixtures** de test se hacen permisivos a propósito, no por comodidad: los tests del motor
   (`backtest/testing-canal.ts`, `worker/bot-runner.canal-e2e.spec.ts`) miden el recorrido de una
   operación escrita a mano, no la selección de entradas, y con los defectos de producción no
   llegarían a abrir. Las puertas tienen sus propios tests en `canal/herramienta.spec.ts`.
5. Guía in-app, `field-labels.ts` y `docs/ai-channel.md`, con los números medidos.
6. **La medición**, que es lo que decide: walk-forward con `runReplay` sobre 12 pares × 190 días.

## Herramienta de medición

Vive en el scratchpad de la sesión, no en el repo: `walk2.cjs` (walk-forward con el perfil de costes
del venue como parámetro), `informe.cjs` (el desglose) y `puertas2.cjs` (el contador de motivos de
rechazo, con el **coste marginal** de cada puerta: cuántos ticks se desbloquearían si esa puerta, y
solo esa, no existiera). Los datos son 12 pares × 60.480 velas de 5 min de la API pública de Aster,
el único venue público con más de 5.000 velas de ese intervalo.

## Riesgo principal

Las tres puertas son restrictivas. Si el bot deja de operar, el spec ha fracasado aunque el R suba;
por eso el criterio de parada está escrito en `spec.md` **antes** de medir.
