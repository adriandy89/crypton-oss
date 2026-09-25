import type { AiChannelConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const AI_CHANNEL_GUIDE: StrategyGuide<AiChannelConfig> = {
  headline:
    'Busca rangos y canales bien marcados y opera el rebote en su borde, con el apalancamiento que permite el stop. Un motor calcula cada número de cada operación posible, y una IA elige entre esas opciones.',
  risk: 'ALTO',
  bestFor:
    'Pares que se mueven de lado con bordes claros en 15 minutos: un zigzag que se ve a simple vista. Fuera de rango no opera: espera.',
  howItWorks: [
    'Cada cinco minutos, al cerrar la vela, mira tres gráficos: 1 h para saber si el mercado está en rango, 15 min para dibujar el canal y 5 min para ver el toque del borde.',
    'Un canal solo cuenta si pasa todas sus pruebas: toques en los dos bordes y alternados, el precio dentro casi siempre, una anchura que paga las comisiones y un precio que vuelve a la media deprisa. Sale con una nota de A a C.',
    'Cuando el precio toca un borde y lo rechaza —mecha, RSI extremo, divergencia, volumen tranquilo—, el rebote queda listo. Por defecto basta una confirmación: pedir dos filtra sin distinguir las buenas de las malas.',
    'El motor calcula cada operación posible: tres stops (ajustado, normal y amplio), dos objetivos (la media y cerca del borde opuesto), tres bandas de apalancamiento, el tamaño, el R neto y dónde quedaría la liquidación.',
    'La IA elige entre esas opciones sin poner un solo número. En modo reglas elige un juez fijo según el perfil. Sin una elección válida no se abre nada.',
    'La entrada es una orden límite inmediata con precio tope: si el libro se ha ido, no se llena y no pasa nada. El apalancamiento se fija justo antes, y solo con la posición plana.',
    'Con la posición abierta pone el stop y los objetivos como órdenes nativas del exchange. Tras el primer objetivo, el stop pasa a la entrada más costes.',
    'Cierra a mercado por su cuenta si se cumple el tiempo máximo, si una vela de 15 min cierra fuera del canal, si el mercado gira a tendencia en contra o si el stop no salta. Ninguna salida espera a la IA.',
    'Cada entrada llega por Telegram con sus números y un botón para pausar el bot; cada salida, con su resultado en USDC y en R y el motivo.',
    'En el detalle del bot, el panel «Canal con IA» enseña lo que ve el motor, la operación abierta, lo que va del día y cada decisión con sus motivos. Desde ahí se pausa el bot o se cortan sus entradas. Pausar cancela los objetivos y deja solo el stop.',
    'Cada consulta cuesta dinero: solo se pregunta con una operación lista, con un cupo por bot y otro de toda la plataforma, y el panel enseña lo gastado. Con el modo sombra del servidor la IA decide y se registra, pero no se ejecuta nada.',
  ],
  goodWhen: [
    'El par lleva horas rebotando entre dos niveles claros y el mercado está tranquilo.',
    'Quieres operar con apalancamiento alto sin elegir tú el número: aquí sale del stop, y la liquidación queda siempre a tres stops o más.',
    'Aceptas que muchos ratos no haga nada: el filtro de régimen está para eso.',
  ],
  badWhen: [
    'El precio va en una dirección. Un rango que se rompe es la forma en que esta estrategia pierde; por eso existen el régimen, la invalidación y el stop nativo.',
    'Hay noticias o datos macro: un hueco puede saltar el stop. Pon ventanas sin entradas en esas horas.',
    'El par tiene poca liquidez o el spread ancho: los costes se comen la ventaja del rebote, y el bot descarta esas operaciones.',
    'Esperas acertar casi siempre. Un rebote en el borde acierta entre un 55 y un 68 % de las veces: la ventaja sale de ganar más de lo que se arriesga, no de acertar siempre.',
  ],
  examples: [
    {
      title: 'Un rebote en el soporte, cifra a cifra',
      venue: 'Hyperliquid',
      pair: 'SOL/USDC',
      price: '100,02 USDC',
      setup: [
        { label: 'Capital', value: '1.000 USDC' },
        { label: 'Riesgo por operación', value: '1 %' },
        { label: 'Tope de apalancamiento', value: '25x' },
        { label: 'Canal', value: '99,90 – 102,90' },
        { label: 'Toque del soporte', value: '99,95' },
        { label: 'ATR de 15 min', value: '0,40' },
      ],
      outcome:
        'Con el stop ajustado en 99,84 y la entrada como mucho a 100,05, compra 31,257 SOL (3.127 USDC). Si el stop salta, pierde 10 USDC con comisiones: el 1 %. El apalancamiento puede ir de 13x a 25x; con 25x inmoviliza 125 USDC y la liquidación queda en 97,02, muy por detrás del stop. En la media (101,40) cobraría unas 4 veces lo arriesgado, y cerca del borde opuesto (102,45), unas 7.',
    },
    {
      title: 'Un día que sale mal',
      venue: 'Aster',
      pair: 'ETH/USDT',
      price: '3.000 USDT',
      setup: [
        { label: 'Capital', value: '2.000 USDT' },
        { label: 'Riesgo por operación', value: '1 %' },
        { label: 'Pérdida diaria máxima', value: '6 %' },
        { label: 'Pérdidas seguidas', value: '3' },
        { label: 'Espera tras la racha', value: '120 min' },
      ],
      outcome:
        'Cada stop cuesta como mucho 20 USDT. Tras tres stops seguidos, el bot espera dos horas antes de volver a entrar. Si el día llega a −120 USDT (el 6 %), no abre nada más hasta las 00:00 UTC y vuelve solo. Si llegara a −180 USDT —un hueco más allá de un stop—, se pausa y tienes que reanudarlo tú.',
    },
  ],
  options: {
    direction: {
      what: 'Qué lados puede abrir: los dos, solo largos o solo cortos.',
      affects:
        'Se puede cambiar con el bot en marcha: solo afecta a las entradas nuevas, nunca a la posición abierta.',
    },
    marginMode: {
      what: 'Solo margen aislado.',
      affects:
        'Así, lo que se puede perder si un hueco salta el stop es el margen de esa operación y nada más.',
    },
    leverage: {
      what: 'El apalancamiento más alto que se permite.',
      affects:
        'Cada operación calcula el suyo con su stop y nunca pasa de este tope ni del máximo del par. Un stop más ancho da menos apalancamiento.',
      tip: '25x como mucho.',
    },
    maxDailyLossPct: {
      what: 'La pérdida máxima del día UTC, en % del capital.',
      affects:
        'Al llegar, no hay entradas hasta las 00:00 UTC y el bot vuelve solo. A 1,5 veces el tope, se pausa hasta las 00:00 UTC: reanudarlo antes no abre entradas.',
      tip: 'Hasta el 6 %, y nunca por debajo del riesgo de una operación.',
    },
    stopLossPct: {
      what: 'No se usa: cada operación pone su stop con el canal y el ATR.',
      affects: 'Si lo rellenas, el bot solo avisa de que no lo usa.',
    },
    cooldownMinutes: {
      what: 'La espera entre una operación y la siguiente.',
      affects: 'Cuenta desde el cierre de la anterior.',
      tip: '15 min.',
    },
    structureInterval: {
      what: 'Las velas en las que se dibuja el canal.',
      affects:
        '15 min da canales de varias horas, más fiables y con menos operaciones. 5 min da canales cortos: más ocasiones y más ruido.',
      tip: 'Déjalo en 15 min. No se puede cambiar con el bot creado.',
    },
    decisionMode: {
      what: 'Quién elige la operación: la IA o un juez fijo.',
      affects:
        'Con IA, cada setup listo se consulta al modelo y, si no responde bien, no se abre nada. Con reglas decide el juez según el perfil, sin llamar a nadie.',
      tip: 'Reglas es lo que usa el backtest: pruébalo primero así.',
    },
    aiProfile: {
      what: 'Qué prefiere quien elige, dentro de lo que ya cumple tus límites.',
      affects:
        'Prudente: stop amplio, poco apalancamiento y objetivo en la media. Equilibrada: stop normal, apalancamiento medio y objetivo escalonado. Agresiva: stop ajustado, apalancamiento alto y objetivo escalonado.',
      tip: 'El perfil ordena preferencias; nunca afloja un límite.',
    },
    entriesEnabled: {
      what: 'El interruptor de las entradas nuevas.',
      affects:
        'Apagado, el bot no abre nada, pero sigue gestionando la posición abierta: stop, objetivos y salidas.',
      tip: 'Es la forma rápida de dejar de operar sin tocar lo que ya está en marcha. También se cambia desde el panel del bot, y la consola tiene un interruptor que corta las de todos a la vez.',
    },
    observeOnly: {
      what: 'Decide y lo apunta, pero no opera.',
      affects:
        'Cada decisión queda registrada con sus números, como si hubiera entrado, y no se manda ninguna orden. En modo IA sigue consultando al modelo, así que gasta consultas.',
      tip: 'Úsalo unos días antes de poner dinero para ver qué habría hecho.',
    },
    riskPerTradePct: {
      what: 'Qué parte del capital se pierde si salta el stop, con comisiones incluidas.',
      affects: 'El tamaño sale de aquí: con un stop más ancho, menos cantidad y la misma pérdida.',
      tip: 'Hasta el 2 %. Con el 1 %, diez stops seguidos son un 10 % del capital.',
    },
    maxMarginPct: {
      what: 'El margen máximo de una operación, en % del capital.',
      affects:
        'Es lo que se perdería si un hueco saltase el stop y llegase a la liquidación: con margen aislado no se puede perder más. Obliga a un apalancamiento mínimo.',
      tip: '25 % acota el peor caso a una cuarta parte del capital.',
    },
    maxNotionalMultiple: {
      what: 'El tamaño máximo de una posición, en veces el capital.',
      affects: 'Pone techo a la posición aunque el stop sea muy estrecho y el riesgo pida más.',
      tip: 'Con 5 y 1.000 USDC, nunca más de 5.000 USDC de posición.',
    },
    liqBufferStops: {
      what: 'A cuántos stops, como mínimo, queda la liquidación de la entrada.',
      affects:
        'Más stops es menos apalancamiento posible. Nunca baja de 3, y además se exigen 3 ATR de 1 h.',
      tip: '3 es el mínimo, y suficiente.',
    },
    maxStopPct: {
      what: 'El stop más ancho que se acepta, en % de la entrada.',
      affects:
        'Las opciones con el stop más lejos se descartan. Un stop ancho da menos apalancamiento.',
      tip: '1,5 % encaja con canales de 15 min en pares líquidos.',
    },
    maxCostPerTradeR: {
      what: 'Cuánto del riesgo pueden comerse las comisiones y el deslizamiento, en fracción.',
      affects:
        'Una entrada cuyo coste de ida y vuelta pase de ahí no se ofrece, por estrecha que sea la puerta.',
      tip: '0,2. Medido sobre siete meses, el bot venía operando con el coste en el 67 % del riesgo: con eso hay que acertar dos de cada tres veces solo para empatar.',
    },
    minTargetCostMultiple: {
      what: 'A cuántas veces el coste de ida y vuelta tiene que estar el primer objetivo.',
      affects:
        'Un objetivo más cerca no se ofrece. Sube mucho y casi no opera; baja y opera a pérdida.',
      tip: '15. Es la puerta que le da la vuelta al signo: con objetivos por debajo de 10 veces el coste, la medición sale negativa en los doce pares.',
    },
    minRewardRisk: {
      what: 'Lo mínimo que tiene que pagar un objetivo, en veces lo arriesgado y ya con comisiones.',
      affects: 'Un objetivo por debajo no se ofrece. Más alto es menos operaciones, y mejores.',
      tip: '1,2. Por debajo de 1, habría que acertar más de la mitad de las veces solo para empatar.',
    },
    maxEntrySlippageR: {
      what: 'Cuánto peor que el libro se admite entrar, en fracción de lo arriesgado.',
      affects:
        'Fija el precio tope de la orden de entrada. Si el libro se va más allá, la orden no se llena.',
      tip: '0,2: con un stop a 0,20 de distancia, la entrada puede empeorar hasta 0,04.',
    },
    maxSpreadFraction: {
      what: 'El spread máximo para entrar, en fracción del ATR de 15 min.',
      affects: 'Con el libro más abierto que eso, no hay entradas.',
      tip: '0,1: con un ATR de 0,40, un spread de hasta 0,04.',
    },
    makerFeeBps: {
      what: 'La comisión de las órdenes que esperan en el libro —los objetivos—, en puntos básicos.',
      affects: 'Entra en el R neto de cada objetivo.',
      tip: 'Vacío usa la tarifa base del exchange. Rellénalo si tu cuenta paga otra.',
    },
    takerFeeBps: {
      what: 'La comisión de las órdenes que cruzan el libro —la entrada, el stop y los cierres a mercado—.',
      affects: 'Entra en la pérdida al stop y, por tanto, en el tamaño.',
      tip: 'Vacío usa la tarifa base del exchange.',
    },
    slippageBps: {
      what: 'El deslizamiento que se supone al saltar el stop, en puntos básicos.',
      affects: 'Se suma a la pérdida al stop: más deslizamiento, menos tamaño.',
      tip: 'Vacío usa 2 bps.',
    },
    maxTradesPerDay: {
      what: 'Cuántas operaciones puede abrir en un día UTC.',
      affects: 'Al llegar, no hay más entradas hasta las 00:00 UTC.',
      tip: '8 deja operar sin que un mal día se alargue.',
    },
    maxConsecutiveLosses: {
      what: 'Cuántas pérdidas seguidas activan la espera.',
      affects: 'Tras la racha, el bot espera lo configurado antes de volver a entrar.',
      tip: '3.',
    },
    lossStreakCooldownMinutes: {
      what: 'Cuánto espera tras una racha de pérdidas.',
      affects:
        'Cuenta desde la última pérdida. Pasada la espera vuelve a operar, y otra pérdida la reinicia.',
      tip: '120 min.',
    },
    stopCooldownMinutes: {
      what: 'Cuánto espera tras un stop.',
      affects: 'Evita volver a entrar en el mismo borde que acaba de romperse.',
      tip: '30 min.',
    },
    dailyProfitTargetPct: {
      what: 'La ganancia del día a partir de la cual deja de abrir.',
      affects: 'Al llegar, no hay más entradas hasta las 00:00 UTC. Con 0 está apagado.',
      tip: 'Útil si prefieres no devolver un buen día.',
    },
    maxDrawdownPct: {
      what: 'La caída máxima del resultado desde su mejor punto, en % del capital.',
      affects:
        'Al llegar, el bot se pausa y tienes que reanudarlo tú. Se mide desde tu última reanudación: al reanudar, la caída vuelve a cero.',
      tip: '15 %: una señal de que el mercado ya no es el del canal.',
    },
    aiDailyCallBudget: {
      what: 'Cuántas consultas a la IA puede hacer el bot en un día.',
      affects:
        'Pasado el cupo, no hay entradas en modo IA hasta el día siguiente (UTC). El servidor tiene su propio techo por bot, y manda el menor de los dos.',
      tip: '48 da para un setup cada media hora.',
    },
    takeProfitSchemes: {
      what: 'Dónde se puede cobrar.',
      affects:
        'Media: todo en la línea media. Opuesto: todo cerca del borde contrario. Escalonado: una parte en cada uno. Todos: lo decide quien elige.',
      tip: 'Todos, salvo que tengas un motivo.',
    },
    tp1Fraction: {
      what: 'Qué parte de la posición se cobra en la media con el esquema escalonado.',
      affects: 'El resto va al borde opuesto.',
      tip: '60 %.',
    },
    breakevenAfterTp1: {
      what: 'Mover el stop a la entrada tras cobrar el primer objetivo.',
      affects: 'La parte que queda ya no puede perder, salvo por un hueco.',
      tip: 'Déjalo encendido.',
    },
    maxHoldBars: {
      what: 'El tiempo máximo de una operación, en velas de 15 min.',
      affects: 'Pasado ese tiempo, se cierra a mercado: un rebote que no llega ya no es el mismo.',
      tip: '24 velas son 6 horas.',
    },
    invalidationAtr: {
      what: 'Cuánto tiene que cerrar fuera del canal una vela de 15 min para darlo por roto.',
      affects: 'Con una posición abierta, se cierra a mercado. Menos es salir antes.',
      tip: '0,35 ATR.',
    },
    allowedSetups: {
      what: 'Qué operaciones puede abrir.',
      affects:
        'Rebote: en el borde que aguanta. Ruptura fallida: tras un cierre fuera que vuelve dentro; es la más arriesgada.',
      tip: 'Rebote.',
    },
    allowedChannels: {
      what: 'Qué canales valen.',
      affects:
        'Horizontal: un rango plano. Inclinado: dos rectas paralelas con pendiente. De banda: las de Bollinger, que no hace falta que nadie haya defendido y por eso aparecen mucho más a menudo, con el stop más lejos.',
      tip: 'Todos. El de banda es el que encuentra sitio: sobre doce pares y siete meses, 416 oportunidades frente a 18. Su objetivo es siempre la media, porque el borde opuesto de una banda está a cuatro sigmas y apuntar allí es pedir la travesía entera.',
    },
    slopedWithTrendOnly: {
      what: 'Operar un canal inclinado solo a favor de su pendiente.',
      affects: 'En uno que sube, solo largos; en uno que baja, solo cortos.',
      tip: 'Encendido: operar contra la pendiente es operar contra la tendencia.',
    },
    channelWindowBars: {
      what: 'Cuántas velas se miran para buscar el canal.',
      affects: 'Con más velas, canales más largos y fiables, que tardan más en aparecer.',
      tip: '96 velas de 15 min son un día.',
    },
    minChannelQuality: {
      what: 'La nota mínima del canal.',
      affects: 'A es la más exigente: menos canales, y mejores.',
      tip: 'B.',
    },
    minConfirmations: {
      what: 'Cuántas confirmaciones necesita un toque para estar listo.',
      affects:
        'Son cuatro posibles: mecha de rechazo, RSI extremo, divergencia y volumen tranquilo. Más confirmaciones son menos entradas, pero no mejores: filtran sin distinguir.',
      tip: '1. Aquí decía 2 y decía también que con menos las entradas serían peores. Está medido y es al revés: sobre doce pares y siete meses, pedir dos se llevaba por delante la mitad de las operaciones y empeoraba el resultado.',
    },
    requireEvidence: {
      what: 'Cuánto historial favorable se exige a un setup antes de ofrecerlo.',
      affects:
        'Mira cómo le fue a ese tipo de toque en los últimos siete días del par —cinco en Lighter, que sirve menos velas por petición—. Débil pide al menos 20 casos; moderada, más de 60.',
      tip: 'No, al empezar: con pocos días de historia casi nunca hay evidencia.',
    },
    minAiConfidence: {
      what: 'La confianza mínima de la IA para entrar.',
      affects:
        'Por debajo, la decisión se descarta. La confianza solo puede reducir el tamaño, nunca subirlo: por debajo de alta, la operación entra con la mitad.',
      tip: 'Media.',
    },
    maxAdverseFundingBps: {
      what: 'El funding en contra a partir del cual no se abre ese lado.',
      affects: 'Quien paga el funding en cada periodo empieza la operación perdiendo.',
      tip: '1 bp. Un 0 APAGA el filtro, no lo endurece. En Lighter no hace nada: ese exchange no publica el funding.',
    },
    fundingBlackoutMinutes: {
      what: 'Los minutos sin entradas antes del cobro del funding.',
      affects: 'Justo antes del cobro, el precio suele moverse de forma rara.',
      tip: '10 min. En Hyperliquid no aplica: no publica la hora del cobro.',
    },
    noEntryWindowsUtc: {
      what: 'Horas sin entradas, en UTC: por ejemplo «12:25-12:45, 18:00-18:30».',
      affects:
        'Dentro de una ventana no se abre nada; lo que ya está abierto se sigue gestionando.',
      tip: 'Pon las horas de los datos macro que muevan tu par. Hasta seis ventanas.',
    },
  },
};
