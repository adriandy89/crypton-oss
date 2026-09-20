import {
  CalidadCanal,
  Confirmacion,
  EstadoSetup,
  Evidencia,
  RegimenMercado,
  TipoCanal,
  Venue,
  type BotConfig,
  type Candle,
  type Ticker,
} from '@crypton/shared';
import { aiChannel } from '../strategies/ai-channel';
import { makeMarket } from '../testing';
import {
  CAPACIDAD_CACHE,
  aplicarCalidadMinima,
  analizarMercado,
  seriesNecesarias,
  vaciarCacheAnalisis,
  type EntradaAnalisis,
} from './analisis';
import type { CanalEvaluado } from './canales';
import { leerConfig } from './config';
import { PASO_TASAS } from './tasas-base';
import { nivelesDecimalesEn } from './herramienta';
import {
  CINCO_MIN,
  HORA,
  QUINCE_MIN,
  canalDePrueba,
  escenarioCanal,
  historiaConRango,
  historialDePrueba,
  mejorTiempo,
  senoidal,
} from './testing-canal';

const MARKET = makeMarket({
  tickSize: '0.01',
  stepSize: '0.001',
  priceDecimals: 2,
  qtyDecimals: 3,
  maxLeverage: 50,
});

const ticker = (precio: number, t: number): Ticker => ({
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  last: precio.toFixed(2),
  bid: precio.toFixed(2),
  ask: (precio + 0.01).toFixed(2),
  mark: precio.toFixed(2),
  ts: t,
});

const config = (cfg: Record<string, unknown> = {}) =>
  leerConfig({ totalInvestment: '1000', ...cfg } as BotConfig, Venue.HYPERLIQUID);

function entrada(
  esc: ReturnType<typeof escenarioCanal>,
  o: Partial<EntradaAnalisis> = {},
): EntradaAnalisis {
  return {
    cfg: config(),
    market: MARKET,
    ticker: ticker(esc.soporte + 0.25, esc.fin),
    series: esc.series,
    fundingBps: 0,
    saldoLibre: '1000',
    historial: historialDePrueba(),
    niveles: [],
    maxApalancamientoUsuario: null,
    ahora: esc.fin + 4000,
    ...o,
  };
}

beforeEach(() => vaciarCacheAnalisis());

describe('analizarMercado: la cadena entera', () => {
  const esc = escenarioCanal({ toque: true });

  it('rango, canal y un rebote largo listo, con sus números y sus tasas', () => {
    const r = analizarMercado(entrada(esc));
    const { salida } = r;
    expect(r.regimen.regimen).toBe(RegimenMercado.RANGO);
    expect(r.motivosCanal).toEqual([]);
    expect(r.invalidado).toBe(false);
    expect(salida.canal).toMatchObject({ tipo: TipoCanal.HORIZONTAL, calidad: CalidadCanal.A });
    expect(Number(salida.canal?.soporte)).toBeCloseTo(esc.soporte, 6);
    expect(Number(salida.canal?.resistencia)).toBeCloseTo(esc.resistencia, 6);
    expect(salida.mercado).toMatchObject({
      regimen: RegimenMercado.RANGO,
      precio: (esc.soporte + 0.25).toFixed(2),
      fundingBps: 0,
      frescas: true,
    });
    expect(Number(salida.mercado.atr15m)).toBeGreaterThan(0);
    expect(salida.barT).toBe(esc.fin - CINCO_MIN);

    expect(salida.candidatos).toHaveLength(1);
    const c = salida.candidatos[0];
    expect(c).toMatchObject({
      id: `REB-L-${salida.canal?.id}`,
      lado: 'LONG',
      estado: EstadoSetup.LISTO,
      descartes: [],
    });
    expect(c.confirmaciones).toEqual(
      expect.arrayContaining([Confirmacion.MECHA, Confirmacion.VOLUMEN]),
    );
    expect(Number(c.extremo)).toBeCloseTo(esc.soporte - 0.03, 4);
    expect(c.stops.some((o) => o.viable)).toBe(true);
    // Las tasas del histórico, con su evidencia.
    expect(c.tasas).toMatchObject({ evidencia: Evidencia.INSUFICIENTE });
    expect(c.tasas?.n).toBeGreaterThan(5);
    expect(salida.huella).toBe(`${esc.fin - CINCO_MIN}|${salida.canal?.id}|${c.id}:LISTO`);
  });

  it('sin toque no hay candidatos, pero el canal se ve', () => {
    const r = analizarMercado(
      entrada(escenarioCanal(), { ticker: ticker(escenarioCanal().centro, 0) }),
    );
    expect(r.salida.canal).not.toBeNull();
    expect(r.salida.candidatos).toEqual([]);
  });

  it('un bot solo corto no ve el rebote largo', () => {
    const r = analizarMercado(entrada(esc, { cfg: config({ direction: 'SHORT' }) }));
    expect(r.salida.canal).not.toBeNull();
    expect(r.salida.candidatos).toEqual([]);
  });

  it('con series viejas, no son frescas', () => {
    const r = analizarMercado(entrada(esc, { ahora: esc.fin + 20 * 60_000 }));
    expect(r.salida.mercado.frescas).toBe(false);
    // Dentro de la gracia, sí.
    expect(analizarMercado(entrada(esc, { ahora: esc.fin + 60_000 })).salida.mercado.frescas).toBe(
      true,
    );
    // Y sin una serie necesaria, no.
    const sin15 = { '5m': esc.series['5m'], '1h': esc.series['1h'] };
    expect(analizarMercado(entrada(esc, { series: sin15 })).salida.mercado.frescas).toBe(false);
  });

  it('sin historia suficiente, régimen indefinido y ningún canal', () => {
    const corto = {
      '5m': esc.series['5m'].slice(-10),
      '15m': esc.series['15m'].slice(-20),
      '1h': [],
    };
    const r = analizarMercado(entrada(esc, { series: corto }));
    expect(r.regimen.regimen).toBe(RegimenMercado.INDEFINIDO);
    expect(r.salida.canal).toBeNull();
    expect(r.motivosCanal).toEqual(['DATOS']);
    expect(r.salida.mercado.adx1h).toBe(0);
  });
});

