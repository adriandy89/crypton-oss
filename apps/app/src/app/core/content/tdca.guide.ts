import type { TdcaConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const TDCA_GUIDE: StrategyGuide<TdcaConfig> = {
  headline:
    'Compra un importe fijo cada cierto tiempo, pero solo si el precio mejora tu media. Cuando la posición alcanza el objetivo, la cierra entera.',
  risk: 'MEDIO',
  bestFor:
    'Construir una posición poco a poco sin tener que acertar el suelo. Es el DCA de toda la vida con una condición anadida: no compra por comprar, compra cuando la compra te sale mejor que lo que ya tienes.',
  howItWorks: [
    'Cada X minutos el bot mira si toca comprar.',
    'Compra a mercado el importe que le hayas dicho, siempre que se cumplan todas las condiciones: que quede cupo de compras, que haya pasado el intervalo, que el precio mejore tu media lo suficiente y que la posición no haya llegado a su tope.',
    'Cada compra mejora tu precio medio de entrada, porque solo compra cuando el precio está por debajo de él (por encima, en corto).',
    'Mientras haya posición, el bot mantiene viva una orden de cierre sobre el total, a la distancia de la media que da el objetivo de beneficio, que va en % de tu margen: a 1x es el mismo % del precio.',
    'Cuando esa orden se ejecuta, el ciclo termina completo y vuelve a empezar de cero.',
  ],
  goodWhen: [
    'Quieres acumular un par que crees que vale más de lo que cotiza, sin apostarlo todo a un solo precio.',
    'Prefieres una estrategia con pocos parámetros y comportamiento fácil de predecir.',
    'Te vale un ritmo lento: es la única que opera por reloj y no por movimiento de precio.',
  ],
  badWhen: [
    'Buscas operaciones rápidas. Aquí un ciclo puede durar días.',
    'El par está en caída libre: seguiras comprando más barato cada vez, pero la posición crece y el objetivo se aleja.',
    'Piensas usar apalancamiento alto. Promediar a la baja y apalancarse es la combinación que más cerca deja la liquidación; la app avisa por encima de 3x.',
  ],
  examples: [
    {
      title: 'Acumular BTC con paciencia',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Capital', value: '500 USDC' },
        { label: 'Importe por compra', value: '25 USDC' },
        { label: 'Intervalo', value: '240 min (4 h)' },
        { label: 'Compras máximas', value: '20' },
        { label: 'Mejora mínima sobre la media', value: '0,5 %' },
        { label: 'Take profit', value: '1,5 % del margen' },
        { label: 'Apalancamiento', value: '1x' },
      ],
      outcome:
        'Como máximo compromete 25 x 20 = 500 USDC, justo el capital asignado. La primera compra entra al precio que haya; a partir de ahí solo compra si BTC está al menos un 0,5 % por debajo de tu media y han pasado 4 horas desde la anterior. Lo que limita las compras es el reloj, no la profundidad: la media sigue al precio hacia abajo, así que en una caída que dure algo más de tres días puede gastar las veinte: la primera entra ya y las otras diecinueve, una cada cuatro horas, en 76 horas. El bot cierra entero en cuanto BTC recupere un 1,5 % sobre la media resultante: a 1x, el 1,5 % del margen es un 1,5 % del precio.',
    },
    {
      title: 'Cazar caídas rápidas en ETH',
      venue: 'Hyperliquid',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Capital', value: '600 USDC' },
        { label: 'Importe por compra', value: '40 USDC' },
        { label: 'Intervalo', value: '30 min' },
        { label: 'Compras máximas', value: '15' },
        { label: 'Mejora mínima sobre la media', value: '1,2 %' },
        { label: 'Take profit', value: '2 % del margen' },
        { label: 'Notional máximo', value: '650 USDC' },
      ],
      outcome:
        'El intervalo corto deja al bot reaccionar a un tramo de caída en el mismo día, y la mejora mínima del 1,2 % impide que gaste el cupo en ruido. 40 x 15 = 600 USDC, que cabe en el capital. El tope de 650 USDC de notional es el freno duro por si el apalancamiento hiciera crecer la posición más de lo previsto.',
    },
    {
      title: 'Comprar sin condiciones, a intervalo fijo',
      venue: 'Aster',
      pair: 'DOGE/USDT',
      price: '0,09209 USDT',
      setup: [
        { label: 'Capital', value: '300 USDT' },
        { label: 'Importe por compra', value: '15 USDT' },
        { label: 'Intervalo', value: '1440 min (1 día)' },
        { label: 'Compras máximas', value: '20' },
        { label: 'Comprar solo si mejora la media', value: 'No' },
        { label: 'Take profit', value: '5 % del margen' },
      ],
      outcome:
        'Desactivando la condición de la media, el bot compra cada día pase lo que pase: es el DCA clásico, sin filtro. Sube o baje DOGE, entran 15 USDT diarios durante veinte días. A cambio, tu precio medio puede empeorar si el par sube, y el objetivo del 5 % tarda más en llegar.',
    },
  ],
  options: {
    trailingTakeProfit: {
      what: 'Convierte el take profit en un objetivo que sigue al precio. Al llegar al porcentaje que pediste, el bot no cierra: empieza a seguir al mejor precio y solo cierra cuando retrocede lo que digas.',
      affects:
        'Apagado, sales exactamente en tu objetivo. Encendido, un movimiento que siga a favor te deja dentro y cobras más — pero cobras siempre un poco menos que el mejor precio, porque el retroceso es el peaje. A 1x, con un objetivo del 15 % del margen y un retroceso del 1 %, lo mínimo que cobras es un 13,85 %.',
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
    amountPerBuy: {
      what: 'Cuánto margen se compromete en cada compra. Con apalancamiento, la posición que añade es este importe multiplicado por el apalancamiento.',
      affects:
        'Junto al número de compras define el techo real del bot. Subirlo hace que cada entrada pese más y que el cupo se agote antes.',
      tip: 'Que no baje del mínimo del par, unos 10 USDC. La app rechaza el bot si importe por compras máximas supera el capital asignado.',
    },
    intervalMinutes: {
      what: 'Cuánto tiempo tiene que pasar entre una compra y la siguiente.',
      affects:
        'Es el ritmo del bot. Intervalos cortos reaccionan a una caída del mismo día; intervalos largos reparten las entradas a lo largo de semanas y gastan el cupo mucho más despacio.',
      tip: 'El intervalo se cuenta siempre, también cuando el precio cumple: es un freno, no un disparador.',
    },
    maxBuysPerCycle: {
      what: 'Cuántas compras como máximo puede hacer el bot antes de cerrar el ciclo.',
      affects:
        'Multiplicado por el importe por compra, es exactamente el dinero que este bot puede llegar a comprometer. Agotado el cupo, deja de comprar y se limita a esperar a que el objetivo se cumpla.',
      tip: 'Es el parámetro que convierte el DCA en algo acotado. Sin un número honesto aquí, el bot puede seguir promediando indefinidamente.',
    },
    buyOnlyIfImprovesAverage: {
      what: 'Si está activado, el bot solo compra cuando el precio mejora tu precio medio actual: por debajo en largo, por encima en corto.',
      affects:
        'Activado, tu media solo puede mejorar y el objetivo de beneficio solo puede acercarse. Desactivado se convierte en un DCA clásico que compra a intervalo fijo pase lo que pase, y tu media puede empeorar.',
      tip: 'Activado por defecto, y es lo que distingue esta estrategia de una compra programada cualquiera.',
    },
    marginBelowAveragePct: {
      what: 'Cuánto tiene que mejorar el precio tu media para que la compra cuente como una mejora, en % del precio: por debajo en largo, por encima en corto.',
      affects:
        'Con 0, cualquier precio por debajo de la media vale. Subirlo exige caídas más serias y guarda el cupo de compras para ellas, a costa de comprar menos veces.',
      tip: 'Solo se aplica si la condición de la media está activada. En pares volátiles, subirlo evita gastar el cupo en ruido.',
    },
    takeProfitPct: {
      what: 'Beneficio sobre tu margen al que se cierra la posición entera y termina el ciclo, medido desde el precio medio: a 3x, un 1,5 % del margen es un 0,5 % del precio.',
      affects:
        'La orden de cierre está siempre viva y se recalcula cada vez que una compra cambia tu media. Objetivos pequeños cierran ciclos a menudo; grandes dejan la posición abierta más tiempo.',
      tip: 'Las comisiones se pagan sobre el precio: un objetivo que en precio quede por debajo del 0,3 % puede cerrar el ciclo en pérdida.',
    },
    maxPositionNotional: {
      what: 'Tope del valor total de la posición. Es el freno propio de esta estrategia.',
      affects:
        'Alcanzado, el bot deja de comprar aunque le quede cupo de compras y haya pasado el intervalo. La orden de cierre sigue viva.',
      tip: 'Aquí manda este campo, no el tope de exposición genérico. Ponlo un poco por encima de importe por compras máximas por apalancamiento.',
    },
    maxNotionalCap: {
      what: 'Tope genérico de notional que comparten varias estrategias.',
      affects:
        'En el DCA temporizado el freno que el motor consulta es Notional máximo de la posición. Este queda como límite adicional.',
      tip: 'Configura Notional máximo de la posición y deja este vacio.',
    },
  },
};
