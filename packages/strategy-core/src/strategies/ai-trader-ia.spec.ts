import { AccionTrader, EstadoIntencion, ModoDecision, MotivoRechazo } from '@crypton/shared';
import type { BotContext, Candle, DecisionIa, VeredictoTrader } from '@crypton/shared';
import { esPlanCanal } from '@crypton/shared';
import { aiTrader } from './ai-trader';
import { makeMarket } from '../testing';

/**
 * La rama de IA del «Bot de IA» (spec 069): pedir, esperar y usar la decisión.
 *
 * El reparto que prueban estos tests es el de siempre: el modelo **elige entre
 * lo que el motor ya calculó**, y todo lo que llega de fuera se mira antes de
 * usarse. Sin decisión utilizable no hay entrada, nunca al revés.
 */

const MERCADO = makeMarket({
  tickSize: '0.01',
  stepSize: '0.001',
  priceDecimals: 2,
  qtyDecimals: 3,
  minNotional: '10',
  minQty: '0.001',
  maxLeverage: 50,
});

const AHORA = Date.UTC(2026, 8, 21, 12, 0, 0);
const QUINCE = 900_000;
const CINCO = 300_000;
const HORA = 3_600_000;
const BOT = '9c8d7e6f-0000-4000-8000-000000000001';
/** La caída de la última vela cerrada: la que provoca el toque del borde bajo. */
const CAIDA = 1;

/**
 * Serie determinista alrededor de 100 con una caída limpia al final.
 *
 * Sin `Math.random`: una serie que cambia entre ejecuciones convierte un fallo
 * real en «a veces falla», que es la peor clase de test.
 */
function serieConCaida(n: number, paso: number, fin: number, caida: number): Candle[] {
  const velas: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i * 1.7) * 0.35 + Math.cos(i * 0.9) * 0.25;
    const o = 100 + Math.sin((i - 1) * 1.7) * 0.35 + Math.cos((i - 1) * 0.9) * 0.25;
    velas.push({
      t: fin - (n - 1 - i) * paso,
      o: o.toFixed(2),
      c: c.toFixed(2),
      h: (Math.max(o, c) + 0.1).toFixed(2),
      l: (Math.min(o, c) - 0.1).toFixed(2),
      v: '1000',
    });
  }
  if (caida > 0) {
    const cierre = 100 - caida;
    velas[velas.length - 1] = {
      t: velas[velas.length - 1].t,
      o: '100.00',
      c: cierre.toFixed(2),
      h: '100.10',
      l: (cierre - 0.05).toFixed(2),
      v: '3000',
    };
  }
  return velas;
}

/**
 * La serie de 1 h que produce un régimen de RANGO.
 *
 * Un zigzag: el precio va y viene cada vela, así que la eficiencia es mínima y
 * el «chop» máximo. Es el mercado en el que esta estrategia dice operar, y sin
 * él el juez de reglas contesta ESPERAR y no hay nada que probar.
 */
function zigzag(n: number, paso: number, fin: number): Candle[] {
  const velas: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + (i % 2 ? 0.5 : -0.5);
    const o = 100 + (i % 2 ? -0.5 : 0.5);
    velas.push({
      t: fin - (n - 1 - i) * paso,
      o: o.toFixed(2),
      c: c.toFixed(2),
      h: (Math.max(o, c) + 0.2).toFixed(2),
      l: (Math.min(o, c) - 0.2).toFixed(2),
      v: '1000',
    });
  }
  return velas;
}

function contexto(o: Partial<BotContext> = {}, cfg: Record<string, unknown> = {}): BotContext {
  const precio = (100 - CAIDA).toFixed(2);
  return {
    botId: BOT,
    venue: 'LIGHTER',
    market: MERCADO,
    config: {
      exchangeAccountId: 'a',
      symbol: 'TEST',
      direction: 'NEUTRAL',
      leverage: 25,
      marginMode: 'ISOLATED',
      totalInvestment: '1000',
      makerFeeBps: '0',
      takerFeeBps: '0',
      slippageBps: '2',
      observeOnly: false,
      ...cfg,
    },
    ticker: {
      venue: 'LIGHTER',
      symbol: 'TEST',
      last: precio,
      bid: (Number(precio) - 0.01).toFixed(2),
      ask: (Number(precio) + 0.01).toFixed(2),
      mark: precio,
      ts: AHORA,
    },
    now: AHORA,
    position: null,
    availableBalance: '1000',
    cycle: { cycleId: 'c1', scratch: {} },
    series: {
      '5m': serieConCaida(144, CINCO, Math.floor(AHORA / CINCO) * CINCO - CINCO, CAIDA),
      '15m': serieConCaida(220, QUINCE, Math.floor(AHORA / QUINCE) * QUINCE - QUINCE, CAIDA),
      '1h': zigzag(200, HORA, Math.floor(AHORA / HORA) * HORA - HORA),
    },
    historial: {
      dia: Date.UTC(2026, 8, 21),
      operacionesHoy: 0,
      realizadoHoy: '0',
      rachaPerdidas: 0,
      ultimoCierreEn: null,
      ultimaPerdidaEn: null,
      ultimoStopEn: null,
      realizadoTotal: '0',
      picoRealizado: '0',
    },
    nivelesApalancamiento: [],
    ...o,
  } as BotContext;
}

