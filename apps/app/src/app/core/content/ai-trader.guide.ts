import type { AiTraderConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const AI_TRADER_GUIDE: StrategyGuide<AiTraderConfig> = {
  headline:
    'Espera a que el precio toque el borde de una banda y apuesta a que vuelve al centro. El motor calcula nueve operaciones posibles y una IA elige entre ellas.',
  risk: 'ALTO',
  bestFor: 'Mercados que llevan horas dando vueltas alrededor de un precio, sin ir a ningún sitio.',
  howItWorks: [
    'Cada quince minutos dibuja una banda alrededor de la media de los últimos veinte cierres, ancha dos desviaciones típicas.',
    'Si el precio no está en un borde, no hay nada que hacer y no se gasta nada. Si lo está, el borde decide el sentido: abajo se compra, arriba se vende. Eso no lo elige nadie.',
    'Con el toque en la mano calcula nueve operaciones: tres distancias de stop por tres distancias de objetivo. Cada una viene con su tamaño, su apalancamiento y su liquidación, y las que no cierran su aritmética se descartan antes de enseñarlas.',
    'Quien decide —el juez de reglas o la IA— elige entre las que quedan. No puede elegir mal: lo que no se puede hacer no está en la lista.',
    'El stop y el objetivo se colocan como órdenes del propio exchange, así que siguen ahí aunque el bot se caiga. Lo único que necesita al bot vivo es el cierre por tiempo.',
  ],
  goodWhen: [
    'El ADX de una hora está por debajo de 20 y lleva un rato bajando.',
    'El precio ha cruzado la línea central varias veces en las últimas horas.',
    'Hay pocas oportunidades pero muy buenas: este bot vive de rechazar, no de operar mucho.',
  ],
  badWhen: [
    'El mercado está rompiendo o acelerando: un toque de banda en tendencia es continuación, no vuelta.',
    'Buscas un bot que opere a menudo. Éste descarta la inmensa mayoría de los toques a propósito.',
    'El par se mueve tan poco que el objetivo no llega a veinticinco veces lo que cuesta entrar y salir.',
  ],
  examples: [
    {
      title: 'Para mirarlo sin riesgo',
      venue: 'Lighter',
      pair: 'BTC',
      price: '110.000',
      setup: [
        { label: 'Capital', value: '500 USDC' },
        { label: 'Quién decide', value: 'Reglas' },
        { label: 'Solo observar', value: 'Sí' },
        { label: 'Riesgo por operación', value: '0,5 %' },
      ],
      outcome:
        'Como viene de fábrica: no manda ni una orden. Apunta en el histórico lo que habría hecho, con su precio, su stop y su tamaño, para que lo compares con lo que hizo el mercado. Es la manera barata de decidir si te fías.',
    },
    {
      title: 'Con dinero, prudente',
      venue: 'Lighter',
      pair: 'BTC',
      price: '110.000',
      setup: [
        { label: 'Capital', value: '1.000 USDC' },
        { label: 'Quién decide', value: 'Reglas' },
        { label: 'Solo observar', value: 'No' },
        { label: 'Riesgo por operación', value: '0,3 %' },
        { label: 'Operaciones al día', value: '4' },
      ],
      outcome:
        'Arriesga 3 USDC por operación y no pasa de cuatro al día. Decide el juez de reglas, no la IA: stop a 2 ATR y objetivo en la media, que es la configuración que se midió. Si el ADX de una hora sube de 20, deja de entrar solo.',
    },
  ],
  options: {
    decisionMode: {
      what: 'Quién elige entre las operaciones que el motor ha calculado.',
      affects:
        'Con «reglas» decide una tabla determinista y no se gasta ninguna llamada. Con «IA» decide el modelo: por cada toque de la banda recibe el estado de la vela y contesta ocho preguntas, y el motor construye la operación con lo que elija. Sin respuesta válida no hay entrada, nunca al revés.',
      tip: 'Empieza en reglas. Cuando pases a IA, déjalo antes en «solo observar» unos días: verás en la línea de tiempo qué habría decidido y con cuánta confianza, sin que toque el mercado.',
    },
    decisionInterval: {
      what: 'Cada cuánto mira el mercado y decide.',
      affects:
        'Marca de qué velas sale la banda, cada cuánto puede abrir, y cuánto dura una operación: los topes de velas se cuentan en velas de esta cadencia.',
      tip: '15 minutos, y no es arbitrario: medido sobre BTC con costes reales da 0,71 evaluaciones al día contra 0,38 a 5 minutos y 0,34 a 30. En pares más volátiles que BTC, 5 minutos puede dar más. 1 minuto no está porque no funciona: 30 días de BTC dieron 8.719 toques y ninguno ejecutable, porque el coste de entrar y salir es fijo y el recorrido de una vela de 1 minuto no llega a pagarlo.',
    },
    observeOnly: {
      what: 'Apuntar lo que haría, sin mandar ninguna orden.',
      affects: 'El bot funciona entero pero no toca el mercado.',
      tip: 'Déjalo encendido al principio. Es la manera barata de ver si te gusta lo que decide.',
    },
    entriesEnabled: {
      what: 'Permitir abrir operaciones nuevas.',
      affects: 'Apagado, lo que esté abierto se gestiona hasta el final, pero no entra nada más.',
      tip: 'Es la forma de ir parando sin dejar una posición a medias.',
    },

    riskPerTradePct: {
      what: 'Cuánto del capital se arriesga en cada operación, si salta el stop.',
      affects: 'Es lo que fija el tamaño. Todo lo demás sale de aquí.',
      tip: '0,5 %. Con 1.000 son 5 por operación.',
    },
    maxMarginPct: {
      what: 'El margen máximo que puede quedar inmovilizado a la vez.',
      affects: 'Acota lo que se pierde en un hueco de precio, que es lo que el stop no cubre.',
      tip: '25 %.',
    },
    maxNotionalMultiple: {
      what: 'El tamaño máximo de una operación, en veces tu capital.',
      affects: 'Un techo más, por si el stop sale muy estrecho y el tamaño se dispara.',
      tip: '5.',
    },
    liqBufferStops: {
      what: 'A cuántas distancias de stop queda la liquidación, como mínimo.',
      affects: 'Más distancia es menos apalancamiento. Nunca baja de 3.',
      tip: '3 es el mínimo, y suficiente.',
    },
    maxStopPct: {
      what: 'El stop más ancho que se acepta, en % del precio.',
      affects: 'Las operaciones con el stop más lejos se descartan.',
      tip: '2 %. La banda pide stops más anchos que un rango de toda la vida.',
    },
    maxCostPerTradeR: {
      what: 'Cuánto del riesgo pueden comerse las comisiones y el deslizamiento.',
      affects: 'Una operación que pase de ahí no se ofrece, por bonito que sea el toque.',
      tip: '0,15. Medido: con el coste en dos tercios del riesgo hay que acertar dos de cada tres veces solo para empatar.',
    },
    minTargetCostMultiple: {
      what: 'A cuántas veces el coste de ida y vuelta tiene que estar el objetivo.',
      affects: 'Más alto es menos operaciones y mejores. No se puede bajar de 15.',
      tip: '25. Por debajo de 15 está medido que se pierde de media, y por eso el formulario no te deja.',
    },
    minRewardRisk: {
      what: 'Lo mínimo que tiene que pagar el objetivo, en veces lo arriesgado.',
      affects: 'Un objetivo que no llega no se ofrece.',
      tip: '1. Por debajo habría que acertar más de la mitad de las veces solo para empatar.',
    },
    maxEntrySlippageR: {
      what: 'Cuánto peor que el libro se admite entrar.',
      affects:
        'Fija el precio tope de la entrada. Si el libro se va más allá, no se llena y no pasa nada.',
      tip: '0,15.',
    },
    maxSpreadFraction: {
      what: 'El spread máximo para entrar, en fracción del ATR.',
      affects: 'Con el libro más abierto que eso, no se entra.',
      tip: '0,1.',
    },
    maxDrawdownPct: {
      what: 'La caída máxima que aguantas antes de que el bot se pare solo.',
      affects: 'Al llegar, pausa. Reanudar es cosa tuya.',
      tip: '15 %.',
    },
    dailyProfitTargetPct: {
      what: 'Ganancia del día a partir de la cual deja de entrar.',
      affects: 'Cero lo apaga.',
      tip: 'Cero. Parar de ganar no suele salir a cuenta.',
    },

    bandPeriod: {
      what: 'Cuántos cierres entran en la media de la banda.',
      affects: 'Más cierres es una banda más lenta y menos toques.',
      tip: '20. Es el de toda la vida y es el que se midió.',
    },
    bandSigma: {
      what: 'Cuántas desviaciones típicas de ancho tiene la banda.',
      affects: 'Más ancha es menos toques, pero más lejos de la media cuando los hay.',
      tip: '2. Por debajo de 1,5 toca demasiado y no significa nada.',
    },
    bandWindowBars: {
      what: 'Cuántas velas hacia atrás se miran para medir si esto de verdad revierte.',
      affects: 'De ahí salen la contención, los cruces y la media vida.',
      tip: '96, que son veinticuatro horas.',
    },
    touchPercentB: {
      what: 'Cuánto cuenta como «estar en el borde», en fracción de la anchura.',
      affects:
        'Más grande es más toques y peores. Cero exige tocar la banda exacta, que casi nunca pasa.',
      tip: '0,1: el décimo exterior. Es lo que se midió.',
    },
    maxAdx1h: {
      what: 'El ADX de una hora por encima del cual no se opera.',
      affects:
        'Es el filtro más valioso que tiene el bot. Súbelo y empezarás a comprar caídas en tendencia.',
      tip: '20. No lo subas sin medirlo.',
    },
    minBandWidthAtr: {
      what: 'Lo estrecha que puede ser la banda, en veces el ATR.',
      affects: 'Una banda estrecha no deja sitio para que el objetivo pague el viaje.',
      tip: '2.',
    },
    maxHalfLifeBars: {
      what: 'Lo que puede tardar el precio en volver a la media para que cuente como reversión.',
      affects: 'Si tarda más, no es un rango: es una deriva lenta.',
      tip: '12 velas, o sea tres horas.',
    },

    maxHoldBars: {
      what: 'Cuántas velas se le dan a una operación antes de cerrarla a mercado.',
      affects:
        'Es la única salida que necesita al bot vivo; el stop y el objetivo están en el exchange.',
      tip: '24, o sea seis horas.',
    },
    invalidationAtr: {
      what: 'Cuánto tiene que alejarse el precio de la banda para dar el montaje por roto.',
      affects: 'Más pequeño cierra antes y con menos pérdida, pero también por ruido.',
      tip: '0,5 ATR.',
    },

    minRouteConfidence: {
      what: 'Un suelo de confianza por debajo del cual no se opera, aunque la IA diga que sí.',
      affects:
        'A 0 —como viene— decide la IA: su elección se ejecuta. Súbelo y le pones un juez encima.',
      tip: '0, y por una razón medida: contra BTC real su confianza no pasó de 0,61 en dieciséis llamadas. Con un suelo de 0,45 el que decidía era el umbral, no el modelo. Si lo subes, sube poco y mira antes cuántas decisiones te estás comiendo.',
    },
    fullSizeConfidence: {
      what: 'La confianza a partir de la cual se entra con la posición entera.',
      affects:
        'A 0 —como viene— se entra siempre entera. Por encima, una confianza menor entra con la mitad. Nunca sube el tamaño: solo puede reducirlo.',
      tip: '0. El tamaño ya lo gobierna tu riesgo por operación, que es lo que de verdad limita la pérdida.',
    },
    requireAgreement: {
      what: 'Dejar que las tres preguntas de contexto VETEN la decisión de la IA.',
      affects:
        'Apagado —como viene— manda lo que la IA eligió. Encendido, si alguna de las tres no acompaña, no se opera.',
      tip: 'Apagado. El modelo ya tiene en cuenta el régimen, el toque y el histórico cuando elige; volver a preguntárselos por separado para poder llevarle la contraria es ponerle un juez encima. Enciéndelo solo si quieres ese juez.',
    },
    minRegimeProb: {
      what: 'Cuánto tiene que creer la IA que el mercado está dando vueltas y no yéndose.',
      affects: 'Es una de las tres puertas de contexto.',
      tip: '0,75.',
    },
    minExhaustionProb: {
      what: 'Cuánto tiene que creer que quien empujó el precio al borde se ha quedado sin fuerza.',
      affects: 'Otra de las tres puertas.',
      tip: '0,65.',
    },
    minEvidenceProb: {
      what: 'Cuánto tiene que creer que el histórico de toques parecidos acompaña.',
      affects:
        'La tercera puerta. Se le enseñan las tasas de verdad: casos resueltos, acierto y R medio.',
      tip: '0,55.',
    },
    statedThreshold: {
      what: 'Cuánta razón tiene que declarar la IA para que se le haga caso sobre el stop y el objetivo.',
      affects:
        'A 0 —como viene— manda SIEMPRE su elección. Por encima, si no llega al umbral se usan tus valores por defecto en su lugar.',
      tip: '0. Estaba en 0,6, y en las dieciséis llamadas contra BTC real el modelo se quedó por debajo las dieciséis veces: su elección de stop se tiraba entera y mandaba el valor por defecto. Eso no es que decida la IA.',
    },
    defaultStopBucket: {
      what: 'Qué stop se usa cuando la IA no tiene una razón clara para preferir otro.',
      affects: 'Es el que se aplica casi siempre.',
      tip: 'El medido, que son 2 ATR. Es lo que salió mejor al medirlo.',
    },
    defaultTargetBucket: {
      what: 'Qué objetivo se usa cuando la IA no tiene una razón clara para preferir otro.',
      affects: 'Igual que el anterior.',
      tip: 'En la media. El borde contrario ni siquiera es una opción: está a cuatro sigmas y está medido que hunde el resultado.',
    },
    halfSizeFallback: {
      what: 'Qué hacer cuando toca media posición y el exchange no la admite por tamaño mínimo.',
      affects: 'O no se opera, o se entra entera.',
      tip: 'No operar. Entrar entera cuando la confianza pedía media es justo lo contrario de lo que quieres.',
    },
    wrongEnvironmentCooldownBars: {
      what: 'Cuántas velas se deja de mirar cuando la IA dice que el entorno es el equivocado.',
      affects:
        'Ahorra llamadas: si el mercado está en tendencia, preguntar cada quince minutos es tirar dinero.',
      tip: '8 velas, o sea dos horas.',
    },
    aiDailyCallBudget: {
      what: 'Cuántas consultas al modelo puede gastar este bot al día.',
      affects: 'Al agotarlo deja de preguntar hasta el día siguiente.',
      tip: '300, que cubre de sobra la cadencia más rápida. No es un número apretado a propósito: cada consulta cuesta 0,000081 $, así que gastarlas todas un mes entero sale por menos de tres céntimos. Y medido, el tope no se roza nunca: quien limita cuántas veces se decide es la puerta del coste, no esto.',
    },

    maxTradesPerDay: {
      what: 'Cuántas operaciones puede abrir en un día.',
      affects: 'Al llegar, no entra más hasta el día siguiente.',
      tip: '8.',
    },
    maxConsecutiveLosses: {
      what: 'Cuántas pérdidas seguidas hacen que se tome un descanso.',
      affects: 'Al llegar, espera lo que diga el campo de abajo.',
      tip: '3.',
    },
    lossStreakCooldownMinutes: {
      what: 'Cuánto espera tras una racha de pérdidas.',
      affects: 'Es el descanso que corta la racha.',
      tip: '120 minutos.',
    },
    stopCooldownMinutes: {
      what: 'Cuánto espera después de que salte un stop.',
      affects: 'Evita volver a entrar en el mismo sitio que acaba de fallar.',
      tip: '30 minutos.',
    },

    makerFeeBps: {
      what: 'La comisión de las órdenes que esperan en el libro: el objetivo.',
      affects: 'Entra en el cálculo de si la operación paga el viaje.',
      tip: 'Vacío usa la del exchange. Rellénalo si tu cuenta paga otra.',
    },
    takerFeeBps: {
      what: 'La comisión de las órdenes que cruzan el libro: la entrada y el stop.',
      affects: 'Entra en la pérdida al stop y, por tanto, en el tamaño.',
      tip: 'Vacío usa la del exchange. Y no, una comisión más alta no es peor aquí: al medirlo salió que aprieta la puerta del coste y deja pasar solo lo bueno.',
    },
    slippageBps: {
      what: 'El deslizamiento que se supone al saltar el stop.',
      affects: 'Se suma a la pérdida: más deslizamiento, menos tamaño.',
      tip: 'Vacío usa el del exchange.',
    },
  },
};
