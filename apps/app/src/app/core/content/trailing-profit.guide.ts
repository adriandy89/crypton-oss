import type { TrailingProfitConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const TRAILING_PROFIT_GUIDE: StrategyGuide<TrailingProfitConfig> = {
  headline:
    'Abre una operación, la deja correr y cierra cuando el precio retrocede lo que le digas desde el máximo. Tú pones dos números: a partir de qué beneficio empieza a seguir, y cuánto retroceso aguanta.',
  risk: 'ALTO',
  bestFor:
    'Cuando tienes una tesis direccional y no quieres estar mirando la pantalla para decidir cuándo recoger. Es la única que no intenta adivinar el techo: deja que lo marque el mercado.',
  howItWorks: [
    'Abre la posición: a mercado en la primera revisión, o esperando a que el precio cruce un nivel que tú pongas.',
    'El tamaño es todo el capital que le asignes por el apalancamiento, recortado por lo que el margen aguante y por el tope de exposición si lo pusiste. No hay un campo aparte para el tamaño.',
    'Mientras no llegue a tu objetivo NO hay orden de beneficio en el libro. La única protección de esa fase es el stop loss, que por eso viene puesto de fábrica.',
    'Al llegar al objetivo coloca un disparador un retroceso por debajo del máximo, como orden condicional NATIVA del exchange: se dispara aunque la plataforma se caiga.',
    'A partir de ahí el disparador sube con el máximo y NUNCA baja. El máximo se mide del precio de marca, y cuenta también lo que pasa entre dos revisiones.',
    'Cuando el precio retrocede hasta el disparador, cierra a mercado. Se cierra el ciclo, y pasada la espera el bot abre otra operación: es un bot, no una operación suelta.',
  ],
  goodWhen: [
    'Esperas un movimiento grande y no sabes hasta dónde llega. Es justo el caso en el que un objetivo fijo te deja fuera a mitad de camino.',
    'Quieres una sola posición clara, sin escalera de compras ni promediar a la baja.',
    'Te vale con decidir dos cosas —cuándo empieza a proteger y cuánto retroceso aguantas— y olvidarte.',
  ],
  badWhen: [
    'El par va y viene sin ir a ningún sitio. Ahí el retroceso te saca en cada respiro y pagas la comisión cada vez; una rejilla o un market maker son lo correcto.',
    'No piensas poner stop loss. Hasta que llega al objetivo, el seguimiento no protege absolutamente nada.',
    'Quieres una única operación y nada más. Este bot vuelve a entrar al cerrar; si no lo quieres, párralo tú.',
    'Te molesta cobrar menos que el máximo. Por definición devuelves el retroceso: ese es el precio de no tener que adivinar el techo.',
  ],
  examples: [
    {
      title: 'El caso de manual: 15 % y 1 %',
      venue: 'Hyperliquid',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Capital', value: '1.000 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Entrada', value: 'A mercado' },
        { label: 'Empieza a seguir en', value: '15 %' },
        { label: 'Retroceso para salir', value: '1 %' },
        { label: 'Stop loss', value: '5 %' },
      ],
      outcome:
        'Entra con 2.000 USDC de posición. Hasta +15 % no hay más que el stop. En +15 % coloca el disparador en +13,85 %: es el suelo de lo que puedes cobrar. Si el precio sigue hasta +40 %, el disparador va detrás y cierra en +38,6 %. Si en vez de eso gira justo al tocar el objetivo, cobras el 13,85 % — menos que un objetivo fijo del 15 %, y eso no es un fallo: es el peaje.',
    },
    {
      title: 'Entrar solo si el precio cae primero',
      venue: 'Aster',
      pair: 'ETH/USDT',
      price: '3.000 USDT',
      setup: [
        { label: 'Capital', value: '500 USDT' },
        { label: 'Entrada', value: 'Cuando baje a' },
        { label: 'Precio de entrada', value: '2.800 USDT' },
        { label: 'Empieza a seguir en', value: '8 %' },
        { label: 'Retroceso para salir', value: '2 %' },
      ],
      outcome:
        'El bot no hace nada hasta que la marca toca 2.800. Entonces abre largo y empieza a vigilar: a 3.024 (+8 %) arma el seguimiento y el disparador nace en 2.963. Si el rebote llega a 3.300, cierra en 3.234. Si ETH nunca baja a 2.800, el bot no abre ninguna operación y no cuesta nada.',
    },
    {
      title: 'Un retroceso demasiado fino',
      venue: 'Hyperliquid',
      pair: 'SOL/USDC',
      price: '150 USDC',
      setup: [
        { label: 'Empieza a seguir en', value: '3 %' },
        { label: 'Retroceso para salir', value: '0,3 %' },
      ],
      outcome:
        'SOL respira un 2-3 % al día sin cambiar de tendencia, así que un retroceso del 0,3 % salta con el primer movimiento normal después de activarse. El bot cierra en +2,7 %, vuelve a entrar pasada la espera y repite: muchas operaciones pequeñas pagando comisión, que es exactamente lo contrario de lo que esta estrategia debería hacer. El formulario te avisa por debajo del 0,5 %.',
    },
  ],
  options: {
    trailingTakeProfit: {
      what: 'En esta estrategia el seguimiento está siempre encendido: es lo único que hace.',
      affects:
        'No sale en el formulario. La casilla existe en el DCA temporizado y en Martingala, donde el seguimiento es una opción sobre una escalera de compras.',
      tip: 'Si lo que quieres es salir en un precio fijo, cualquiera de las otras estrategias lo hace.',
    },
    activationMode: {
      what: 'Cuándo abre la operación: a mercado en la primera revisión, o esperando a que el precio suba o baje hasta un nivel.',
      affects:
        '«A mercado» entra ya, al precio que haya. Las otras dos dejan al bot esperando sin coste hasta que la marca cruce tu precio. Al cerrarse una operación la condición vuelve a evaluarse desde cero para la siguiente.',
      tip: 'Si lo que quieres es comprar una caída concreta, «Cuando baje a» hace eso sin dejar una orden colgada en el libro.',
    },
    activationPrice: {
      what: 'El precio que tiene que cruzar la marca para que el bot abra.',
      affects: 'Solo se usa si la entrada no es «A mercado». Sin él, el bot no abriría nunca.',
      tip: 'Es un disparador, no una orden límite: cuando se cruza, el bot entra a mercado al precio que haya en ese momento.',
    },
    takeProfitPct: {
      what: 'Beneficio, sobre tu precio de entrada, a partir del cual el bot empieza a seguir al máximo.',
      affects:
        'NO es el precio al que sale. Por debajo de este número no hay ninguna orden de beneficio; por encima, la salida es un disparador que persigue al máximo. Subirlo hace que la operación aguante más antes de empezar a protegerse.',
      tip: 'Ponlo por encima de lo que el par se mueve en un día normal, o se activará con el ruido. Lo mínimo que cobrarás es este número menos el retroceso.',
    },
    trailingCallbackPct: {
      what: 'Cuánto tiene que caer el precio desde el máximo (o subir desde el mínimo, en corto) para que cierre.',
      affects:
        'Pequeño asegura casi todo el máximo pero te saca en la primera sacudida; grande aguanta el ruido y te deja correr la tendencia, a cambio de devolver más cuando gire.',
      tip: 'Mídelo contra lo que respira tu par, no en abstracto. Por debajo del 0,5 % en algo que se mueve un 1-3 % al día, sales en el primer respiro.',
    },
    trailingRepriceBps: {
      what: 'Cuánto tiene que avanzar el disparador para que el bot lo mueva de verdad en el exchange. 20 bps son un 0,2 %.',
      affects:
        'Bajarlo hace el seguimiento más fino y gasta más peticiones; subirlo lo hace más perezoso y puede dejar el disparador algo por detrás del máximo.',
      tip: 'Déjalo como está salvo en Lighter, donde el cupo son 60 peticiones por minuto de toda tu IP y cada recolocación gasta dos.',
    },
    stopLossPct: {
      what: 'La única protección que tiene la operación hasta que llega al objetivo.',
      affects:
        'Es la red de la primera fase, que puede durar días. Al llegar al objetivo el seguimiento toma el relevo, pero el stop sigue puesto por debajo.',
      tip: 'Esta es la única estrategia que nace con stop puesto (5 %), y es a propósito. Quitarlo deja la operación entera a la intemperie.',
    },
    cooldownMinutes: {
      what: 'Cuánto espera el bot desde que cierra una operación hasta que abre la siguiente.',
      affects:
        'Con 0 volvería a entrar en el mismo minuto, al precio que acaba de dejar. Subirlo espacia las operaciones y deja que el mercado se asiente.',
      tip: 'Nace en 60 minutos. Si lo que querías era una sola operación, para el bot cuando se cierre.',
    },
    maxNotionalCap: {
      what: 'Tope del valor de la posición. Aquí es el mando con el que se opera con menos de todo el capital.',
      affects:
        'El tamaño es capital × apalancamiento, recortado por este tope y por el margen disponible. Es el menor de los tres el que manda.',
      tip: 'Si quieres arriesgar la mitad de lo asignado, este es el sitio.',
    },
  },
};
