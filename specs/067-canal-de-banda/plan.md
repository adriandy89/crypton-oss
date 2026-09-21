# 067 — Plan

## Enfoque

No se escribe una estrategia nueva. Todo lo que hace ganar a la regla medida —el filtro de régimen,
el objetivo en la media, el tope de velas, las puertas de coste del 066, el dimensionado, el stop
nativo, el breakeven y el motor entero— **ya está en `AI_CHANNEL`**. Lo único que falla es dónde
busca las líneas, y lo lejos que pone el stop de ellas.

Y hay una razón de diseño por la que esto cabe: todo lo que hay aguas abajo trabaja contra
`CanalDetectado`, que es soporte, resistencia, media y una pendiente. **Nadie aguas abajo pregunta
cómo se trazaron esas líneas.** Así que un tipo de canal nuevo es una función que devuelve unas
líneas, y ya.

## Pasos

1. `TipoCanal.BANDA` en `packages/shared`. No es enum de Prisma: sin migración.
2. `lineasDeBanda()` en `canales.ts` y un candidato más en `detectarCanal`. Reutiliza `evaluar()`
   entera, que ya es genérica sobre unas líneas: por eso las nueve puertas que sí le aplican le
   aplican **solas**, sin escribir nada.
3. El toque, en el décimo exterior de la anchura (`DECIMO_BANDA`), y el `eps` de `setups.ts` con el
   mismo criterio para el tipo `BANDA`.
4. `ATR_POR_STOP` pasa a ser un mapa por tipo de canal.
5. `allowedChannels` admite `BANDA` y pasa a desplegable (cuatro opciones no caben en una fila).
6. Guía, etiquetas y `docs/ai-channel.md`.
7. **La medición**: walk-forward con `runReplay`, 12 pares × 190 días, contra la línea base del 066.

## Lo que costó, y no estaba en el plan

- **Una banda a dos sigmas no se toca nunca.** Es geometría, no una peculiaridad del mercado: un
  seno de amplitud A tiene sigma 0,71·A, o sea bandas en ±1,41·A. Ninguna oscilación acotada alcanza
  su propia banda. La regla medida no entraba EN la banda sino en su décimo exterior (%B ≤ 0,1), y
  eso hubo que llevarlo también al `eps` de los setups o el rebote no dispara nunca.
- Por lo mismo, los fixtures sintéticos necesitan **mecha explícita**: con la de por defecto (0,05)
  el precio se queda a las puertas y el test mide lo contrario de lo que dice medir.

## Riesgo principal

Que la banda encuentre **mucho** sitio y todo malo. Por eso la medición no es «¿opera más?» sino los
tres números de CA-5 a la vez, y por eso el defecto de `allowedChannels` no se toca hasta tenerlos.