describe('analizarMercado: la caché', () => {
  const esc = escenarioCanal({ toque: true });

  it('las mismas velas no se vuelven a analizar; la herramienta, sí', () => {
    const a = analizarMercado(entrada(esc));
    const b = analizarMercado(entrada(esc, { ticker: ticker(esc.soporte + 0.3, esc.fin) }));
    expect(b.regimen).toBe(a.regimen);
    expect(b.salida.candidatos[0].entradaReferencia).not.toBe(
      a.salida.candidatos[0].entradaReferencia,
    );
    const c = analizarMercado(
      entrada(esc, { historial: historialDePrueba({ realizadoHoy: '-60' }) }),
    );
    expect(c.regimen).toBe(a.regimen);
    expect(c.salida.candidatos[0].stops.every((o) => !o.viable)).toBe(true);
  });

  it('una vela nueva, o una configuración que cambia el análisis, sí', () => {
    const a = analizarMercado(entrada(esc));
    const ultima = esc.series['5m'][esc.series['5m'].length - 1];
    const nueva: Candle = { ...ultima, t: ultima.t + CINCO_MIN };
    const conNueva = { ...esc.series, '5m': [...esc.series['5m'].slice(1), nueva] };
    const b = analizarMercado(
      entrada(esc, { series: conNueva, ahora: esc.fin + CINCO_MIN + 4000 }),
    );
    expect(b.regimen).not.toBe(a.regimen);
    const c = analizarMercado(entrada(esc, { cfg: config({ channelWindowBars: 120 }) }));
    expect(c.regimen).not.toBe(a.regimen);
    // Lo que solo mira la herramienta no cambia la clave.
    const d = analizarMercado(entrada(esc, { cfg: config({ riskPerTradePct: '0.5' }) }));
    expect(d.regimen).toBe(a.regimen);
  });

  it(`guarda como mucho ${CAPACIDAD_CACHE} análisis: el más antiguo sale primero`, () => {
    const primero = analizarMercado(entrada(esc));
    for (let i = 0; i < CAPACIDAD_CACHE; i++) {
      analizarMercado(entrada(esc, { market: { ...MARKET, symbol: `S${i}` } }));
    }
    expect(analizarMercado(entrada(esc)).regimen).not.toBe(primero.regimen);
  });

  it('usar un análisis lo mantiene en la caché', () => {
    const primero = analizarMercado(entrada(esc));
    for (let i = 0; i < CAPACIDAD_CACHE; i++) {
      analizarMercado(entrada(esc, { market: { ...MARKET, symbol: `S${i}` } }));
      if (i === CAPACIDAD_CACHE - 2) analizarMercado(entrada(esc));
    }
    expect(analizarMercado(entrada(esc)).regimen).toBe(primero.regimen);
  });
});

