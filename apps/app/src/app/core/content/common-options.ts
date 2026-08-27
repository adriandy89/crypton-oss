import type { CommonBotConfig } from '@crypton/shared';
import type { OptionDoc } from './types';

/**
 * Fichas de los parámetros que comparten las siete estrategias.
 *
 * Se resuelven como respaldo: si la guía de una estrategia no redefine el
 * campo, el panel enseña esta. La razón de que sea un respaldo y no la única
 * verdad es que varios comunes cambian de sentido según donde caen: el ejemplo
 * claro es `maxNotionalCap`, que solo lo honran tres de las siete.
 */
export const COMMON_OPTION_DOCS: Record<keyof CommonBotConfig, OptionDoc> = {
  exchangeAccountId: {
    what: 'La cuenta de exchange con la que va a operar este bot. Es una de las conexiones que hayas dado de alta, con su red (real o de pruebas) ya decidida.',
    affects:
      'Determina donde se colocan las órdenes, que saldo se usa y que pares están disponibles. No se puede cambiar después: un bot pertenece a la cuenta con la que nacio.',
    tip: 'Si es tu primera vez, crea la conexion en la red de pruebas y arranca el bot en modo simulación.',
  },
  symbol: {
    what: 'El par que va a operar, por ejemplo BTC/USDC. Solo salen los que ese exchange tiene activos.',
    affects:
      'Fija el tamaño mínimo de orden, el salto mínimo de precio (el tick) y el apalancamiento máximo. Un par barato con tick grueso deja menos sitio para poner niveles juntos.',
    tip: 'No se puede cambiar después. Para operar otro par, crea otro bot.',
  },
  direction: {
    what: 'Hacia donde apuesta el bot. En largo gana si el precio sube; en corto, si baja.',
    affects:
      'Invierte todo: en largo el bot compra abajo y vende arriba, y en corto vende arriba y recompra abajo. También invierte donde queda tu precio de liquidación.',
    tip: 'No se puede cambiar después. Cambiar de dirección es, literalmente, otro bot.',
  },
  leverage: {
    what: 'Cuántas veces multiplica el exchange el margen que le das. Con 5x, 100 USDC de margen mueven 500 USDC de posición.',
    affects:
      'Multiplica por igual la ganancia y la pérdida, y acerca el precio de liquidación. A 2x necesitas una caída cercana al 50 % para liquidarte; a 10x, cercana al 10 %.',
    tip: 'Empieza en 1x o 2x. Por encima de 10x la app te avisa, y el límite real lo pone el par: 20x en Lighter, hasta 50x en Aster.',
  },
  marginMode: {
    what: 'Aislado reserva el margen solo para esta posición. Cruzado deja que use todo el saldo libre de la cuenta.',
    affects:
      'En aislado, lo máximo que puedes perder en este bot es el margen que le asignaste, y la liquidación llega antes. En cruzado la liquidación está más lejos, pero una posición perdedora puede arrastrar el saldo del resto de bots de esa cuenta.',
    tip: 'Aislado si quieres que el peor caso de un bot no toque a los demas. No se puede cambiar después.',
  },
  positionMode: {
    what: 'Cómo cuenta el exchange una venta cuando ya tienes un largo abierto. En unidireccional la resta del largo; en cobertura abre un corto en paralelo.',
    affects:
      'En cobertura el bot puede acabar pagando margen por dos posiciones opuestas a la vez, en vez de cerrar una con otra.',
    tip: 'Deja Automático salvo que sepas exactamente por que quieres cobertura. No se puede cambiar después.',
  },
  totalInvestment: {
    what: 'El margen que este bot tiene permitido usar. No sale de tu cuenta ni se transfiere a ningun sitio: es el techo que el bot se autoimpone al repartir sus órdenes.',
    affects:
      'De aquí sale el tamaño de cada orden. Con apalancamiento, la posición que llega a mover es este importe multiplicado por el apalancamiento.',
    tip: 'El mínimo es 10 USDC, pero el mínimo útil es más alto: cada orden suelta tiene que superar el mínimo del par, que también ronda los 10 USDC.',
  },
  maxNotionalCap: {
    what: 'Tope duro del valor de la posición. El motor no coloca nada que lo supere, pase lo que pase con el resto de ajustes.',
    affects:
      'Es la red que sobrevive a un error de calculo en cualquier otro parámetro. Alcanzado el tope, el bot deja de abrir y solo mantiene las salidas.',
    tip: 'Ponlo por debajo de capital por apalancamiento si quieres un freno de verdad; por encima de esa cifra no llega a actuar nunca.',
  },
  stopLossPct: {
    what: 'Pérdida máxima tolerada sobre el precio medio de entrada. Al tocarla, el bot cierra la posición.',
    affects:
      'El motor coloca una orden de disparo nativa en el propio exchange, así que se ejecuta aunque la plataforma se caiga. La dirección sale del signo de la posición real, no de la que declaraste.',
    tip: 'Sin stop, la única salida por abajo es la liquidación. Déjalo vacio solo si el tope de exposición ya te protege.',
  },
  maxDailyLossPct: {
    what: 'Pérdida acumulada en un día a partir de la cual el bot se detiene.',
    affects:
      'No cierra la posición: deja de abrir nuevas y para. Es el freno para un día malo, no para una operación mala.',
    tip: 'Útil sobre todo en las estrategias que promedian a la baja, donde un mal día encadena varias entradas.',
  },
  cooldownMinutes: {
    what: 'Espera entre el final de un ciclo y el comienzo del siguiente.',
    affects:
      'Con 0, el bot vuelve a abrir en cuanto cierra. Subiéndolo evitas que reentre en medio del mismo movimiento que acaba de cerrarle el ciclo.',
    tip: 'Unos pocos minutos bastan para no reentrar en el mismo impulso.',
  },
  sizingMode: {
    what: 'En qué unidad tecleas los tamaños: valor nocional en USDC, o cantidad de la moneda.',
    affects:
      'En nocional escribes 50 USDC y el bot calcula la cantidad al precio de cada momento. En cantidad escribes 0,001 BTC y el valor en USDC varía con el precio.',
    tip: 'Nocional es lo más fácil de razonar: es directamente el dinero en juego.',
  },
  limitAction: {
    what: 'Qué hace el bot cuando la posición toca su tope de exposición.',
    affects:
      'Pausar entradas lo deja quieto esperando a que la posición baje. Cerrar todo la liquida a mercado en ese momento. Apagar la cierra y además detiene el bot.',
    tip: 'Pausar entradas es lo prudente: cerrar a mercado en el peor momento realiza la pérdida entera.',
  },
  liquidationAction: {
    what: 'Qué hace el bot cuando el precio se acerca a tu precio de liquidación.',
    affects:
      'Solo avisar manda una notificación y no toca nada. Pausar detiene el bot dejando la posición abierta. Cerrar todo la cierra a mercado antes de que lo haga el exchange.',
    tip: 'Una liquidación del exchange se lleva el margen entero. Cerrar antes duele, pero duele menos.',
  },
  priceFloor: {
    what: 'Suelo de precio. Por debajo de el, el bot deja de abrir posición nueva; las salidas siguen vivas.',
    affects:
      'Corta la sangria cuando el precio se va por debajo de donde tu tesis tenía sentido, sin cerrar lo que ya tienes.',
    tip: 'Déjalo vacio si ya usas rango o stop loss: dos frenos para lo mismo se estorban.',
  },
  priceCeiling: {
    what: 'Techo de precio. Por encima de el, el bot deja de abrir posición nueva; las salidas siguen vivas.',
    affects: 'El espejo del suelo, útil sobre todo en bots cortos y en cotizaciones a dos lados.',
    tip: 'Déjalo vacio si ya usas rango o stop loss.',
  },
};
