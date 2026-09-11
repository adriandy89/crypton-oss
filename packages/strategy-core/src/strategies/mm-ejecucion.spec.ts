import { Decimal } from 'decimal.js';
import {
  D,
  LevelKind,
  StrategyKind,
  type BotConfig,
  type CycleState,
  type MarketSpec,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import { getStrategy } from '../registry';
import { reconcile } from '../reconcile';
import { BASE_CONFIG, makeContext, makeMarket, makePosition } from '../testing';

/**
 * Que una cotizacion llegue a ejecutarse alguna vez (spec 035).
 *
 * El fichero nace de un incidente: un Market Maker V2 simulado paso 23 HORAS
 * sobre LIT/Lighter sin una sola ejecucion mientras el precio recorria un 15 %.
 * No era el simulador —casa al tocar, en cada actualizacion del libro, y es
 * optimista— ni la formula del diferencial. Era que el umbral que dispara una
 * recotizacion es MENOR que la distancia a la que se cotiza: el bot recentra sus
 * ordenes sobre el precio nuevo antes de que el precio alcance a las viejas.
 *
 * Y nadie lo vio venir porque los treinta y pico casos de market maker que ya
 * existen son todos de la misma forma: «llamo a plan() UNA vez y compruebo el
 * precio de las ordenes». Ninguno mueve el precio; ninguno pregunta si eso que
 * se coloca llega a ejecutarse.
 *
 * Aqui se pregunta. La magnitud que se mide NO es el umbral, sino cuanto puede
 * recorrer el precio antes de que la cotizacion se aparte: un test que solo
 * fijara `repriceThresholdBps >= distancia` seguiria en verde con el bot roto,
 * porque `refreshSeconds` recentra igual cada 30 s.
 */

/**
 * Mercado con tick de 1 bps.
 *
 * `TEST_MARKET` tiene `tickSize: '0.1'` a precio 100, o sea 10 bps por tick: el
 * redondeo se comeria justo los huecos que este fichero mide.
 */
const MERCADO_MM: MarketSpec = makeMarket({
  tickSize: '0.01',
  priceDecimals: 2,
  stepSize: '0.001',
  qtyDecimals: 3,
  minNotional: '1',
});

const BPS = D(10_000);
const TICK_MS = 15_000;

interface Paso {
  ts: number;
  mid: Decimal;
}

/**
 * Onda triangular, y no un paseo aleatorio con semilla.
 *
 * El paseo es determinista pero sigue siendo un argumento probabilistico
 * disfrazado: cuando el test falle, lo primero que se piensa es «sera que la
 * semilla no bajo lo suficiente». La onda no deja esa duda — por construccion el
 * precio visita TODA la banda, en los dos sentidos, muchas veces. Si un market
 * maker que cotiza dentro de la banda no ejecuta, la culpa es del recentrado.
 *
 * Calibrada al incidente: ATR(1 h) ~ 290 bps, asi que la onda recorre 290 bps de
 * bajada y 290 de subida por hora (semiperiodo 30 min). Tiene, por construccion,
 * la volatilidad del caso real.
 */
function vaiven(opts: {
  m0: string;
  horas: number;
  amplitudBps: number;
  semiperiodoMs: number;
}): Paso[] {
  const m0 = D(opts.m0);
  const pasos: Paso[] = [];
  const total = Math.floor((opts.horas * 3_600_000) / TICK_MS);
  for (let i = 0; i <= total; i++) {
    const ts = 1_000_000 + i * TICK_MS;
    const fase = (i * TICK_MS) % (2 * opts.semiperiodoMs);
    // Sube en la primera mitad del periodo y baja en la segunda.
    const avance =
      fase <= opts.semiperiodoMs
        ? D(fase).div(opts.semiperiodoMs)
        : D(2).minus(D(fase).div(opts.semiperiodoMs));
    const desvio = avance.minus('0.5').mul(2).mul(opts.amplitudBps);
    pasos.push({ ts, mid: m0.mul(D(1).plus(desvio.div(BPS))) });
  }
  return pasos;
}

/** Rampa monotona: el instrumento de los tests de propiedad. Cero aleatoriedad. */
function rampa(opts: { m0: string; pasos: number; pendienteBps: string }): Paso[] {
  const m0 = D(opts.m0);
  const pasos: Paso[] = [];
  for (let i = 0; i <= opts.pasos; i++) {
    pasos.push({
      ts: 1_000_000 + i * TICK_MS,
      mid: m0.mul(D(1).minus(D(opts.pendienteBps).mul(i).div(BPS))),
    });
  }
  return pasos;
}

interface Viva {
  orden: VenueOrder;
  midAlColocar: Decimal;
  /** Maxima deriva del mercado, en bps, soportada mientras SEGUIA en el libro. */
  derivaSoportadaBps: Decimal;
  /** Minima distancia en bps entre el mercado y su precio mientras estuvo viva. */
  huecoMinimoBps: Decimal;
  distanciaAlColocarBps: Decimal;
}

interface Recorrido {
  planes: number;
  recotizaciones: number;
  ejecuciones: { ts: number; side: string; price: string }[];
  /** LA magnitud: cuanto llego a moverse el mercado sin que la orden se apartara. */
  derivaMaximaSoportadaBps: Decimal;
  /** Lo cerca que llego a estar el mercado de una cotizacion viva. 0 = la toco. */
  huecoMinimoBps: Decimal;
  /** A que distancia se cotizo de verdad (la mediana de las colocaciones). */
  distanciaDeCotizacionBps: Decimal;
}

/** El ticker que ve el bot: bid/ask pegados al mid con media horquilla de 1 bps. */
function tickerDe(mid: Decimal): Ticker {
  const media = mid.mul(D(1).div(BPS));
  return {
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    last: mid.toFixed(4),
    bid: mid.minus(media).toFixed(4),
    ask: mid.plus(media).toFixed(4),
    mark: mid.toFixed(4),
    ts: 0,
  };
}

/**
 * Recorre un camino de precio planificando a la cadencia del motor.
 *
 * La regla de casado es la del simulador, copiada a proposito y no importada:
 * `dry-run.ts:707` casa una compra cuando `ask <= precio` y una venta cuando
 * `bid >= precio`, entera y al precio limite. Es una hipotesis del SIMULADOR, no
 * del dominio, asi que no cabe en `shared`; que las dos digan lo mismo lo ancla
 * un test en `packages/backtest`.
 */
function recorrer(opts: {
  kind: StrategyKind;
  config: BotConfig;
  camino: Paso[];
  market?: MarketSpec;
}): Recorrido {
  const market = opts.market ?? MERCADO_MM;
  const estrategia = getStrategy(opts.kind);
  const botId = '1a2b3c4d-0000-0000-0000-000000000000';

  let vivas: Viva[] = [];
  let scratch: Record<string, unknown> = { cycleSeq: 1 };
  let ciclo: Partial<CycleState> = { scratch };
  let qty = D(0);
  let entrada = D(0);

  const r: Recorrido = {
    planes: 0,
    recotizaciones: 0,
    ejecuciones: [],
    derivaMaximaSoportadaBps: D(0),
    huecoMinimoBps: D(Number.MAX_SAFE_INTEGER),
    distanciaDeCotizacionBps: D(0),
  };
  const distancias: Decimal[] = [];

  for (const paso of opts.camino) {
    const ticker = tickerDe(paso.mid);
    const bid = D(ticker.bid);
    const ask = D(ticker.ask);

    // 1. Lo que cada orden viva ha aguantado, ANTES de casar.
    for (const v of vivas) {
      const deriva = paso.mid.minus(v.midAlColocar).div(v.midAlColocar).mul(BPS).abs();
      if (deriva.gt(v.derivaSoportadaBps)) v.derivaSoportadaBps = deriva;
      const precio = D(v.orden.price);
      const hueco = v.orden.side === 'BUY' ? ask.minus(precio) : precio.minus(bid);
      const huecoBps = Decimal.max(D(0), hueco).div(paso.mid).mul(BPS);
      if (huecoBps.lt(v.huecoMinimoBps)) v.huecoMinimoBps = huecoBps;
    }

    // 2. Casar, con la regla del simulador.
    const quedan: Viva[] = [];
    for (const v of vivas) {
      const precio = D(v.orden.price);
      const tocada =
        v.orden.side === 'BUY' ? ask.gt(0) && ask.lte(precio) : bid.gt(0) && bid.gte(precio);
      if (!tocada) {
        quedan.push(v);
        continue;
      }
      r.ejecuciones.push({ ts: paso.ts, side: v.orden.side, price: v.orden.price });
      const q = D(v.orden.qty);
      const delta = v.orden.side === 'BUY' ? q : q.neg();
      const nueva = qty.plus(delta);
      // Precio medio solo cuando se agranda en el mismo sentido; con la posicion
      // dada la vuelta, la entrada es el precio de esta ejecucion.
      entrada = qty.isZero() || qty.s !== nueva.s ? precio : entrada;
      qty = nueva;
      ciclo = {
        ...ciclo,
        entriesFilled: (ciclo.entriesFilled ?? 0) + 1,
        lastEntryAt: paso.ts,
      };
      r.derivaMaximaSoportadaBps = Decimal.max(r.derivaMaximaSoportadaBps, v.derivaSoportadaBps);
      r.huecoMinimoBps = Decimal.min(r.huecoMinimoBps, v.huecoMinimoBps);
    }
    vivas = quedan;

    // 3. Planificar.
    const ctx = makeContext({
      strategy: opts.kind,
      config: opts.config,
      price: paso.mid.toFixed(4),
      market,
      ticker,
      now: paso.ts,
      openOrders: vivas.map((v) => v.orden),
      position: qty.isZero() ? null : makePosition(qty.toFixed(6), entrada.toFixed(4)),
      cycle: { ...ciclo, scratch },
    });
    const plan = estrategia.plan(ctx);
    r.planes++;
    if (plan.scratchPatch && 'quotedMid' in plan.scratchPatch) r.recotizaciones++;
    if (plan.scratchPatch) scratch = { ...scratch, ...plan.scratchPatch };

    // 4. Reconciliar contra lo que hay puesto, con el reconciliador de verdad.
    const rec = reconcile({
      botId,
      cycleSeq: 1,
      desired: plan.orders,
      actual: vivas.map((v) => v.orden),
      market,
      encode: (c) => c,
      ownIds: new Set(vivas.map((v) => v.orden.clientOrderId ?? '')),
    });

    const cancelados = new Set([
      ...rec.toCancel.map((o) => o.clientOrderId),
      ...rec.toReplace.map((x) => x.existing.clientOrderId),
    ]);
    for (const v of vivas) {
      if (!cancelados.has(v.orden.clientOrderId)) continue;
      r.derivaMaximaSoportadaBps = Decimal.max(r.derivaMaximaSoportadaBps, v.derivaSoportadaBps);
      r.huecoMinimoBps = Decimal.min(r.huecoMinimoBps, v.huecoMinimoBps);
    }
    vivas = vivas.filter((v) => !cancelados.has(v.orden.clientOrderId));

    const nuevas = [...rec.toPlace, ...rec.toReplace.map((x) => x.desired)];
    for (const d of nuevas) {
      if (d.levelKind !== LevelKind.QUOTE_BID && d.levelKind !== LevelKind.QUOTE_ASK) continue;
      const dist = D(d.price).minus(paso.mid).div(paso.mid).mul(BPS).abs();
      distancias.push(dist);
      vivas.push({
        orden: {
          venue: 'HYPERLIQUID',
          symbol: 'BTC',
          clientOrderId: d.clientOrderId,
          venueOrderId: 'v-' + d.clientOrderId,
          side: d.side,
          type: d.type,
          price: d.price,
          qty: d.qty,
          filledQty: '0',
          avgPrice: null,
          status: 'OPEN',
          reduceOnly: d.reduceOnly,
          createdAt: paso.ts,
        },
        midAlColocar: paso.mid,
        derivaSoportadaBps: D(0),
        huecoMinimoBps: D(Number.MAX_SAFE_INTEGER),
        distanciaAlColocarBps: dist,
      });
    }
  }

  // Lo que quede vivo al final tambien cuenta lo que aguanto.
  for (const v of vivas) {
    r.derivaMaximaSoportadaBps = Decimal.max(r.derivaMaximaSoportadaBps, v.derivaSoportadaBps);
    r.huecoMinimoBps = Decimal.min(r.huecoMinimoBps, v.huecoMinimoBps);
  }
  if (distancias.length) {
    const ordenadas = [...distancias].sort((a, b) => a.comparedTo(b));
    r.distanciaDeCotizacionBps = ordenadas[Math.floor(ordenadas.length / 2)];
  }
  return r;
}

/** 24 h con el ATR del incidente: 290 bps de ida y 290 de vuelta cada hora. */
const CAMINO_DEL_INCIDENTE = () =>
  vaiven({ m0: '100', horas: 24, amplitudBps: 290, semiperiodoMs: 30 * 60_000 });

const comun = {
  ...BASE_CONFIG,
  direction: 'NEUTRAL' as const,
  orderSizePerSide: '100',
  maxBotPositionValue: '100000',
  leverage: 1,
};

describe('market maker · una cotizacion tiene que llegar a ejecutarse', () => {
  it('la V2, con los valores de fabrica y 24 h del mercado del incidente, ejecuta', () => {
    const config = {
      ...getStrategy(StrategyKind.MARKET_MAKER_V2).defaults(),
      ...comun,
    } as unknown as BotConfig;

    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER_V2,
      config,
      camino: CAMINO_DEL_INCIDENTE(),
    });

    // LA asercion: cuanto llego a moverse el mercado sin que la orden se
    // apartara, frente a lo lejos que estaba. Mientras la primera sea menor, la
    // cotizacion se retira antes de que el precio pueda alcanzarla y no hay
    // mercado que lo arregle. Se comprueba la RELACION y no un recuento de
    // ejecuciones porque el recuento depende del tamaño de orden y del tope de
    // inventario, y esto no.
    expect(r.derivaMaximaSoportadaBps.toNumber()).toBeGreaterThanOrEqual(
      r.distanciaDeCotizacionBps.toNumber(),
    );
    // Su corolario legible: el mercado llego a tocarla.
    expect(r.huecoMinimoBps.toNumber()).toBe(0);
    expect(r.ejecuciones.length).toBeGreaterThan(0);
  });

  it('la V1, con los valores de fabrica y el mismo mercado, ejecuta', () => {
    // De fabrica son 3 capas a 20/30/45 bps contra un umbral de deriva de 8, que
    // es `minAllowedDistanceBps` — o sea el SUELO de la distancia haciendo de
    // umbral. La capa 0 es la unica que puede ejecutar y es la que se mide.
    const config = {
      ...getStrategy(StrategyKind.MARKET_MAKER).defaults(),
      ...comun,
    } as unknown as BotConfig;

    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER,
      config,
      camino: CAMINO_DEL_INCIDENTE(),
    });

    expect(r.derivaMaximaSoportadaBps.toNumber()).toBeGreaterThanOrEqual(
      r.distanciaDeCotizacionBps.toNumber(),
    );
    expect(r.ejecuciones.length).toBeGreaterThan(0);
  });

  /**
   * Recotizar cuesta cuatro peticiones y Lighter da sesenta por minuto y por IP
   * (spec 031). Este test es la otra cara del arreglo: conservar la orden que el
   * mercado esta alcanzando tiene que REDUCIR el trafico, no aumentarlo.
   */
  it('no recotiza en mas de la mitad de los planes', () => {
    const config = {
      ...getStrategy(StrategyKind.MARKET_MAKER_V2).defaults(),
      ...comun,
    } as unknown as BotConfig;

    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER_V2,
      config,
      camino: CAMINO_DEL_INCIDENTE(),
    });

    expect(r.recotizaciones).toBeLessThan(r.planes / 2);
  });
});

