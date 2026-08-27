import type { OptionDoc } from './types';

/**
 * Fichas de la escalera de seguridad: los siete parámetros de `MARTINGALE_FIELDS`.
 *
 * Viven aparte porque GridMart REUSA el mismo bloque de campos que Martingala
 * (`gridmart.ts` importa `MARTINGALE_FIELDS`), y escribir dos veces la
 * explicación de `volumeScale` es como acaban diciendo cosas distintas del mismo
 * número. GridMart parte de aquí y reescribe solo las que cambian de sentido
 * dentro de su ciclo.
 */
export const LADDER_OPTION_DOCS = {
  baseOrderType: {
    what: 'Cómo entra la primera orden del ciclo: a mercado, que se ejecuta al instante al precio que haya, o limitada, que espera a que el precio venga a buscarla.',
    affects:
      'A mercado el bot arranca siempre, pero pagas comisión de taker y entras al precio del momento. Limitada ahorra comisión y entra mejor, pero el ciclo puede no empezar nunca si el precio se va.',
    tip: 'A mercado si quieres que el bot opere si o si; limitada si te importa más el precio de entrada que la puntualidad.',
  },
  numLimitBuys: {
    what: 'Cuántas órdenes de seguridad se cuelgan por debajo de la entrada base, esperando a que el precio caiga.',
    affects:
      'Cada una que se ejecuta baja tu precio medio y AUMENTA la posición. Más seguridades aguantan una caída más profunda, pero también es más dinero comprometido si la caída no rebota.',
    tip: 'El número solo no dice nada: lo que decide hasta dónde aguantas es este número junto a la separación y la escala de distancia.',
  },
  initialSeparationPct: {
    what: 'A qué distancia de la entrada base se cuelga la PRIMERA seguridad, en porcentaje.',
    affects:
      'Separaciones cortas hacen que las seguridades se ejecuten pronto y gastes munición en un ruido de mercado. Separaciones largas guardan la munición para una caída de verdad, pero tardan más en bajarte la media.',
    tip: 'En un par volátil como DOGE, un 1 % se toca varias veces al día; en BTC es una caída seria.',
  },
  stepScale: {
    what: 'Cuánto se aleja cada seguridad respecto de la anterior. Con 1 todas van a la misma distancia; con 1,5 cada hueco es un 50 % más ancho que el de antes.',
    affects:
      'Es lo que decide la PROFUNDIDAD total que cubre la escalera. Subirlo estira la cobertura sin añadir órdenes, a cambio de que tu media baje más despacio al principio.',
    tip: 'La app rechaza la configuración si la escalera entera no cubre al menos lo que te separa de la liquidación: con apalancamiento 5x eso es un 20 %.',
  },
  volumeScale: {
    what: 'Cuánto crece cada seguridad respecto de la anterior. Con 2, cada una compra el doble que la de antes.',
    affects:
      'Es el parámetro que hace de esto una martingala. Subirlo baja tu precio medio mucho más rápido, pero concentra casi todo el capital en los últimos escalones, que son los que se ejecutan cuando la caída ya es grave.',
    tip: 'Por encima de 2,5 la app avisa. El reparto es proporcional al capital asignado, así que subirlo no gasta más dinero: mueve el que hay hacia el final de la escalera.',
  },
  takeProfitPct: {
    what: 'Beneficio sobre el precio medio al que se cierra la posición entera y termina el ciclo.',
    affects:
      'Se recalcula cada vez que una seguridad se ejecuta, porque el precio medio ha cambiado. Objetivos pequeños cierran ciclos a menudo; objetivos grandes dejan la posición abierta más tiempo y expuesta a la siguiente caída.',
    tip: 'Con comisiones de ida y vuelta, por debajo del 0,3 % un ciclo cerrado puede acabar en pérdida.',
  },
  tpMode: {
    what: 'Cómo se cierra el ciclo al alcanzar el objetivo: con una orden limitada que espera colocada, o a mercado en cuanto se toca el precio.',
    affects:
      'Limitada cobra comisión de maker y es más barata, pero si el precio la roza y se va, el ciclo sigue abierto. A mercado garantiza el cierre y paga comisión de taker.',
    tip: 'Limitada por defecto. A mercado solo si te ha pasado ver el objetivo tocado y el ciclo sin cerrar.',
  },
} satisfies Record<string, OptionDoc>;