describe('analizarMercado: estructura de 5 min', () => {
  it('necesita 5 min y 1 h; la de 15 no', () => {
    expect(seriesNecesarias('5m')).toEqual(['5m', '1h']);
    expect(seriesNecesarias('15m')).toEqual(['5m', '15m', '1h']);
  });

  it('el canal se busca en 5 min y su pendiente se da por vela de 15', () => {
    const h1 = historiaConRango(5 * 7919, 300, 180);
    const fin = h1[h1.length - 1].t + HORA;
    const centro = Number(h1[h1.length - 1].c);
    // Sube 0,02 por vela de 5 min: 0,06 por vela de 15.
    const v5 = senoidal({
      n: 600,
      periodo: 24,
      amplitud: 1.5,
      centro,
      deriva: 0.02,
      paso: CINCO_MIN,
      desde: fin - 600 * CINCO_MIN,
    });
    const ultimo = Number(v5[v5.length - 1].c);
    const r = analizarMercado({
      cfg: config({ structureInterval: '5m', channelWindowBars: 144 }),
      market: MARKET,
      ticker: ticker(ultimo, fin),
      series: { '5m': v5, '1h': h1 },
      fundingBps: null,
      saldoLibre: '1000',
      historial: historialDePrueba(),
      niveles: [],
      maxApalancamientoUsuario: null,
      ahora: fin + 4000,
    });
    const canal = r.salida.canal;
    expect(canal?.tipo).toBe(TipoCanal.INCLINADO);
    expect(canal?.pendientePorVela).toBeCloseTo(0.06, 9);
    expect(canal?.refT).toBe(fin - CINCO_MIN);
    expect(r.salida.mercado.frescas).toBe(true);
    // Una vela de 15 min más tarde, los niveles han subido 0,06.
    if (!canal) throw new Error('sin canal');
    const luego = nivelesDecimalesEn(canal, canal.refT + QUINCE_MIN);
    expect(luego.soporte.minus(canal.soporte).toNumber()).toBeCloseTo(0.06, 9);
    // Y el ATR de los stops sigue siendo el de 15 min, construido con las de 5.
    expect(Number(r.salida.mercado.atr15m)).toBeGreaterThan(Number(r.salida.mercado.atr5m));
  });
});

describe('aplicarCalidadMinima', () => {
  const evaluado = (calidad: CalidadCanal): CanalEvaluado => ({
    canal: canalDePrueba({ calidad }),
    motivos: [],
    invalidado: false,
    falsoQuiebre: null,
  });

  it('por debajo del mínimo, no hay canal', () => {
    expect(aplicarCalidadMinima(evaluado(CalidadCanal.B), CalidadCanal.A)).toEqual({
      canal: null,
      motivos: ['CALIDAD'],
      invalidado: false,
      falsoQuiebre: null,
    });
    expect(aplicarCalidadMinima(evaluado(CalidadCanal.C), CalidadCanal.B).canal).toBeNull();
  });

  it('en el mínimo o por encima, se queda', () => {
    const b = evaluado(CalidadCanal.B);
    expect(aplicarCalidadMinima(b, CalidadCanal.B)).toBe(b);
    expect(aplicarCalidadMinima(evaluado(CalidadCanal.A), CalidadCanal.C).canal).not.toBeNull();
    const sinCanal: CanalEvaluado = {
      canal: null,
      motivos: ['TOQUES'],
      invalidado: false,
      falsoQuiebre: null,
    };
    expect(aplicarCalidadMinima(sinCanal, CalidadCanal.A)).toBe(sinCanal);
  });
});

describe('analizarMercado: rendimiento', () => {
  // Los 20 ms de CA-3 se miden sobre `dist`, donde este análisis con un setup
  // (y por tanto con sus tasas base) tarda unos 4 ms. Aquí, bajo jest y con
  // `pnpm test` corriendo todos los paquetes a la vez, el mejor de diez llegó a
  // 21,7 ms: el umbral de este test caza un algoritmo que se dispara —uno
  // cuadrático sobre mil velas son segundos—, no mide el tiempo real.
  it('con mil velas de 15 min, un análisis nuevo no se dispara y uno guardado casi no cuesta', () => {
    const esc = escenarioCanal({ velas15: 1000 });
    const e = entrada(esc, { ticker: ticker(esc.centro, esc.fin) });
    const nuevo = mejorTiempo(() => {
      vaciarCacheAnalisis();
      analizarMercado(e);
    }, 10);
    expect(nuevo).toBeLessThan(60);
    analizarMercado(e);
    expect(mejorTiempo(() => analizarMercado(e), 50)).toBeLessThan(5);
  });
});