describe('la propiedad, aislada de todo lo demas', () => {
  /** Sin volatilidad, sin refresco por tiempo y sin caducidad: solo el umbral. */
  const aislada = (extra: Record<string, unknown>) =>
    ({
      ...getStrategy(StrategyKind.MARKET_MAKER_V2).defaults(),
      ...comun,
      buyDistanceBps: '40',
      sellDistanceBps: '40',
      dynamicSpread: false,
      feeEstimateBps: '0',
      minProfitMarginBps: '0',
      safetyBufferBps: '0',
      orderBookMarginBps: '0',
      refreshSeconds: 600,
      orderMaxAgeSeconds: 0,
      fillCooldownSeconds: 0,
      ...extra,
    }) as unknown as BotConfig;

  /**
   * 60 pasos de 1 bps: el precio baja 60 bps en total, mas que los 40 a los que
   * se cotiza. Si la compra no ejecuta no es porque el precio no haya llegado
   * — es porque la cotizacion se aparto.
   */
  const RAMPA = () => rampa({ m0: '100', pasos: 60, pendienteBps: '1' });

  it('con el umbral por DEBAJO de la distancia, la cotizacion sigue alcanzandose', () => {
    // Antes del spec 035 este caso daba cero ejecuciones y el hueco se
    // estabilizaba en «distancia menos umbral» sin bajar nunca de ahi.
    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER_V2,
      config: aislada({ repriceThresholdBps: '10' }),
      camino: RAMPA(),
    });
    expect(r.ejecuciones.length).toBeGreaterThan(0);
    expect(r.huecoMinimoBps.toNumber()).toBe(0);
  });

  it('y con el umbral por ENCIMA tambien, que es el caso facil', () => {
    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER_V2,
      config: aislada({ repriceThresholdBps: '80' }),
      camino: RAMPA(),
    });
    expect(r.ejecuciones.length).toBeGreaterThan(0);
  });

  /**
   * El mecanismo que no es el umbral y que habria dejado el test anterior en
   * verde con el bot roto: `refreshSeconds` re-ancla al mid vivo cada dos ticks
   * del motor aunque la deriva sea de un solo punto basico.
   */
  it('un refresco por TIEMPO no mueve una cotizacion que el precio apenas ha rozado', () => {
    const config = aislada({ refreshSeconds: 15, repriceThresholdBps: '1000' });
    const r = recorrer({
      kind: StrategyKind.MARKET_MAKER_V2,
      config,
      // 40 pasos de 1 bps: cada tick dispara el refresco por tiempo.
      camino: rampa({ m0: '100', pasos: 60, pendienteBps: '1' }),
    });
    expect(r.ejecuciones.length).toBeGreaterThan(0);
  });

  it('el precio conservado es BYTE A BYTE el de la orden viva', () => {
    // Si no lo fuera, `reconcile` veria un precio distinto —aunque solo cambiara
    // el ultimo decimal—, la daria por `toReplace` y el arreglo no serviria de
    // nada sin que ningun test se enterase.
    const config = aislada({ repriceThresholdBps: '10' });
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const seq = 1;
    const primero = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config,
        price: '100',
        market: MERCADO_MM,
        now: 1_000_000,
        cycle: { scratch: { cycleSeq: seq } },
      }),
    );
    const bid = primero.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID);
    expect(bid).toBeDefined();

    const viva: VenueOrder = {
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      clientOrderId: bid!.clientOrderId,
      venueOrderId: 'v1',
      side: 'BUY',
      type: 'POST_ONLY',
      price: bid!.price,
      qty: bid!.qty,
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN',
      reduceOnly: false,
      createdAt: 1_000_000,
    };

    // El precio baja 20 bps: la compra se ha ACERCADO y no debe moverse.
    const segundo = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config,
        price: '99.8',
        market: MERCADO_MM,
        now: 1_000_000 + 30_000,
        openOrders: [viva],
        cycle: { scratch: { ...(primero.scratchPatch ?? {}), cycleSeq: seq } },
      }),
    );
    const bid2 = segundo.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID);
    expect(bid2?.price).toBe(viva.price);
  });
});

