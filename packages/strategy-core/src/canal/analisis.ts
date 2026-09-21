/**
 * El análisis completo de un tick (spec 058): series → régimen → canal →
 * setups → tasas base → herramienta.
 *
 * Todo depende de las velas CERRADAS salvo la herramienta, que mira además el
 * libro, el saldo y lo operado hoy. Por eso la parte de las velas se guarda en
 * una caché LRU pequeña: el motor pregunta cada pocos segundos y las velas
 * cambian cada cinco minutos. La herramienta se calcula siempre de nuevo.
 */
import {
  candleSpanMs,
  type Candle,
  type CandleInterval,
  type ContextoMercado,
  type HistorialOperaciones,
  type MarketSpec,
  type NivelApalancamiento,
  type SalidaHerramienta,
  type ResumenTasas,
  type Ticker,
} from '@crypton/shared';
import { calidadSuficiente, detectarCanal, nivelTexto, type CanalEvaluado } from './canales';
import type { ConfigCanal } from './config';
import { costeIdaVuelta, spreadBps } from './costes';
import { atrSerie } from './estadistica';
import { herramientaCanal } from './herramienta';
import { serieNumerica, type SerieNumerica } from './numeros';
import { regimen, type Regimen } from './regimen';
import { detectarSetups, type CandidatoBase } from './setups';
import { swingsConfirmados } from './swings';
import { claveTasas, tasasBase } from './tasas-base';
import { agregarVelas, serieFresca } from './velas';

const QUINCE_MIN = 900_000;
const CINCO_MIN = 300_000;
const PERIODO_ATR = 14;
const FACTOR_GIROS = 1.25;
/** Entradas de la caché: de sobra para los bots de un worker. */
export const CAPACIDAD_CACHE = 32;
/** Tolerancia por defecto para que el venue publique la vela recién cerrada. */
export const GRACIA_SERIES_MS = 90_000;

export interface EntradaAnalisis {
  cfg: ConfigCanal;
  market: MarketSpec;
  ticker: Ticker;
  series: Partial<Record<CandleInterval, readonly Candle[]>>;
  /** Funding por periodo en bps, con signo; null si el venue no lo da. */
  fundingBps: number | null;
  saldoLibre: string;
  historial: HistorialOperaciones;
  niveles: readonly NivelApalancamiento[];
  maxApalancamientoUsuario: number | null;
  ahora: number;
  graciaMs?: number;
}

export interface ResultadoAnalisis {
  salida: SalidaHerramienta;
  regimen: Regimen;
  /** Por qué no hay canal, si no lo hay. */
  motivosCanal: string[];
  invalidado: boolean;
}

/** Lo que depende solo de las velas. */
interface Estructura {
  regimen: Regimen;
  evaluado: CanalEvaluado;
  candidatos: CandidatoBase[];
  tasas: ReadonlyMap<string, ResumenTasas>;
  atr5m: number;
  atr15m: number;
  atr1h: number;
  barT: number;
}

/** Las series que necesita cada estructura. */
export function seriesNecesarias(intervalo: ConfigCanal['intervaloEstructura']): CandleInterval[] {
  return intervalo === '5m' ? ['5m', '1h'] : ['5m', '15m', '1h'];
}

export function ladosDe(direccion: ConfigCanal['direccion']): ('LONG' | 'SHORT')[] {
  if (direccion === 'LONG') return ['LONG'];
  if (direccion === 'SHORT') return ['SHORT'];
  return ['LONG', 'SHORT'];
}

const ultimoFinito = (xs: ArrayLike<number>): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(xs[i])) return xs[i];
  return 0;
};

const redondear = (x: number | undefined, decimales = 2): number => {
  if (x === undefined || !Number.isFinite(x)) return 0;
  const f = 10 ** decimales;
  return Math.round(x * f) / f;
};

const huellaSerie = (iv: string, v: readonly Candle[] | undefined): string =>
  !v || v.length === 0
    ? `${iv}:0`
    : `${iv}:${v.length}:${v[0].t}:${v[v.length - 1].t}:${v[v.length - 1].c}`;