/**
 * La serie de estructura pasó de mil velas a `ventanaCanal + 8 × 70` (spec 065):
 * mil pesaban 37 en Hyperliquid contra un depósito que valía 34, así que una
 * lectura legítima exigía el depósito lleno y lo dejaba en deuda.
 *
 * Lo que este bloque fija es que el recorte NO cambia el análisis, y que lo que
 * ata el número es el tamaño de muestra de las tasas base.
 */
describe('la serie corta de estructura no cambia el análisis (spec 065)', () => {
  const esc = escenarioCanal({ toque: true, velas15: 1000 });

  /** Las velas que pide la estrategia, LEÍDAS de ella y no copiadas aquí. */
  const barras15 = (cfg: Record<string, unknown> = {}): number => {
    const serie = aiChannel
      .series?.({ totalInvestment: '1000', ...cfg } as BotConfig)
      ?.find((s) => s.interval === '15m');
    if (!serie) throw new Error('la estrategia no declara serie de 15m');
    return serie.bars;
  };

  it('régimen, canal y candidatos salen iguales con la serie larga y con la corta', () => {
    const largo = analizarMercado(entrada(esc));
    vaciarCacheAnalisis();
    const corto = analizarMercado(
      entrada(esc, { series: { ...esc.series, '15m': esc.series['15m'].slice(-barras15()) } }),
    );

    expect(corto.regimen).toEqual(largo.regimen);
    expect(corto.motivosCanal).toEqual(largo.motivosCanal);
    expect(corto.invalidado).toBe(largo.invalidado);
    expect(corto.salida.mercado).toEqual(largo.salida.mercado);

    // El canal, campo a campo. Los tres diagnósticos en coma flotante se
    // comparan con tolerancia: el orden de acumulación de `atrSerie` depende de
    // dónde empieza la serie y mueve el dígito quince. Ninguno de ellos acaba
    // en una orden — los niveles pasan por `nivelTexto`, y esos sí son
    // idénticos byte a byte.
    const {
      anchuraAtr: aC,
      mediaVidaVelas: mC,
      contencion: cC,
      ...canalCorto
    } = corto.salida.canal!;
    const {
      anchuraAtr: aL,
      mediaVidaVelas: mL,
      contencion: cL,
      ...canalLargo
    } = largo.salida.canal!;
    expect(canalCorto).toEqual(canalLargo);
    const cercano = (x: number | null, y: number | null) => {
      if (x === null || y === null) expect(x).toBe(y);
      else expect(x).toBeCloseTo(y, 9);
    };
    cercano(aC, aL);
    cercano(mC, mL);
    cercano(cC, cL);

    // Los candidatos, todo menos las tasas: esas sí cambian, es el precio del
    // recorte y por eso se exige abajo que sigan siendo MODERADAS.
    expect(corto.salida.candidatos.map(({ tasas: _t, ...resto }) => resto)).toEqual(
      largo.salida.candidatos.map(({ tasas: _t, ...resto }) => resto),
    );
  });

  it('y la evidencia sigue siendo MODERADA: la puerta de la esperanza negativa no se apaga', () => {
    vaciarCacheAnalisis();
    const corto = analizarMercado(
      entrada(esc, { series: { ...esc.series, '15m': esc.series['15m'].slice(-barras15()) } }),
    );
    const tasas = corto.salida.candidatos[0]?.tasas;
    expect(tasas?.n).toBeGreaterThan(60);
    expect(tasas?.evidencia).toBe(Evidencia.MODERADA);
  });

  it('para toda la banda de `channelWindowBars`, las muestras pasan de 60', () => {
    // El motivo de que la ventana sea una fórmula y no un número plano: con 656
    // fijo, quien pusiera la ventana en su máximo se quedaría en 57 muestras y
    // perdería la banda MODERADA sin enterarse.
    for (const ventana of [48, 96, 150, 200]) {
      const techo = Math.floor((barras15({ channelWindowBars: ventana }) - ventana) / PASO_TASAS);
      expect(techo).toBeGreaterThan(60);
    }
  });
});
