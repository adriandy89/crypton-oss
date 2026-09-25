import type { AgentTradeConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const AGENT_TRADE_GUIDE: StrategyGuide<AgentTradeConfig> = {
  headline:
    'La operación de un agente de IA: entra una vez con un precio tope, pone su stop y sus objetivos en el exchange, y se detiene al cerrarse. No decide nada: los números los calculó el motor del agente y se recalcularon al aprobarla.',
  risk: 'ALTO',
  bestFor:
    'No se elige: la crea un agente de la sección IA cuando se aprueba una de sus propuestas, a mano o sola si su autonomía lo permite. Aquí se explica qué hace mientras vive.',
  howItWorks: [
    'Nace de una propuesta aprobada. Al aprobarla se vuelven a calcular la entrada, la cantidad y el apalancamiento con el precio de ese momento; si el precio ya pasó el stop o se ha movido más de medio stop, no nace.',
    'La entrada es una orden inmediata con precio tope: si el libro se ha ido, no se llena. Se reintenta mientras dure su plazo, y no entra con el precio a menos de medio stop del stop.',
    'El apalancamiento es el de la operación, y se rebaja si el tramo del exchange o el tope de tu cuenta lo exigen. Nunca se sube.',
    'Con la posición abierta pone el stop y los objetivos como órdenes nativas del exchange: siguen ahí aunque el bot o el servidor se caigan.',
    'El stop solo se ciñe. Si una configuración lo aleja —la pida el seguimiento del agente o una edición a mano—, se ignora y se avisa.',
    'Tras el primer objetivo, el stop pasa a la entrada más costes y, si se pide, sigue al mejor precio.',
    'El seguimiento del agente solo puede ceñir el stop o reducir la posición («Tope de posición»): cero es cerrar. Aplicarlo dos veces no reduce dos veces.',
    'Cierra a mercado por tiempo, si el stop no salta, si la liquidación queda demasiado cerca o si el exchange informa más apalancamiento del pedido.',
    'Cerrada la posición, vencida la entrada o con una posición ajena en el par, se detiene. Rearrancarla no la hace entrar otra vez.',
  ],
  goodWhen: [
    'Quieres que un agente proponga y tú decidas con los números delante: la propuesta llega con entrada, stop, objetivos y la pérdida al stop en USDC.',
    'Quieres que el riesgo lo fije el stop y no una intuición: la cantidad sale de tu riesgo por operación.',
  ],
  badWhen: [
    'Esperas que acierte siempre. El agente mide lo que propone —también lo que no tomas— y la tarjeta de resultados enseña si de verdad distingue lo bueno de lo malo.',
    'Operas a mano en el mismo par y la misma cuenta: el exchange suma las posiciones. El bot solo gestiona su cantidad, y una posición del otro lado lo detiene sin tocarla.',
    'Hay noticias o datos macro: un hueco puede saltar el stop. El margen aislado acota lo que se pierde en ese caso.',
  ],
  examples: [
    {
      title: 'Un largo con dos objetivos',
      venue: 'Hyperliquid',
      pair: 'SOL/USDC',
      price: '100,05 USDC',
      setup: [
        { label: 'Tope de entrada', value: '100,10' },
        { label: 'Stop', value: '98,00' },
        { label: 'Objetivos', value: '104,00 (la mitad) y 108,00' },
        { label: 'Cantidad', value: '1 SOL' },
        { label: 'Apalancamiento', value: '5x, aislado' },
      ],
      outcome:
        'Entra como mucho a 100,10. Si salta el stop pierde unos 2,21 USDC con comisiones y deslizamiento: eso es 1R. En 104 cobra la mitad y el stop sube a la entrada más costes; en 108, el resto. Si llega a los dos, gana unos 5,8 USDC, algo más de 2,6R. Con 5x inmoviliza unos 20 USDC y la liquidación queda muy por detrás del stop.',
    },
  ],
  options: {
    entryLimitPrice: {
      what: 'El precio tope de la entrada.',
      affects:
        'La entrada es una orden inmediata a este precio: si el libro está peor, no se llena y se reintenta mientras dure el plazo.',
      tip: 'Lo calcula el agente con una holgura de 0,2R sobre el libro del momento.',
    },
    entryDeadline: {
      what: 'Hasta cuándo puede entrar.',
      affects: 'Pasado sin llenarse, la operación no entra y el bot se detiene.',
    },
    quantity: {
      what: 'Lo que compra o vende la entrada, en moneda.',
      affects:
        'Sale de tu riesgo por operación y de la distancia al stop: con el stop más lejos, menos cantidad para la misma pérdida.',
    },
    riskAmount: {
      what: 'Lo que se pierde si salta el stop, con comisiones y deslizamiento.',
      affects: 'Es lo que vale 1R: el resultado de la operación se cuenta en R con él.',
    },
    agentProposalId: {
      what: 'La propuesta del agente de la que nace.',
      affects: 'Enlaza la operación con su propuesta, su seguimiento y su medida.',
    },
    stopPrice: {
      what: 'El stop de la operación, como orden condicional del exchange.',
      affects:
        'Con la posición abierta solo se ciñe: un cambio que lo aleja se ignora. Un stop pedido que el precio ya pasó cierra a mercado.',
      tip: 'Ceñirlo es lo que hacen «Proteger» y «Asegurar» en el seguimiento del agente.',
    },
    tp1Price: {
      what: 'El primer objetivo: una orden límite reduce-only.',
      affects: 'Cobrarlo pasa el stop a la entrada más costes si está activado.',
    },
    tp2Price: {
      what: 'El segundo objetivo, opcional.',
      affects: 'Con él, la posición sale en dos partes; sin él, entera en el primero.',
    },
    tp1Fraction: {
      what: 'La parte de la posición que sale en el primer objetivo, con dos objetivos.',
      affects: 'Más parte asegura antes; menos deja correr más hacia el segundo.',
    },
    breakevenAfterTp1: {
      what: 'Tras el primer objetivo, el stop pasa a la entrada más lo que cuesta salir.',
      affects:
        'Lo que queda de la operación ya no puede perder, a cambio de salir si el precio vuelve a la entrada.',
    },
    trailAfterTp1: {
      what: 'Tras el primer objetivo, el stop sigue al mejor precio.',
      affects:
        'Nunca retrocede. Si el precio sube y vuelve más de la distancia entre dos revisiones, cierra como lo habría hecho el stop.',
    },
    trailCallbackPct: {
      what: 'A qué distancia del mejor precio va el stop que lo sigue.',
      affects: 'Más pequeña asegura más y salta antes con el ruido.',
    },
    maxHoldMinutes: {
      what: 'La duración máxima desde la entrada.',
      affects: 'Pasada, la operación se cierra a mercado.',
    },
    positionCap: {
      what: 'La posición, como mucho esto. Cero es cerrar.',
      affects:
        'Si hay más, se reduce a mercado; aplicarlo dos veces no reduce dos veces. Subirlo después no añade nada: la operación nunca aumenta.',
      tip: '«Reducir un tercio», «Reducir la mitad» y «Cerrar» del seguimiento del agente se aplican aquí.',
    },
    totalInvestment: {
      what: 'El margen aislado de la operación.',
      affects: 'Es lo más que se perdería si el precio saltara más allá de la liquidación.',
    },
    stopLossPct: {
      what: 'No se usa: la operación lleva su propio stop, el precio que calculó el agente.',
      affects: 'Si lo rellenas, el bot solo avisa de que no lo usa.',
    },
    leverage: {
      what: 'El apalancamiento de la operación, fijo.',
      affects:
        'No cambia lo que se pierde en el stop: cambia el margen y la distancia a la liquidación, que siempre queda detrás del stop.',
    },
  },
};