const enIa = (o: Partial<BotContext> = {}, cfg: Record<string, unknown> = {}) =>
  contexto(o, { decisionMode: ModoDecision.IA, ...cfg });

/** La solicitud que sale de una vela con toque: de ahí salen la vela y la huella. */
function solicitud(): { barT: number; huella: string } {
  const plan = aiTrader.plan(enIa());
  if (!plan.solicitudIa) throw new Error(`Se esperaba una solicitud, y salió: ${plan.note}`);
  return { barT: plan.solicitudIa.barT, huella: plan.solicitudIa.huella };
}

const VEREDICTO: VeredictoTrader = {
  accion: AccionTrader.TOMAR,
  confianza: 'ALTA',
  acuerdo: true,
  stop: 'MEDIDO',
  objetivo: 'EN_LA_MEDIA',
  tamano: 'COMPLETO',
};

function decision(o: Partial<DecisionIa> = {}): DecisionIa {
  const s = solicitud();
  return {
    intentId: 'ia-1',
    estado: EstadoIntencion.DECIDIDA,
    origen: 'IA',
    barT: s.barT,
    huella: s.huella,
    eleccion: VEREDICTO,
    motivo: null,
    expiresAt: AHORA + 60_000,
    cycleSeq: 0,
    ...o,
  };
}

describe('AI_TRADER — el id de la intención (spec 069)', () => {
  /**
   * Ese id es la CLAVE PRIMARIA de `bot_ai_intents`. Sin el bot dentro, dos
   * bots de esta estrategia que decidieran la misma vela de 15 min chocaban, y
   * el segundo se quedaba sin fila —y por tanto sin entrada— en silencio.
   */
  it('lleva el bot dentro, no solo la vela', () => {
    const plan = aiTrader.plan(contexto({}, { observeOnly: true }));
    // Con «solo observar» la decisión se guarda aunque no se entre.
    expect(plan.decision).toBeDefined();
    expect(plan.decision!.intentId).toContain(BOT);
    expect(plan.decision!.intentId.startsWith('reglas:')).toBe(true);
  });
});

describe('AI_TRADER — pedir la decisión (spec 069)', () => {
  it('sin decisión para esta vela, se pide y no se entra', () => {
    const plan = aiTrader.plan(enIa());

    expect(plan.orders).toHaveLength(0);
    expect(plan.solicitudIa).toBeDefined();
    expect(plan.solicitudIa!.huella).not.toHaveLength(0);
    // La oferta que se manda es la del motor, entera: el modelo elige entre
    // celdas que YA están valoradas y validadas.
    expect(plan.solicitudIa!.snapshot).toHaveProperty('esqueletos');
    expect(plan.note).toContain('solicitud enviada');
  });

  it('el plazo de la solicitud vive más que la vela que la motivó', () => {
    const plan = aiTrader.plan(enIa());
    expect(plan.solicitudIa!.expiresAt).toBeGreaterThan(plan.solicitudIa!.barT + QUINCE);
  });

  it('mientras se consulta, el bot lo dice y no pide otra vez', () => {
    const d = decision({ estado: EstadoIntencion.CONSULTANDO, eleccion: null });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.solicitudIa).toBeUndefined();
    expect(plan.orders).toHaveLength(0);
    expect(plan.note).toContain('Consultando');
  });

  it('una decisión de OTRA vela no se usa: se pide de nuevo', () => {
    const d = decision({ barT: AHORA - 10 * QUINCE });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.solicitudIa).toBeDefined();
  });
});

