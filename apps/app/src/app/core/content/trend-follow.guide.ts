import type { TrendFollowConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const TREND_FOLLOW_GUIDE: StrategyGuide<TrendFollowConfig> = {
  headline:
    'Entra cuando el precio rompe el rango en el que llevaba semanas y sale con un stop que le va siguiendo. No busca acertar el suelo ni el techo: busca estar dentro mientras dure el movimiento.',
  risk: 'ALTO',
  bestFor:
    'El único régimen en el que pierden las otras siete: cuando el precio no va y viene, sino que se va en línea recta. Es la estrategia que compensa a una rejilla o a un market maker, no la que los sustituye.',
  howItWorks: [
    'El bot mira velas cerradas del tamaño que le digas (4 h por defecto) y calcula el máximo y el mínimo de las últimas N, sin contar la que está mirando.',
    'Si el cierre supera ese máximo, abre largo. Si pierde el mínimo, abre corto. Nada más: no hay indicador oculto.',
    'Antes de entrar comprueba que el mercado va a algún sitio. Si el precio ha recorrido mucho y ha avanzado poco, la ruptura casi seguro es falsa y no entra.',
    'El tamaño NO sale de tu capital, sale de tu riesgo: arriesga el porcentaje que le digas dividido por la distancia al stop. Con el mercado nervioso la posición es pequeña, con el mercado quieto es grande, y en las dos arriesgas lo mismo.',
    'Nada más entrar coloca un stop a N veces el ATR, como orden condicional NATIVA del exchange: sigue ahí aunque la plataforma se caiga.',
    'A partir de ahí, el stop sube con el precio (o baja, si estás corto) y NUNCA se mueve en contra. Es la única salida: no hay objetivo de beneficio.',
  ],
  goodWhen: [
    'Ya tienes una rejilla o un market maker funcionando y quieres algo que gane justo cuando ellos sufren.',
    'Te da igual estar semanas sin operar. Una ruptura buena aparece pocas veces al año en un par concreto.',
    'Entiendes que va a fallar más veces de las que acierta y aun así puede ganar dinero.',
  ],
  badWhen: [
    'Necesitas ver operaciones a menudo para estar tranquilo. Aquí la mayoría de los días no pasa nada.',
    'Te cuesta aguantar rachas de pérdidas. Acierta en torno a cuatro de cada diez veces: seis de cada diez operaciones se cierran en el stop, con pérdida, y eso es el funcionamiento normal, no una avería.',
    'El par lleva meses de lado. Es justo el terreno donde la ruptura es falsa una y otra vez, y el filtro de eficiencia está para no operar ahí.',
    'Quieres apalancamiento alto. El stop es amplio a propósito, así que el apalancamiento acerca la liquidación por encima del stop y te saca el exchange antes que tu propia estrategia.',
  ],
  examples: [
    {
      title: 'BTC en 4 h, riesgo del 1 %',
      venue: 'Hyperliquid',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Capital', value: '1.000 USDC' },
        { label: 'Resolución', value: '4 h' },
        { label: 'Canal de ruptura', value: '20 velas (unos 3 días)' },
        { label: 'ATR', value: '14 velas' },
        { label: 'Stop', value: '2,5 ATR' },
        { label: 'Riesgo por operación', value: '1 %' },
        { label: 'Eficiencia mínima', value: '0,35' },
        { label: 'Apalancamiento', value: '2x' },
      ],
      outcome:
        'Con un ATR de 1.200 USDC, el stop queda a 3.000 del precio y la posición sale de 1.000 × 1 % / 3.000 = 0,0033 BTC (unos 263 USDC). Si el stop salta, pierdes 10 USDC: el 1 % que dijiste. Si el precio se va un 20 %, el stop lo sigue a 3.000 de distancia y te deja dentro todo el camino.',
    },
    {
      title: 'Lo que pasa en un mercado lateral',
      venue: 'Aster',
      pair: 'ETH/USDT',
      price: '3.000 USDT',
      setup: [
        { label: 'Capital', value: '1.000 USDT' },
        { label: 'Resolución', value: '4 h' },
        { label: 'Eficiencia mínima', value: '0,35' },
      ],
      outcome:
        'El precio rompe el canal tres veces en dos semanas y las tres vuelve dentro. El bot no entra en ninguna: la eficiencia del mercado está en 0,12, muy por debajo de 0,35. Esas tres operaciones que no hizo son tres stops que no pagó.',
    },
  ],
  options: {
    candleInterval: {
      what: 'El tamaño de las velas con las que decide.',
      affects:
        'Velas más cortas: más rupturas, más operaciones y más falsas. Velas más largas: menos operaciones y señales más fiables, pero se entra más tarde en cada movimiento.',
      tip: '4 h es el punto de equilibrio. 15 min convierte esto en otra estrategia: opera mucho y acierta poco.',
    },
    breakoutPeriod: {
      what: 'Cuántas velas anteriores forman el rango que hay que romper.',
      affects:
        'Con 20 velas de 4 h, el canal cubre unos tres días. Más velas es un techo más alto y por tanto una ruptura más rara y más significativa.',
      tip: 'La vela que rompe NO cuenta en su propio rango. Si contara, su máximo sería el máximo y no lo superaría nunca.',
    },
    atrPeriod: {
      what: 'Cuántas velas entran en el cálculo del ATR, que es la medida de cuánto se mueve este par.',
      affects:
        'De este número salen dos cosas a la vez: dónde va el stop y qué tamaño tiene la posición.',
      tip: '14 es el valor clásico y no hay motivo para tocarlo hasta haber operado un tiempo.',
    },
    atrStopMultiplier: {
      what: 'A cuántos ATR de distancia se pone el stop.',
      affects:
        'Más ATR es más espacio para respirar y menos operaciones cortadas por ruido, pero cada pérdida es mayor... salvo que no: el tamaño se ajusta para que el riesgo en dinero sea el mismo. Lo que cambia de verdad es cuántas veces te sacan.',
      tip: 'Nunca por debajo de 1,5. Un stop más pegado no es prudencia: es salirse en el primer respiro del mercado una y otra vez, pagando comisión cada vez.',
    },
    riskPerTradePct: {
      what: 'Qué porcentaje de tu capital pierdes si el stop salta.',
      affects:
        'Es el mando que de verdad decide cuánto duele una mala racha. Con cuatro aciertos de cada diez, encadenar cinco pérdidas seguidas es normal.',
      tip: '1 % es lo estándar. Con 2 %, cinco pérdidas seguidas son un 10 % del capital; con 5 %, un 25 %.',
    },
    entryEfficiency: {
      what: 'Cuánto tiene que «ir a algún sitio» el mercado para que una ruptura cuente.',
      affects:
        'Compara el recorrido neto con el recorrido total: 1 es una línea recta y 0 es ir y venir sin avanzar. Por debajo del umbral no se abre.',
      tip: '0,35 filtra la mayoría de las rupturas falsas sin dejar pasar los movimientos buenos. Con 0 está apagado y el bot entra en cada ruptura.',
    },
    maxAdverseFundingBps: {
      what: 'Funding en contra a partir del cual no se abre de ese lado.',
      affects:
        'Un funding extremo y sostenido suele significar que todo el mundo ya está de ese lado. Abrir ahí es llegar tarde y encima pagando.',
      tip: 'Con 0 no hay filtro. En Lighter no hace nada: ese venue no publica el funding.',
    },
    stopRepriceBps: {
      what: 'Cuánto tiene que moverse el stop para que el bot lo recoloque de verdad.',
      affects:
        'El stop se recalcula en cada revisión, pero cancelarlo y reponerlo cada quince segundos gasta cuota del exchange sin cambiar nada.',
      tip: '20 bps está bien. Bajarlo mucho convierte el trailing en un goteo constante de órdenes.',
    },
  },
};
