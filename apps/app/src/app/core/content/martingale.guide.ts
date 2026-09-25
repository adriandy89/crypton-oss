import type { MartingaleConfig } from '@crypton/strategy-core';
import { LADDER_OPTION_DOCS } from './ladder-options';
import type { StrategyGuide } from './types';

export const MARTINGALE_GUIDE: StrategyGuide<MartingaleConfig> = {
  headline:
    'Una entrada inicial y varias órdenes de seguridad por debajo, cada una más lejos y más grande. Baja tu precio medio deprisa para cerrar el ciclo con un rebote pequeño.',
  risk: 'ALTO',
  bestFor:
    'Caídas que rebotan. La escalera convierte una bajada en una posición con precio medio bajo, y basta un repunte corto para cerrar el ciclo entero en beneficio.',
  howItWorks: [
    'Con la posición en cero, el bot abre la entrada base: a mercado por defecto, o limitada si prefieres esperar precio.',
    'Debajo cuelga las órdenes de seguridad. La primera va a la separación inicial que hayas puesto, y cada siguiente se aleja más que la anterior según la escala de distancia.',
    'Cada seguridad también es más grande que la anterior, según la escala de volumen. El capital se reparte proporcionalmente entre todos los escalones, así que el capital asignado es un techo real.',
    'Cada seguridad que se ejecuta baja tu precio medio, y el bot recoloca la orden de cierre más abajo, sobre la media nueva.',
    'Cuando el precio recupera el objetivo sobre esa media, se cierra toda la posición de golpe y el ciclo termina. El objetivo y el stop van en % de tu margen: a 2x, un 2,4 % del margen es un 1,2 % del precio.',
    'En corto es el espejo: la entrada vende, las seguridades van por encima y el cierre queda por debajo de la media.',
  ],
  goodWhen: [
    'El par corrige y rebota con regularidad, y las caídas que ves rara vez pasan de lo que cubre tu escalera.',
    'Tienes claro cual es el peor caso y estas dispuesto a asumirlo: la app te lo enseña entero antes de crear el bot.',
    'Quieres cerrar ciclos con movimientos pequeños a favor, sin esperar a recuperar el precio de la primera entrada.',
  ],
  badWhen: [
    'El par cae y no vuelve. Es el escenario que arruina esta estrategia: cada escalón te deja más dinero dentro de una posición que sigue bajando.',
    'Usas apalancamiento alto. La escalera y el apalancamiento tiran en la misma dirección, y la liquidación llega antes de que se ejecuten los últimos escalones.',
    'No has mirado hasta donde cubre la escalera. Si el precio la agota, el bot deja de promediar y solo queda esperar o asumir la pérdida.',
  ],
  examples: [
    {
      title: 'Escalera equilibrada en ETH',
      venue: 'Lighter',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Capital', value: '400 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Órdenes de seguridad', value: '6' },
        { label: 'Separación inicial', value: '3 %' },
        { label: 'Escala de distancia', value: '1,3' },
        { label: 'Escala de volumen', value: '1,6' },
        { label: 'Take profit', value: '2,4 % del margen' },
      ],
      outcome:
        'Los escalones caen en 2.428, 2.330, 2.203, 2.038, 1.824 y 1.545: la escalera cubre un 38 % de caída. Con todos llenos la media queda en 1.807 y, con un mantenimiento del 2,5 %, la liquidación exacta en 927, un 63 % por debajo del precio de hoy: cabe entera con holgura, porque la media baja con cada escalón. La entrada base mueve unos 19 USDC de posición (9 de margen) y el último escalón unos 312 (156 de margen): el peor caso son 800 USDC de posición con los 400 de capital comprometidos. Si ETH cae a 1.900 y rebota un 1,2 % sobre la media —el 2,4 % del margen a 2x—, el ciclo cierra completo.',
    },
    {
      title: 'BTC conservador, escalera corta',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Capital', value: '900 USDC' },
        { label: 'Apalancamiento', value: '3x' },
        { label: 'Órdenes de seguridad', value: '6' },
        { label: 'Separación inicial', value: '2 %' },
        { label: 'Escala de distancia', value: '1,25' },
        { label: 'Escala de volumen', value: '1,4' },
        { label: 'Take profit', value: '3 % del margen' },
        { label: 'Tope de exposición', value: '2.400 USDC' },
      ],
      outcome:
        'Escalones en 77.332, 75.359, 72.893, 69.811, 65.958 y 61.141: cubre un 22,5 %. La escalera entera sumaría 2.697 USDC de posición, así que el tope de 2.400 deja fuera el último escalón: es un segundo techo deliberado, y la Revisión enseña la escalera cortada ahí. Con la base y las cinco seguridades que caben, la liquidación exacta a 3x queda un 39 % por debajo del precio de hoy, con margen de sobra. La escala de volumen baja, 1,4, hace que el último escalón no sea desproporcionado frente al primero: se promedia más despacio a cambio de un peor caso más plano. El take profit del 3 % del margen es un 1 % del precio sobre la media.',
    },
    {
      title: 'DOGE agresivo, escalera profunda',
      venue: 'Aster',
      pair: 'DOGE/USDT',
      price: '0,09209 USDT',
      setup: [
        { label: 'Capital', value: '300 USDT' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Órdenes de seguridad', value: '5' },
        { label: 'Separación inicial', value: '5 %' },
        { label: 'Escala de distancia', value: '1,3' },
        { label: 'Escala de volumen', value: '1,5' },
        { label: 'Take profit', value: '6 % del margen' },
      ],
      outcome:
        'Escalones en 0,08748, 0,08149, 0,07371, 0,06360 y 0,05045: la escalera cubre un 45 % de caída. Con todos llenos la media baja a 0,06268 y la liquidación exacta a 2x queda en 0,03166, un 66 % por debajo del precio de hoy: la escalera cabe entera. La entrada base mueve unos 29 USDT de posición (14 de margen) y el último escalón unos 219 (110 de margen): más de un tercio del capital vive en ese único nivel. El take profit del 6 % del margen es un 3 % del precio sobre la media.',
    },
  ],
  options: {
    trailingTakeProfit: {
      what: 'Convierte el take profit en un objetivo que sigue al precio. Al llegar al porcentaje que pediste, el bot no cierra: empieza a seguir al mejor precio y solo cierra cuando retrocede lo que digas.',
      affects:
        'Apagado, sales exactamente en tu objetivo. Encendido, un movimiento que siga a favor te deja dentro y cobras más — pero cobras siempre un poco menos que el mejor precio, porque el retroceso es el peaje. A 2x, con un objetivo del 30 % del margen (un 15 % del precio) y un retroceso del 1 %, lo mínimo que cobras es un 13,85 % del precio: un 27,7 % del margen.',
      tip: 'No es una mejora gratis: en marcos cortos baja la tasa de acierto, porque el retroceso normal de una cripto lo dispara antes de tiempo. Mientras no llegues al objetivo, la única protección es tu stop loss — que sigue intacto.',
    },
    trailingCallbackPct: {
      what: 'Cuánto tiene que retroceder el precio desde el mejor punto —el máximo en largo, el mínimo en corto— para que el bot cierre, en % del precio.',
      affects:
        'Es todo el compromiso de esta estrategia: pequeño te saca pronto y asegura casi todo el máximo; grande aguanta las sacudidas y te deja correr la tendencia, a cambio de devolver más cuando por fin gire.',
      tip: 'Míralo contra lo que respira tu par. Por debajo del 0,5 % en algo que se mueve un 1-3 % al día, sales en el primer respiro.',
    },
    trailingRepriceBps: {
      what: 'Cuánto tiene que avanzar el disparador para que el bot lo mueva de verdad en el exchange. 20 bps son un 0,2 %.',
      affects:
        'Bajarlo hace que el seguimiento sea más fino y gaste más peticiones; subirlo lo hace más perezoso y puede dejar el disparador algo por detrás del máximo.',
      tip: 'Déjalo como está salvo en Lighter, donde el cupo son 60 peticiones por minuto de toda tu IP y cada recolocación gasta dos.',
    },
    ...LADDER_OPTION_DOCS,
    takeProfitPct: {
      what: 'Beneficio sobre tu margen al que se cierra la posición entera y termina el ciclo, medido desde el precio medio, como el TP por ROI de un exchange: a 2x, un 2 % del margen es un 1 % del precio.',
      affects:
        'Se recalcula cada vez que una seguridad se ejecuta, porque el precio medio ha cambiado. Objetivos pequeños cierran ciclos a menudo; objetivos grandes dejan la posición abierta más tiempo y expuesta al siguiente movimiento en contra.',
      tip: 'Las comisiones se pagan sobre el precio: un objetivo que en precio quede por debajo del 0,3 % puede cerrar el ciclo en pérdida. A 5x, eso es un 1,5 % del margen; la app avisa.',
    },
    tpMode: {
      what: 'Cómo se cierra el ciclo al alcanzar el objetivo: con una orden limitada que espera colocada, o a mercado.',
      affects:
        'Limitada cobra comisión de maker y es más barata, pero si el precio la roza y se va, el ciclo sigue abierto. A mercado es una orden condicional: espera al objetivo y, al tocarlo, cruza el libro; cierra seguro, pero paga taker y algo de deslizamiento.',
      tip: 'Limitada en pares líquidos; a mercado si prefieres garantizar el cierre aunque cueste algo más.',
    },
    maxNotionalCap: {
      what: 'Tope duro del valor de la posición. En esta estrategia el motor SI lo consulta: corta la escalera en el escalón en que se alcanza.',
      affects:
        'Es el freno independiente de todo lo demas. Si lo pones por debajo de lo que suma la escalera completa, los últimos escalones no llegan a colocarse nunca.',
      tip: 'Útil como segundo techo por si te equivocas con la escala de volumen. Mira el peor caso del preview para elegir la cifra.',
    },
    leverage: {
      what: 'Cuántas veces multiplica el exchange el margen que le das.',
      affects:
        'Aquí pesa el doble que en otras estrategias: además de multiplicar pérdidas, acerca la liquidación y por tanto acorta cuánta escalera cabe. La app recorre la escalera nivel a nivel con la media de lo ya comprado y, si la liquidación llega antes que una seguridad, RECHAZA la configuración en margen aislado (en cruzado, avisa): esa seguridad no se ejecutaría jamás. El take profit y el stop van en % de tu margen, así que con más apalancamiento quedan más cerca en precio.',
      tip: 'Lo que cabe depende también de la escala de volumen, porque la media baja con cada escalón: la app te dice qué seguridad no llegaría. Baja el apalancamiento antes que acortar la escalera.',
    },
    cooldownMinutes: {
      what: 'Espera entre el cierre de un ciclo y la apertura del siguiente.',
      affects:
        'Sin espera, el bot vuelve a abrir la entrada base inmediatamente después de cerrar, a veces en mitad del mismo impulso que acaba de darle el beneficio.',
      tip: 'Viene con 1 minuto por defecto. Subirlo evita encadenar ciclos dentro de la misma vela.',
    },
    stopLossPct: {
      what: 'Pérdida máxima sobre tu margen, medida desde el precio medio, antes de cerrar la posición: a 2x, un 20 % del margen es un 10 % del precio.',
      affects:
        'Es la única salida ordenada cuando la escalera se agota y el precio sigue en contra. Sin él, el bot se queda con la posición completa esperando un rebote que puede no llegar.',
      tip: 'Que su precio quede más allá del último escalón: si salta antes, cierra el ciclo sin haber terminado de promediar, y la app te avisa de qué seguridad no llegaría.',
    },
  },
};
