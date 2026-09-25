import type { OptionDoc } from './types';

/**
 * Fichas de la escalera de seguridad: los cinco parámetros que comparten la
 * martingala y GridMart (`EscaleraConfig`).
 *
 * Viven aparte porque GridMart REUSA el mismo bloque de campos que Martingala
 * (`gridmart.ts` importa `MARTINGALE_FIELDS`), y escribir dos veces la
 * explicación de `volumeScale` es como acaban diciendo cosas distintas del mismo
 * número. GridMart parte de aquí y reescribe solo las que cambian de sentido
 * dentro de su ciclo. El take profit y su modo son solo de la martingala:
 * GridMart sale por el satélite y por la rejilla del núcleo (spec 080, P-7).
 */
export const LADDER_OPTION_DOCS = {
  baseOrderType: {
    what: 'Cómo entra la primera orden del ciclo: a mercado, que se ejecuta al instante al precio que haya, o limitada al precio actual.',
    affects:
      'A mercado el bot arranca siempre, pero pagas comisión de taker y entras al precio del momento. Limitada se coloca post-only al precio del momento y espera quieta: no persigue al precio y, si en cinco minutos no se ha ejecutado, se vuelve a colocar al precio de entonces. Igual en Martingala y en GridMart.',
    tip: 'A mercado si quieres arrancar seguro; limitada si prefieres ahorrar la comisión de taker y no te importa esperar a que el precio venga a buscarla.',
  },
  numLimitBuys: {
    what: 'Cuántas órdenes de seguridad se cuelgan en contra de la entrada base —por debajo en largo, por encima en corto—, esperando a que el precio vaya en contra.',
    affects:
      'Cada una que se ejecuta mejora tu precio medio y AUMENTA la posición. Más seguridades aguantan un movimiento más profundo, pero también es más dinero comprometido si no se da la vuelta.',
    tip: 'El número solo no dice nada: lo que decide hasta dónde aguantas es este número junto a la separación y la escala de distancia.',
  },
  initialSeparationPct: {
    what: 'A qué distancia de la entrada base se cuelga la PRIMERA seguridad, en % del precio.',
    affects:
      'Separaciones cortas hacen que las seguridades se ejecuten pronto y gastes munición en un ruido de mercado. Separaciones largas guardan la munición para una caída de verdad, pero tardan más en bajarte la media.',
    tip: 'En un par volátil como DOGE, un 1 % se toca varias veces al día; en BTC es una caída seria.',
  },
  stepScale: {
    what: 'Cuánto se aleja cada seguridad respecto de la anterior. Con 1 todas van a la misma distancia; con 1,5 cada hueco es un 50 % más ancho que el de antes.',
    affects:
      'Es lo que decide la PROFUNDIDAD total que cubre la escalera. Subirlo estira la cobertura sin añadir órdenes, a cambio de que tu media baje más despacio al principio.',
    // Decía que la app rechazaba la escalera si NO cubría la distancia a la
    // liquidación: era al revés, y además no contaba que la liquidación se
    // mueve con la media (079/F-19).
    tip: 'La app recorre la escalera nivel a nivel con la media de lo ya comprado: si la liquidación llega antes que una seguridad, en margen aislado es un error (en cruzado, un aviso), y si el stop salta antes, un aviso. Una seguridad que no se ejecutaría nunca no sirve de nada.',
  },
  volumeScale: {
    what: 'Cuánto crece cada seguridad respecto de la anterior. Con 2, cada una compra el doble que la de antes.',
    affects:
      'Es el parámetro que hace de esto una martingala. Subirlo baja tu precio medio mucho más rápido, pero concentra casi todo el capital en los últimos escalones, que son los que se ejecutan cuando la caída ya es grave.',
    tip: 'Por encima de 2,5 la app avisa. El reparto es proporcional al capital asignado, así que subirlo no gasta más dinero: mueve el que hay hacia el final de la escalera.',
  },
} satisfies Record<string, OptionDoc>;