describe('validate avisa antes de crear el bot', () => {
  const market = MERCADO_MM;

  it('la V2 avisa cuando el reajuste queda muy por debajo de la distancia', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const config = {
      ...estrategia.defaults(),
      ...comun,
      repriceThresholdBps: '2',
    } as unknown as BotConfig;
    const r = estrategia.validate(config, market);
    expect(r.issues.map((i) => i.field)).toContain('repriceThresholdBps');
  });

  it('pero NO avisa con los valores de fabrica: un aviso que sale siempre se ignora siempre', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const config = { ...estrategia.defaults(), ...comun } as unknown as BotConfig;
    const r = estrategia.validate(config, market);
    expect(r.issues.map((i) => i.field)).not.toContain('repriceThresholdBps');
  });

  it('la V1 avisa de que su distancia minima hace tambien de umbral', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER);
    const config = {
      ...estrategia.defaults(),
      ...comun,
      minAllowedDistanceBps: '1',
    } as unknown as BotConfig;
    const r = estrategia.validate(config, market);
    expect(r.issues.map((i) => i.field)).toContain('minAllowedDistanceBps');
  });

  it('y tampoco avisa de fabrica', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER);
    const config = { ...estrategia.defaults(), ...comun } as unknown as BotConfig;
    const r = estrategia.validate(config, market);
    expect(r.issues.map((i) => i.field)).not.toContain('minAllowedDistanceBps');
  });
});

