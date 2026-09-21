import { BucketObjetivo, BucketStop, D, MotivoTrader } from '@crypton/shared';
import {
  ATR_POR_BUCKET,
  BUCKETS_OBJETIVO,
  BUCKETS_STOP,
  celdaDe,
  espacioTrader,
} from './esqueletos';
import { TICKER_TRADER, entradaDePrueba, historialDePrueba, senalDePrueba } from './testing-trader';

describe('espacioTrader — la matriz 3 × 3 (spec 068)', () => {
  it('ofrece exactamente una celda por par de enumeraciones', () => {
    const r = espacioTrader(entradaDePrueba());

    expect(r.esqueletos).toHaveLength(9);
    for (const s of BUCKETS_STOP) {
      for (const o of BUCKETS_OBJETIVO) {
        expect(celdaDe(r, s, o)).toBeDefined();
      }
    }
  });

  it('sin borde tocado no hay matriz: no hay nada que decidir', () => {
    const r = espacioTrader(entradaDePrueba({ senal: senalDePrueba({ lado: null }) }));

    expect(r.lado).toBeNull();
    expect(r.esqueletos).toHaveLength(0);
    expect(r.huella).toContain('|-|');
  });

  it('el tope de la entrada es UNO para las nueve celdas', () => {
    // Si cada stop tuviera su tope, el ceñido podría ejecutarse con el del
    // holgado y perder más de lo calculado.
    const r = espacioTrader(entradaDePrueba());
    const topes = new Set(r.esqueletos.filter((x) => x.viable).map((x) => x.entradaTope));

    expect(topes.size).toBe(1);
  });

  it('el stop se aleja con el bucket, y el ceñido es el más cercano', () => {
    const r = espacioTrader(entradaDePrueba());
    const precio = (s: BucketStop) => Number(celdaDe(r, s, BucketObjetivo.EN_LA_MEDIA)!.precioStop);

    // Es un largo: el stop va por debajo, así que más lejos es más pequeño.
    expect(precio(BucketStop.CENIDO)).toBeGreaterThan(precio(BucketStop.MEDIDO));
    expect(precio(BucketStop.MEDIDO)).toBeGreaterThan(precio(BucketStop.HOLGADO));
    expect(ATR_POR_BUCKET[BucketStop.MEDIDO]).toBe(2);
  });

  it('el objetivo se aleja con el bucket, y ninguno cruza al otro lado', () => {
    const r = espacioTrader(entradaDePrueba());
    const precio = (o: BucketObjetivo) => Number(celdaDe(r, BucketStop.MEDIDO, o)!.precioObjetivo);
    const tope = Number(celdaDe(r, BucketStop.MEDIDO, BucketObjetivo.EN_LA_MEDIA)!.entradaTope);

    expect(precio(BucketObjetivo.CORTO)).toBeGreaterThan(tope);
    expect(precio(BucketObjetivo.CORTO)).toBeLessThan(precio(BucketObjetivo.EN_LA_MEDIA));
    expect(precio(BucketObjetivo.EN_LA_MEDIA)).toBeLessThan(precio(BucketObjetivo.LARGO));
  });

  /**
   * La garantía central del fichero. Si una celda dice `viable`, el resto del
   * sistema puede ejecutarla sin volver a mirar: quien elige no puede elegir mal
   * porque lo que no se puede hacer no está en la lista.
   */
  it('una celda viable trae TODOS sus números y la liquidación detrás del stop', () => {
    const r = espacioTrader(entradaDePrueba());
    const viables = r.esqueletos.filter((x) => x.viable);

    expect(viables.length).toBeGreaterThan(0);
    for (const c of viables) {
      expect(c.motivo).toBeNull();
      expect(c.cantidad).not.toBeNull();
      expect(c.nocional).not.toBeNull();
      expect(c.apalancamiento).not.toBeNull();
      expect(c.perdidaAlStop).not.toBeNull();
      expect(D(c.cantidad!).gt(0)).toBe(true);
      expect(c.apalancamiento!).toBeGreaterThanOrEqual(1);
      // La liquidación, estrictamente detrás del stop. Es un largo.
      if (c.liquidacion !== null) {
        expect(Number(c.liquidacion)).toBeLessThan(Number(c.precioStop));
      }
    }
  });

  it('una celda no viable no trae ningún número, solo su motivo', () => {
    const r = espacioTrader(entradaDePrueba({}, { maxStopPct: '0.01' }));
    const noViables = r.esqueletos.filter((x) => !x.viable);

    expect(noViables.length).toBeGreaterThan(0);
    for (const c of noViables) {
      expect(c.motivo).not.toBeNull();
      expect(c.cantidad).toBeNull();
      expect(c.nocional).toBeNull();
      expect(c.apalancamiento).toBeNull();
      expect(c.liquidacion).toBeNull();
    }
  });

  describe('cada motivo de rechazo se alcanza de verdad', () => {
    const motivoDe = (extra: Record<string, unknown>, o = {}): Set<string> =>
      new Set(
        espacioTrader(entradaDePrueba(o, extra))
          .esqueletos.filter((x) => x.motivo !== null)
          .map((x) => x.motivo as string),
      );

    it('STOP_ANCHO cuando el stop pasa del tope del dueño', () => {
      expect(motivoDe({ maxStopPct: '0.01' })).toContain(MotivoTrader.STOP_ANCHO);
    });

    it('COSTE cuando comisiones y deslizamiento se comen el riesgo', () => {
      expect(motivoDe({ maxCostPerTradeR: '0.001', slippageBps: '50' })).toContain(
        MotivoTrader.COSTE,
      );
    });

    it('OBJETIVO_CORTO cuando el objetivo no paga el viaje', () => {
      expect(motivoDe({ minTargetCostMultiple: 5000 })).toContain(MotivoTrader.OBJETIVO_CORTO);
    });

    it('RR cuando el objetivo no paga lo arriesgado', () => {
      expect(motivoDe({ minRewardRisk: '50', minTargetCostMultiple: 3 })).toContain(
        MotivoTrader.RR,
      );
    });

    it('TOPE_DIARIO cuando lo perdido hoy no deja sitio', () => {
      const sinSitio = motivoDe({}, { historial: historialDePrueba({ realizadoHoy: '-1000' }) });
      expect(sinSitio).toContain(MotivoTrader.TOPE_DIARIO);
    });

    it('SIN_MARGEN sin saldo libre', () => {
      expect(motivoDe({}, { saldoLibre: '0' })).toContain(MotivoTrader.SIN_MARGEN);
    });

    it('MINIMO cuando el capital no llega al mínimo del venue', () => {
      expect(motivoDe({ totalInvestment: '1', riskPerTradePct: '0.1' })).toContain(
        MotivoTrader.MINIMO,
      );
    });
  });

  it('proyecta la media con la deriva: no apunta a donde la media ya no estará', () => {
    const quieta = espacioTrader(entradaDePrueba());
    const subiendo = espacioTrader(
      entradaDePrueba({ senal: senalDePrueba({ derivaMediaAtr: 0.06 }) }),
    );

    const objetivo = (r: ReturnType<typeof espacioTrader>) =>
      Number(celdaDe(r, BucketStop.MEDIDO, BucketObjetivo.EN_LA_MEDIA)!.precioObjetivo);

    // La media sube, así que el objetivo de un largo queda más lejos.
    expect(objetivo(subiendo)).toBeGreaterThan(objetivo(quieta));
  });

  it('la huella cambia si cambian las celdas viables, y no si no cambian', () => {
    const a = espacioTrader(entradaDePrueba());
    const b = espacioTrader(entradaDePrueba());
    const c = espacioTrader(entradaDePrueba({}, { maxStopPct: '0.01' }));

    expect(a.huella).toBe(b.huella);
    expect(a.huella).not.toBe(c.huella);
  });

  it('un corto es simétrico: stop por encima y objetivo por debajo', () => {
    // El ticker tiene que estar en el borde de arriba: un corto con el precio
    // abajo no es un corto, es un objetivo del lado equivocado.
    const r = espacioTrader(
      entradaDePrueba({
        senal: senalDePrueba({ lado: 'SHORT', porcentajeB: 0.96 }),
        ticker: { ...TICKER_TRADER, last: '103.1', bid: '103.09', ask: '103.11', mark: '103.1' },
        extremo: 103.18,
      }),
    );
    const c = celdaDe(r, BucketStop.MEDIDO, BucketObjetivo.EN_LA_MEDIA)!;

    expect(r.lado).toBe('SHORT');
    expect(Number(c.precioStop)).toBeGreaterThan(Number(c.entradaTope));
    expect(Number(c.precioObjetivo)).toBeLessThan(Number(c.entradaTope));
    if (c.viable && c.liquidacion !== null) {
      expect(Number(c.liquidacion)).toBeGreaterThan(Number(c.precioStop));
    }
  });
});