describe('AI_TRADER — usar la decisión (spec 069)', () => {
  it('con el modelo diciendo TOMAR, se entra', () => {
    const plan = aiTrader.plan(enIa({ decisionIa: decision() }));

    expect(plan.orders).toHaveLength(1);
    expect(plan.decision).toBeDefined();
    expect(plan.decision!.estado).toBe(EstadoIntencion.ACEPTADA);
    expect(plan.decision!.intentId).toBe('ia-1');
    // El plan lo construye el motor, no el modelo: los números son suyos.
    const guardado = plan.decision!.plan!;
    expect(esPlanCanal(guardado) ? null : guardado.veredicto.stop).toBe('MEDIDO');
  });

  it('ESPERAR no entra, y no arma el enfriado', () => {
    const d = decision({ eleccion: { ...VEREDICTO, accion: AccionTrader.ESPERAR } });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.estado).toBe(EstadoIntencion.RECHAZADA);
    expect(plan.scratchPatch?.['enfriadoHasta']).toBeUndefined();
  });

  it('ENTORNO_EQUIVOCADO deja de mirar unas velas: eso es dinero que no se gasta', () => {
    const d = decision({ eleccion: { ...VEREDICTO, accion: AccionTrader.ENTORNO_EQUIVOCADO } });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(Number(plan.scratchPatch!['enfriadoHasta'])).toBeGreaterThan(AHORA);
  });

  it('una decisión caducada se rechaza por plazo', () => {
    const d = decision({ expiresAt: AHORA - 1 });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.motivo).toBe(MotivoRechazo.PLAZO);
  });

  /**
   * La huella es lo que garantiza que se ejecuta lo que se consultó. El worker
   * vuelve a derivar la oferta con datos frescos: si cambió, la decisión es
   * sobre otro mercado.
   */
  it('si la oferta cambió desde que se preguntó, no se ejecuta', () => {
    const d = decision({ huella: 'otra-cosa' });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.motivo).toBe(MotivoRechazo.HUELLA);
  });

  /**
   * Las dos estrategias con IA guardan su elección en la misma columna. Una del
   * canal aquí no se interpreta «como se pueda»: se rechaza.
   */
  it('una elección del canal no se lee como propia', () => {
    const delCanal = {
      veredicto: 'OPERAR',
      opcion: 'A',
      stop: 'NORMAL',
      objetivo: 'MEDIA',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
    };
    const d = decision({ eleccion: delCanal as never });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.motivo).toBe(MotivoRechazo.OFERTA);
  });

  /**
   * El acuerdo lo mira `construirOperacionTrader`, que es el unico camino a una
   * orden en los dos brazos. La estrategia NO lo vuelve a mirar: dos puertas
   * para lo mismo son dos sitios donde aflojarla.
   */
  it('sin acuerdo de las puertas de contexto, no se entra', () => {
    const d = decision({ eleccion: { ...VEREDICTO, acuerdo: false } });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.note).toContain('El contexto no acompana al toque.'.replace('na', 'ña'));
    // Y la fila queda CERRADA, no colgada esperando a que caduque.
    expect(plan.decision!.estado).toBe(EstadoIntencion.RECHAZADA);
  });

  /**
   * `requireAgreement` decide lo que la API ESCRIBE, no lo que el motor acepta.
   * Un veredicto guardado con `acuerdo: false` no entra jamas, lo pida el dueno
   * o no: cuando no lo exige, lo que llega guardado es `acuerdo: true`.
   */
  it('bajar la exigencia no rescata un veredicto ya escrito sin acuerdo', () => {
    const d = decision({ eleccion: { ...VEREDICTO, acuerdo: false } });
    const plan = aiTrader.plan(enIa({ decisionIa: d }, { requireAgreement: false }));

    expect(plan.orders).toHaveLength(0);
  });

  it('con confianza BAJA tampoco se entra', () => {
    const d = decision({ eleccion: { ...VEREDICTO, confianza: 'BAJA' } });
    const plan = aiTrader.plan(enIa({ decisionIa: d }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.estado).toBe(EstadoIntencion.RECHAZADA);
  });

  it('en «solo observar» decide igual pero no manda nada', () => {
    const plan = aiTrader.plan(enIa({ decisionIa: decision() }, { observeOnly: true }));

    expect(plan.orders).toHaveLength(0);
    expect(plan.decision!.estado).toBe(EstadoIntencion.RECHAZADA);
    // Con sus números: es la constancia de lo que habría hecho.
    expect(plan.decision!.plan).not.toBeNull();
  });
});

describe('AI_TRADER — el modo IA ya se puede elegir (spec 069)', () => {
  it('validate() no lo rechaza, y avisa de lo que puede faltar en el servidor', () => {
    const r = aiTrader.validate({ ...contexto().config, decisionMode: ModoDecision.IA }, MERCADO);

    expect(r.ok).toBe(true);
    const aviso = r.issues.find((i) => i.field === 'decisionMode');
    expect(aviso?.severity).toBe('WARNING');
  });
});