describe('la nota dice lo que el bot hace', () => {
  it('imprime el diferencial APLICADO, no el previo al techo', () => {
    // Antes decia 121 bps mientras las ordenes estaban a 100: el numero de la
    // pantalla no existia en el libro (spec 035).
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const config = {
      ...estrategia.defaults(),
      ...comun,
      buyDistanceBps: '500',
      sellDistanceBps: '500',
      maxDynamicSpreadBps: '50',
      dynamicSpread: false,
    } as unknown as BotConfig;

    const { note, orders } = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config,
        price: '100',
        market: MERCADO_MM,
      }),
    );

    expect(note).toContain('Diferencial 50.0/50.0 bps');
    // Y lo que dice es lo que hay: 50 bps por debajo de 100 son 99,50.
    const bid = orders.find((o) => o.levelKind === LevelKind.QUOTE_BID);
    expect(bid?.price).toBe('99.50');
  });
});

describe('conservar una cotizacion no puede anular las protecciones', () => {
  /**
   * La regresion que la primera version del arreglo introdujo.
   *
   * `precioEstable` deducia «el mercado se acerca» comparando la orden viva con
   * la que se cotizaria ahora. Esa comparacion tambien se cumple cuando el
   * precio deseado se ALEJA porque el diferencial se ha ensanchado, asi que una
   * cotizacion podia estrecharse pero nunca ensancharse: el ensanchado por
   * volatilidad, el regimen defensivo y una subida de distancia en caliente
   * quedaban descartados en silencio. En la V1, que no caduca por edad, para
   * siempre.
   */
  it('con el mercado quieto, ensanchar la distancia MUEVE la cotizacion', () => {
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const base = {
      ...estrategia.defaults(),
      ...comun,
      dynamicSpread: false,
      feeEstimateBps: '0',
      minProfitMarginBps: '0',
      safetyBufferBps: '0',
      orderBookMarginBps: '0',
      buyDistanceBps: '20',
      sellDistanceBps: '20',
      refreshSeconds: 15,
      orderMaxAgeSeconds: 0,
    } as unknown as BotConfig;

    const t0 = 1_000_000;
    const primero = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: base,
        price: '100',
        market: MERCADO_MM,
        now: t0,
        cycle: { scratch: { cycleSeq: 1 } },
      }),
    );
    const bid = primero.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID)!;
    expect(bid.price).toBe('99.80');

    const viva: VenueOrder = {
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      clientOrderId: bid.clientOrderId,
      venueOrderId: 'v1',
      side: 'BUY',
      type: 'POST_ONLY',
      price: bid.price,
      qty: bid.qty,
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN',
      reduceOnly: false,
      createdAt: t0,
    };

    // Mismo precio, distancia el doble: la cotizacion TIENE que alejarse.
    const segundo = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: { ...base, buyDistanceBps: '40', sellDistanceBps: '40' },
        price: '100',
        market: MERCADO_MM,
        now: t0 + 30_000,
        openOrders: [viva],
        cycle: { scratch: { ...(primero.scratchPatch ?? {}), cycleSeq: 1 } },
      }),
    );
    expect(segundo.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID)?.price).toBe('99.60');
  });

  it('pero si el mercado ha bajado hacia ella, se conserva aunque se ensanche', () => {
    // El caso que el arreglo tiene que seguir dando: aqui el mercado SI ha
    // venido a buscar la compra, y moverla ahora la aparta justo antes de cobrar.
    const estrategia = getStrategy(StrategyKind.MARKET_MAKER_V2);
    const base = {
      ...estrategia.defaults(),
      ...comun,
      dynamicSpread: false,
      feeEstimateBps: '0',
      minProfitMarginBps: '0',
      safetyBufferBps: '0',
      orderBookMarginBps: '0',
      buyDistanceBps: '20',
      sellDistanceBps: '20',
      refreshSeconds: 15,
      orderMaxAgeSeconds: 0,
    } as unknown as BotConfig;

    const t0 = 1_000_000;
    const primero = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: base,
        price: '100',
        market: MERCADO_MM,
        now: t0,
        cycle: { scratch: { cycleSeq: 1 } },
      }),
    );
    const bid = primero.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID)!;
    const viva: VenueOrder = {
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      clientOrderId: bid.clientOrderId,
      venueOrderId: 'v1',
      side: 'BUY',
      type: 'POST_ONLY',
      price: bid.price,
      qty: bid.qty,
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN',
      reduceOnly: false,
      createdAt: t0,
    };

    const segundo = estrategia.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: base,
        price: '99.85',
        market: MERCADO_MM,
        now: t0 + 30_000,
        openOrders: [viva],
        cycle: { scratch: { ...(primero.scratchPatch ?? {}), cycleSeq: 1 } },
      }),
    );
    expect(segundo.orders.find((o) => o.levelKind === LevelKind.QUOTE_BID)?.price).toBe(viva.price);
  });
});
