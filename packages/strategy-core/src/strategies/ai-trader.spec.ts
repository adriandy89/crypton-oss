import { ModoDecision } from '@crypton/shared';
import type { BotContext, Candle } from '@crypton/shared';
import { aiTrader } from './ai-trader';
import { makeMarket } from '../testing';
import { historiaConRango, senoidal } from '../canal/testing-canal';

/**
 * Los seis agujeros que tenía la primera versión de esta estrategia, cada uno
 * con su test para que no vuelvan. Se encontraron leyéndola con calma después
 * de escribirla deprisa, y ninguno lo habría cazado la batería que había.
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

/** Velas que terminan justo en la última cerrada esperada para `AHORA`. */
function serie(n: number, paso: number, fin: number): Candle[] {
  const base = senoidal({ n, periodo: 12, mecha: 0.2 });
  return base.map((v, i) => ({ ...v, t: fin - (n - 1 - i) * paso }));
}

function contexto(o: Partial<BotContext> = {}, cfg: Record<string, unknown> = {}): BotContext {
  const fin15 = Math.floor(AHORA / QUINCE) * QUINCE - QUINCE;
  return {
    botId: '9c8d7e6f-0000-4000-8000-000000000001',
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
      last: '100',
      bid: '99.99',
      ask: '100.01',
      mark: '100',
      ts: AHORA,
    },
    now: AHORA,
    position: null,
    availableBalance: '1000',
    cycle: { cycleId: 'c1', scratch: {} },
    series: {
      '5m': serie(144, CINCO, Math.floor(AHORA / CINCO) * CINCO - CINCO),
      '15m': serie(220, QUINCE, fin15),
      '1h': historiaConRango(7, 40, 90).map((v, i, a) => ({
        ...v,
        t: Math.floor(AHORA / HORA) * HORA - HORA - (a.length - 1 - i) * HORA,
      })),
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

describe('AI_TRADER — las puertas que faltaban (spec 068)', () => {
  it('no decide sobre velas a medio formar', () => {
    // Series que se quedan una vela corta: la última aún no ha cerrado.
    const viejas = contexto({
      series: {
        '5m': serie(144, CINCO, Math.floor(AHORA / CINCO) * CINCO - 10 * CINCO),
        '15m': serie(220, QUINCE, Math.floor(AHORA / QUINCE) * QUINCE - 10 * QUINCE),
        '1h': [],
      },
    });
    const plan = aiTrader.plan(viejas);

    expect(plan.orders).toHaveLength(0);
    expect(plan.note).toContain('Esperando la última vela');
  });

  it('no entra con el libro demasiado abierto', () => {
    const ancho = contexto(
      { ticker: { ...contexto().ticker, bid: '95', ask: '105' } },
      { maxSpreadFraction: 0.02 },
    );
    const plan = aiTrader.plan(ancho);

    expect(plan.orders).toHaveLength(0);
  });

  it('el objetivo del día cierra la puerta cuando se alcanza', () => {
    const cumplido = contexto(
      { historial: { ...contexto().historial!, realizadoHoy: '60' } },
      { dailyProfitTargetPct: 5 },
    );
    const plan = aiTrader.plan(cumplido);

    expect(plan.note).toContain('Objetivo del día alcanzado');
    expect(plan.orders).toHaveLength(0);
  });

  /**
   * La caída máxima PAUSA el bot: es de lo que no se cura solo. El tope del día
   * o una espera se curan con el tiempo; haber devuelto lo ganado, no.
   */
  it('la caída máxima pausa el bot, no solo cierra la puerta', () => {
    const caido = contexto(
      {
        historial: {
          ...contexto().historial!,
          realizadoTotal: '-100',
          picoRealizado: '200',
        },
      },
      { maxDrawdownPct: 15 },
    );
    const plan = aiTrader.plan(caido);

    expect(plan.pausar).toBeDefined();
    expect(plan.pausar).toContain('Caída máxima');
  });

  /**
   * Este test afirmaba lo contrario hasta el spec 069: mientras no habia
   * proveedor cableado, elegir el modo IA se rechazaba en el formulario, porque
   * un mando que se puede poner y no hace nada es peor que uno que no esta.
   * Ya hay proveedor, asi que ahora es un AVISO: la configuracion es correcta y
   * lo que puede faltar —la clave, el interruptor— esta en el servidor.
   */
  it('el modo IA ya se puede elegir, con su aviso', () => {
    const r = aiTrader.validate({ ...contexto().config, decisionMode: ModoDecision.IA }, MERCADO);
    expect(r.ok).toBe(true);
    expect(r.issues.find((i) => i.field === 'decisionMode')?.severity).toBe('WARNING');
  });

  it('y en reglas valida sin quejarse de eso', () => {
    const r = aiTrader.validate(
      { ...contexto().config, decisionMode: ModoDecision.REGLAS },
      MERCADO,
    );
    expect(r.issues.some((i) => i.field === 'decisionMode')).toBe(false);
  });
});

describe('AI_TRADER — con la posición abierta (spec 068)', () => {
  const planGuardado = {
    intentId: 'reglas:1',
    lado: 'LONG' as const,
    veredicto: {
      accion: 'TOMAR' as const,
      confianza: 'ALTA' as const,
      acuerdo: true,
      stop: 'MEDIDO' as const,
      objetivo: 'EN_LA_MEDIA' as const,
      tamano: 'COMPLETO' as const,
    },
    entradaReferencia: '100',
    entradaTope: '100.01',
    stop: '99',
    objetivos: [{ precio: '101', cantidad: '1' }],
    cantidad: '1',
    apalancamiento: 10,
    nocional: '100.01',
    riesgo: '1',
    rNeto: 1.5,
    liquidacionEstimada: '95',
    huella: 'h',
    barT: AHORA - QUINCE,
    banda: { superior: '101.5', media: '100.5', inferior: '99.5', refT: AHORA - QUINCE },
    venceEn: AHORA + QUINCE,
    distanciaStop: 0.01,
  };

  const conPosicion = (scratch: Record<string, unknown>, o: Partial<BotContext> = {}) =>
    aiTrader.plan(
      contexto({
        position: { qty: '1', entryPrice: '100.01' },
        cycle: { cycleId: 'c1', scratch },
        ...o,
      } as Partial<BotContext>),
    );

  it('mantiene el stop y el objetivo nativos mientras la operación vive', () => {
    const plan = conPosicion({ op: { plan: planGuardado, intento: 0, enviadaEn: 0 } });

    expect(plan.orders.map((o) => o.levelKind).sort()).toEqual(['STOP_LOSS', 'TAKE_PROFIT']);
    expect(plan.immediate).toHaveLength(0);
  });

  /**
   * El agujero más serio que tenía: un identificador FIJO para el cierre. Con
   * uno fijo, un cierre llenado a medias deja su fila ejecutada, esa fila veta
   * el reintento, y la posición se queda abierta con nadie mirándola.
   */
  it('el cierre por tiempo usa un identificador DISTINTO en cada intento', () => {
    const vencido = { ...planGuardado, venceEn: AHORA - 1 };
    const primero = conPosicion({ op: { plan: vencido, intento: 0, enviadaEn: 0 } });
    expect(primero.immediate).toHaveLength(1);

    const cierre = (primero.scratchPatch?.['op'] as { cierre: { intentos: number } }).cierre;
    expect(cierre.intentos).toBe(1);

    // El segundo intento, pasada la espera, usa otro identificador.
    const segundo = conPosicion(
      { op: { plan: vencido, intento: 0, enviadaEn: 0, cierre: { ...cierre, ultimoEn: 0 } } },
      {},
    );
    expect(segundo.immediate[0].clientOrderId).not.toBe(primero.immediate[0].clientOrderId);
  });

  it('respeta la espera entre intentos en vez de machacar al venue', () => {
    const vencido = { ...planGuardado, venceEn: AHORA - 1 };
    const reciente = conPosicion({
      op: {
        plan: vencido,
        intento: 0,
        enviadaEn: 0,
        cierre: { motivo: 'TIEMPO', intentos: 1, ultimoEn: AHORA - 1000 },
      },
    });
    expect(reciente.immediate).toHaveLength(0);
  });

  it('se rinde tras el tope de intentos, avisa, y deja el stop puesto', () => {
    const vencido = { ...planGuardado, venceEn: AHORA - 1 };
    const agotado = conPosicion({
      op: {
        plan: vencido,
        intento: 0,
        enviadaEn: 0,
        cierre: { motivo: 'TIEMPO', intentos: 12, ultimoEn: 0 },
      },
    });

    expect(agotado.immediate).toHaveLength(0);
    // La red no se quita: es justo cuando más falta hace.
    expect(agotado.orders.map((o) => o.levelKind)).toEqual(['STOP_LOSS']);
    expect(agotado.avisos?.[0].severidad).toBe('CRITICAL');
  });

  it('cierra cuando el precio se va del montaje que se operó', () => {
    // Banda de 2 de ancho e invalidación de 0,5: por debajo de 98,5 se cierra.
    const lejos = conPosicion(
      { op: { plan: planGuardado, intento: 0, enviadaEn: 0 } },
      { ticker: { ...contexto().ticker, mark: '98', last: '98', bid: '97.99', ask: '98.01' } },
    );

    expect(lejos.immediate).toHaveLength(1);
    expect(lejos.note).toContain('se fue del montaje');
  });

  it('una posición sin plan se cierra con reintentos, no a lo loco', () => {
    const huerfana = conPosicion({});

    expect(huerfana.immediate).toHaveLength(1);
    expect(huerfana.avisos?.[0].tipo).toBe('POSICION_HUERFANA');
    const cierre = huerfana.scratchPatch?.['cierreHuerfana'] as { intentos: number };
    expect(cierre.intentos).toBe(1);
  });
});