function claveEstructura(e: EntradaAnalisis): string {
  const c = e.cfg;
  return [
    e.market.venue,
    e.market.symbol,
    ...(['5m', '15m', '1h'] as const).map((iv) => huellaSerie(iv, e.series[iv])),
    c.intervaloEstructura,
    c.ventanaCanal,
    c.canales.join('+'),
    c.invalidacionAtr,
    c.calidadMinima,
    c.setups.join('+'),
    c.direccion,
    c.minConfirmaciones,
    c.inclinadoSoloAFavor,
    c.maxVelasOperacion,
    c.costes.makerBps,
    c.costes.takerBps,
    c.costes.deslizamientoBps,
  ].join('|');
}

const cache = new Map<string, Estructura>();

/** Para los tests: una caché compartida entre casos los haría depender del orden. */
export function vaciarCacheAnalisis(): void {
  cache.clear();
}

function recordar(clave: string, calcular: () => Estructura): Estructura {
  const guardada = cache.get(clave);
  if (guardada) {
    cache.delete(clave);
    cache.set(clave, guardada);
    return guardada;
  }
  const nueva = calcular();
  cache.set(clave, nueva);
  if (cache.size > CAPACIDAD_CACHE) {
    const primera = cache.keys().next();
    if (!primera.done) cache.delete(primera.value);
  }
  return nueva;
}

/** Un canal por debajo de la calidad pedida es, para el bot, que no hay canal. */
export function aplicarCalidadMinima(
  evaluado: CanalEvaluado,
  minima: ConfigCanal['calidadMinima'],
): CanalEvaluado {
  if (!evaluado.canal || calidadSuficiente(evaluado.canal.calidad, minima)) return evaluado;
  return { canal: null, motivos: ['CALIDAD'], invalidado: false, falsoQuiebre: null };
}

function calcularEstructura(e: EntradaAnalisis): Estructura {
  const { cfg } = e;
  const v5 = e.series['5m'] ?? [];
  const v1h = e.series['1h'] ?? [];
  const barT = v5.length > 0 ? v5[v5.length - 1].t : 0;
  // Con estructura de 5 min, el régimen y el ATR de los stops siguen siendo de
  // 15: se construyen con las velas de 5 ya cerradas.
  const v15 =
    cfg.intervaloEstructura === '5m'
      ? (agregarVelas(v5, '5m', '15m', barT + CINCO_MIN) ?? [])
      : (e.series['15m'] ?? []);
  const s5 = serieNumerica(v5);
  const s15 = serieNumerica(v15);
  const h1 = serieNumerica(v1h);
  const estructura: SerieNumerica = cfg.intervaloEstructura === '5m' ? s5 : s15;
  const spanEstructura = candleSpanMs(cfg.intervaloEstructura);

  const atr5 = atrSerie(s5.h, s5.l, s5.c, PERIODO_ATR);
  const atr15 = atrSerie(s15.h, s15.l, s15.c, PERIODO_ATR);
  const atr1h = atrSerie(h1.h, h1.l, h1.c, PERIODO_ATR);
  const atrE = cfg.intervaloEstructura === '5m' ? atr5 : atr15;
  const giros = swingsConfirmados(estructura, atrE, FACTOR_GIROS);
  const reg = regimen(h1, s15);

  const ultimaE = estructura.n - 1;
  const atrUltimo = ultimaE >= 0 ? atrE[ultimaE] : Number.NaN;
  let evaluado = detectarCanal(estructura, giros, atrUltimo, {
    ventana: cfg.ventanaCanal,
    costeIdaVuelta: ultimaE >= 0 ? costeIdaVuelta(estructura.c[ultimaE], cfg.costes, 0) : 0,
    tiposPermitidos: cfg.canales,
    invalidacionAtr: cfg.invalidacionAtr,
  });
  evaluado = aplicarCalidadMinima(evaluado, cfg.calidadMinima);
  if (evaluado.canal && spanEstructura !== QUINCE_MIN) {
    // Los niveles se desplazan por vela de 15 min (`nivelesEn`): la pendiente
    // de un canal de 5 min se pasa a esa unidad.
    evaluado = {
      ...evaluado,
      canal: {
        ...evaluado.canal,
        pendientePorVela: (evaluado.canal.pendientePorVela * QUINCE_MIN) / spanEstructura,
      },
    };
  }

  const lados = ladosDe(cfg.direccion);
  const candidatos = evaluado.canal
    ? detectarSetups(s5, estructura, evaluado.canal, evaluado.falsoQuiebre, giros, atrUltimo, {
        minConfirmaciones: cfg.minConfirmaciones,
        setups: cfg.setups,
        lados,
        inclinadoSoloAFavor: cfg.inclinadoSoloAFavor,
      })
    : [];

  // Las tasas cuestan: solo cuando hay algo que ofrecer.
  let tasas: ReadonlyMap<string, ResumenTasas> = new Map();
  if (candidatos.length > 0) {
    const porClave = tasasBase(estructura, atrE, giros, {
      ventana: cfg.ventanaCanal,
      tiposPermitidos: cfg.canales,
      invalidacionAtr: cfg.invalidacionAtr,
      calidadMinima: cfg.calidadMinima,
      costes: cfg.costes,
      maxVelas: Math.max(1, Math.round((cfg.maxVelasOperacion * QUINCE_MIN) / spanEstructura)),
      setups: cfg.setups,
      lados,
      inclinadoSoloAFavor: cfg.inclinadoSoloAFavor,
    });
    const porCandidato = new Map<string, ResumenTasas>();
    for (const c of candidatos) {
      const t = porClave.get(claveTasas(c.setup, c.lado));
      if (t) porCandidato.set(c.id, t);
    }
    tasas = porCandidato;
  }

  return {
    regimen: reg,
    evaluado,
    candidatos,
    tasas,
    atr5m: ultimoFinito(atr5),
    atr15m: ultimoFinito(atr15),
    atr1h: ultimoFinito(atr1h),
    barT,
  };
}

