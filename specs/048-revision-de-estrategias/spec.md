# 048 — Revisión de las nueve estrategias

Estado: `hecho` (falta comprobación manual) · Tipo: `revisión` · Rama: `spec/048-revision-de-estrategias`

## Objetivo

Releer las nueve estrategias una por una —lógica y parámetros— y corregir lo que no hace lo que
promete. Se sabrá que está hecho cuando un tope de exposición acote de verdad lo que el bot va a
tender, en las cinco estrategias que tienen uno.

## Contexto

Lo pidió el usuario, sin incidente previo. Las estrategias llevan seis specs de revisión encima
(019, 026, 029, 030, 037, 041, 044), así que lo interesante no era buscar defectos nuevos sino
**comprobar que las correcciones viejas se aplicaron donde tocaba**. Ese fue el método que rindió:
contrastar cada estrategia contra las demás, porque una regla que una aplica y otra no casi siempre
significa que una corrección no se propagó.

Y eso es exactamente lo que apareció. El spec 001 (F-87) corrigió en la rejilla clásica un tope que
no acotaba nada hasta después de superarse. Martingala y GridMart ya lo hacían bien. La rejilla
neutral y el DCA temporizado se quedaron con el defecto, **y el comentario que lo explica lleva
desde entonces en el fichero de al lado**.

## Alcance

- `packages/strategy-core/src/strategies/{neutral-grid,tdca,grid-classic}.ts`
- `packages/strategy-core/src/strategies.spec.ts`

## Fuera de alcance

- Los dos market makers: se revisaron y no salió nada. Llevan cinco specs propios encima (018, 029,
  035, 037, 039) y se nota.
- Cambiar valores de fábrica o rangos de cualquier campo.
- El Modo IA (specs 046 y 047), que vive en otra rama.

## Requisitos

- **R-1** El tope de exposición de la rejilla neutral acota lo que se **tiende**, no solo lo que ya
  está abierto. Se admiten líneas de la más cercana al precio hacia fuera y se corta en la primera
  que no quepa, igual que la rejilla clásica (H-01).
- **R-2** La compra del DCA temporizado no rebasa el tope: si no cabe entera, se compra lo que quepa
  (H-02).
- **R-3** La proyección de la línea extrema de una rejilla clásica usa la **misma ley** que la
  retícula: multiplicativa en geométrica, aditiva en aritmética (H-03).
- **R-4** Las proyecciones de notional se calculan con el precio y la cantidad **ya redondeados a la
  retícula del venue**, porque son los que se van a mandar.

## Criterios de aceptación

- **CA-1** `pnpm test`, `pnpm lint` y `ng build` en verde.
- **CA-2** Un test comprueba que la retícula neutral tendida cabe en el tope partiendo de posición
  cero, y otro que con el tope holgado se sigue tendiendo entera (R-1).
- **CA-3** Un test comprueba que la compra del DCA más lo ya abierto no pasa del tope (R-2).
- **CA-4** Dos tests comprueban la proyección de la línea superior en geométrica y en aritmética
  (R-3).
- **CA-5** Comprobación manual del usuario: un bot de rejilla neutral con tope bajo tiende menos
  líneas que antes y lo dice en su nota.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| **Cambia la conducta de bots en marcha**: un bot con tope pasará a tender menos líneas de las que tiende hoy. | Es lo que el tope prometía y el usuario lo autorizó expresamente. Un test fija que con el tope holgado no cambia nada. |
| Cortar líneas podría dejar la retícula sin contrapartida. | Las órdenes que **reducen** posición se dejan siempre; el corte solo afecta a las que aumentan. |
| La proyección geométrica cambia el precio de salida de líneas ya tendidas. | El reconciliador las recoloca en el tick siguiente, y el precio nuevo es más alto: vende más arriba, no antes. |

## Referencias oficiales

Ninguna: no se apoya en ninguna regla de venue ni de SDK.