export function analizarMercado(e: EntradaAnalisis): ResultadoAnalisis {
  const est = recordar(claveEstructura(e), () => calcularEstructura(e));
  const gracia = e.graciaMs ?? GRACIA_SERIES_MS;
  const frescas = seriesNecesarias(e.cfg.intervaloEstructura).every((iv) =>
    serieFresca(e.series[iv], iv, e.ahora, gracia),
  );
  const m = est.regimen.medidas;
  const mercado: ContextoMercado = {
    regimen: est.regimen.regimen,
    sentido: est.regimen.sentido,
    adx1h: redondear(m?.adx),
    chop1h: redondear(m?.chop1h),
    chop15m: redondear(m?.chop15m),
    percentilEficiencia: redondear(m?.percentilEficiencia),
    percentilAncho: redondear(m?.percentilAncho),
    ratioAtr: redondear(m?.ratioAtr, 3),
    atr5m: nivelTexto(est.atr5m),
    atr15m: nivelTexto(est.atr15m),
    atr1h: nivelTexto(est.atr1h),
    precio: e.ticker.mark,
    spreadBps: redondear(spreadBps(Number(e.ticker.bid), Number(e.ticker.ask))),
    fundingBps: e.fundingBps,
    frescas,
  };
  const salida = herramientaCanal({
    cfg: e.cfg,
    market: e.market,
    ticker: e.ticker,
    saldoLibre: e.saldoLibre,
    historial: e.historial,
    niveles: e.niveles,
    maxApalancamientoUsuario: e.maxApalancamientoUsuario,
    mercado,
    canal: est.evaluado.canal,
    candidatos: est.candidatos,
    tasas: est.tasas,
    barT: est.barT,
    ahora: e.ahora,
  });
  return {
    salida,
    regimen: est.regimen,
    motivosCanal: est.evaluado.motivos,
    invalidado: est.evaluado.invalidado,
  };
}
