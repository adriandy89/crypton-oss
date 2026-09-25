/**
 * La herramienta del agente: cada número de cada operación posible en sus
 * pares (spec 074).
 *
 * Es lo que la IA —o el juez— tiene delante para elegir, y lo único de lo que
 * puede salir una propuesta. Cada opción de stop la calcula `opcionDeStop`, la
 * misma función que en el canal, así que llegan con sus tres garantías:
 * - la pérdida al stop, con comisiones y deslizamiento, no pasa del riesgo
 *   pedido ni de lo que queda del tope diario;
 * - la liquidación queda detrás del stop, a tres stops y a tres ATR como poco,
 *   en todas las bandas;
 * - lo que se pierde si el precio salta la liquidación —el margen aislado— no
 *   pasa del margen por operación.
 *
 * El tope diario cuenta las operaciones vivas como si ya hubieran saltado sus
 * stops: con dos abiertas, la tercera no puede llevar el día más allá del tope
 * aunque las tres salgan mal a la vez.
 */
import {
  D,
  Decimal,
  EsquemaObjetivo,
  Evidencia,
  LETRAS_OFERTA,
  MAX_OFERTA_AGENTE,
  MotivoRonda,
  type Candle,
  type CandidatoAgente,
  type ContextoParAgente,
  type FamiliaAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type MarketSpec,
  type NivelApalancamiento,
  type OpcionStop,
  type SalidaAgente,
  type SalidaAgentePar,
  type TasasBase,
  type Ticker,
  type UsoAgente,
  type Venue,
} from '@crypton/shared';
import { nivelTexto } from '../canal/canales';
import {
  TIPOS_STOP,
  opcionDeStop,
  perdidaHoyPct,
  preciosDeEntrada,
  stopDesdeExtremo,
  type ConfigDimensionado,
  type EntradaDimensionado,
} from '../canal/herramienta';
import { aDecimal, serieNumerica } from '../canal/numeros';
import { ultimaCerradaEsperada } from '../canal/velas';
import { px } from '../common';
import { detectarFamilias, type DeteccionAgente } from './familias';
import {
  MAX_DESLIZAMIENTO_R_AGENTE,
  MAX_PENDIENTES_AGENTE,
  MAX_SPREAD_ATR_AGENTE,
  dimensionadoDeAgente,
} from './limites';
import {
  MIN_VELAS_AGENTE,
  atrLiquidacion,
  contextoPar,
  indicadoresAgente,
  regimenAgente,
} from './mercado';
import { claveTasasAgente, tasasAgente } from './tasas';

const MINUTO = 60_000;

/** Un par con lo que la API ha leído de él para esta ronda. */
export interface ParAgente {
  simbolo: string;
  market: MarketSpec;
  ticker: Ticker | null;
  /** Velas del intervalo del agente. Las que aún no han cerrado se ignoran. */
  velas: readonly Candle[];
  /** Funding por periodo en bps, con signo; null si el venue no lo da. */
  fundingBps: number | null;
  niveles: readonly NivelApalancamiento[];
}

/** Lo operado por el agente, con el día contado en UTC. */
export interface HistorialAgente {
  /** 00:00 UTC del día en curso, en ms. */
  dia: number;
  /** Operaciones que han entrado hoy, abiertas o cerradas. */
  operacionesHoy: number;
  /** Resultado realizado hoy, con comisiones, en la quote. */
  realizadoHoy: string;
  /** Lo que perderían las operaciones vivas si saltaran sus stops ahora, en la quote. */
  riesgoAbierto: string;
  vivas: number;
  /** Propuestas esperando a una persona. */
  pendientes: number;
  /** Pérdidas seguidas hasta la última operación cerrada, sin cortar por días. */
  rachaPerdidas: number;
  ultimaPerdidaEn: number | null;
  /** El último cierre por stop de cada par: de él cuenta la espera tras un stop. */
  ultimoStopEn: Readonly<Record<string, number>>;
  /**
   * Pares ocupados: con una operación viva del agente, o con un bot real del
   * usuario en la misma cuenta (invariante 11).
   */
  ocupados: readonly string[];
}

export interface EntradaAgente {
  limites: LimitesAgente;
  venue: Venue;
  intervalo: IntervaloAgente;
  familias: readonly FamiliaAgente[];
  lados: readonly ('LONG' | 'SHORT')[];
  pares: readonly ParAgente[];
  /** Lo que la cuenta tiene libre para margen, en la quote. */
  saldoLibre: string;
  historial: HistorialAgente;
  /** Tope de apalancamiento de la cuenta (`risk_limits.max_leverage`). */
  maxApalancamientoUsuario: number | null;
  ahora: number;
}

/**
 * Lo del día que para una ronda antes de mirar el mercado, o null. En el orden
 * del spec (R-12): primero los límites del día, luego la capacidad.
 */
export function barreraDelDia(
  h: HistorialAgente,
  l: LimitesAgente,
  ahora: number,
): MotivoRonda | null {
  if (perdidaHoyPct(h, D(l.capital)).gte(l.perdidaDiariaPct)) return MotivoRonda.PERDIDA_DIARIA;
  if (h.operacionesHoy >= l.maxOperacionesDia) return MotivoRonda.OPERACIONES_DIA;
  if (
    h.rachaPerdidas >= l.maxPerdidasSeguidas &&
    h.ultimaPerdidaEn !== null &&
    ahora - h.ultimaPerdidaEn < l.esperaRachaMin * MINUTO
  ) {
    return MotivoRonda.RACHA;
  }
  // Lo que ya espera a una persona cuenta como si entrara: si no, dos
  // propuestas pendientes y una viva serían tres operaciones con un tope de dos.
  if (h.vivas + h.pendientes >= l.maxVivas || h.pendientes >= MAX_PENDIENTES_AGENTE) {
    return MotivoRonda.CAPACIDAD;
  }
  return null;
}

/** Un candidato se puede elegir si nada lo descarta y alguna opción de stop es viable. */
export const esElegibleAgente = (c: Pick<CandidatoAgente, 'descartes' | 'stops'>): boolean =>
  c.descartes.length === 0 && c.stops.some((o) => o.viable);

/** La huella de una oferta: la vela y los candidatos elegibles. */
export function huellaAgente(barT: number, pares: readonly SalidaAgentePar[]): string {
  const ids = pares
    .flatMap((p) => p.candidatos)
    .filter(esElegibleAgente)
    .map((c) => c.id)
    .sort();
  return `${barT}|${ids.join(',')}`;
}

/** Lo realizado hoy si además saltaran todos los stops abiertos: el peor caso del día. */
const peorCasoDelDia = (h: HistorialAgente): string =>
  D(h.realizadoHoy).minus(h.riesgoAbierto).toFixed();

/**
 * Quita los esquemas cuyo objetivo más cercano no llega al mínimo en % de la
 * entrada. El canal mide el objetivo en costes (`minObjetivoCoste`, que aquí
 * también rige); el agente pide además un mínimo en precio, que es como lo
 * piensa quien lo configura.
 */
function conObjetivoMinimo(
  o: OpcionStop,
  tope: Decimal,
  tp1: Decimal,
  tp2: Decimal,
  minimo: Decimal,
): OpcionStop {
  if (!o.viable || !minimo.gt(0)) return o;
  const llega = (tp: Decimal): boolean => tp.minus(tope).abs().div(tope).gte(minimo);
  const esquemas = o.esquemasViables.filter((x) =>
    x === EsquemaObjetivo.OPUESTO ? llega(tp2) : llega(tp1),
  );
  if (esquemas.length === o.esquemasViables.length) return o;
  return esquemas.length > 0
    ? { ...o, esquemasViables: esquemas }
    : { ...o, esquemasViables: [], viable: false, motivo: 'OBJETIVO_CORTO' };
}

/** La entrada del dimensionado para un par, con el peor caso del día. */
export function entradaDimensionado(
  cfg: ConfigDimensionado,
  market: MarketSpec,
  saldoLibre: string,
  historial: HistorialAgente,
  niveles: readonly NivelApalancamiento[],
  maxApalancamientoUsuario: number | null,
  atrLiquidacionTexto: string,
): EntradaDimensionado {
  return {
    cfg,
    market,
    saldoLibre,
    historial: { realizadoHoy: peorCasoDelDia(historial) },
    niveles,
    maxApalancamientoUsuario,
    mercado: { atr1h: atrLiquidacionTexto },
    canal: null,
  };
}

/**
 * Las opciones de stop de una operación, con sus números. La comparten la
 * ronda —que parte de una detección— y el recálculo al aprobar, que parte del
 * plan guardado: las dos calculan igual.
 */
export function opcionesDeStop(
  dim: EntradaDimensionado,
  lado: 'LONG' | 'SHORT',
  stops: readonly (Decimal | null)[],
  tope: Decimal,
  tp1: Decimal,
  tp2: Decimal,
  minObjetivoPct: string,
): OpcionStop[] {
  const minimo = D(minObjetivoPct).div(100);
  return TIPOS_STOP.map((tipo, i) =>
    conObjetivoMinimo(
      opcionDeStop(dim, { lado }, tipo, stops[i] ?? null, tope, tp1, tp2),
      tope,
      tp1,
      tp2,
      minimo,
    ),
  );
}

function candidatoDe(
  e: EntradaAgente,
  par: ParAgente,
  ticker: Ticker,
  barT: number,
  dim: EntradaDimensionado,
  atr: Decimal,
  d: DeteccionAgente,
  tasas: TasasBase | null,
): CandidatoAgente {
  const largo = d.lado === 'LONG';
  const extremo = aDecimal(d.extremo);
  const precios = TIPOS_STOP.map((tipo) =>
    stopDesdeExtremo(par.market, ticker, largo, extremo, atr, d.stopsAtr[tipo]),
  );
  const { referencia, tope } = preciosDeEntrada(
    par.market,
    ticker,
    largo,
    precios,
    D(MAX_DESLIZAMIENTO_R_AGENTE),
  );
  // Los objetivos redondean HACIA la entrada, como los del canal: el del largo
  // está por encima, y hacia ella es hacia abajo, que es como redondea una compra.
  const haciaEntrada = largo ? 'BUY' : 'SELL';
  const tp1 = D(px(par.market, aDecimal(d.tp1), haciaEntrada));
  const tp2 = D(px(par.market, aDecimal(d.tp2), haciaEntrada));
  const stops = opcionesDeStop(dim, d.lado, precios, tope, tp1, tp2, e.limites.minObjetivoPct);
  const descartes: string[] = [];
  if (!stops.some((o) => o.viable)) descartes.push('SIN_OPCION_VIABLE');
  // Con evidencia de verdad y esperanza negativa, la familia no se ofrece en
  // este par: la misma regla que el canal.
  if (tasas?.evidencia === Evidencia.MODERADA && tasas.rMedio < 0) {
    descartes.push('ESPERANZA_NEGATIVA');
  }
  return {
    id: `${par.simbolo}|${d.familia}|${d.lado}|${barT}`,
    simbolo: par.simbolo,
    familia: d.familia,
    lado: d.lado,
    entradaReferencia: referencia.toFixed(),
    entradaTope: tope.toFixed(),
    extremo: extremo.toFixed(),
    nivel: d.nivel === null ? null : aDecimal(d.nivel).toFixed(),
    tp1: tp1.toFixed(),
    tp2: tp2.toFixed(),
    stops,
    tasas,
    descartes,
  };
}

function analizarPar(
  e: EntradaAgente,
  par: ParAgente,
  barT: number,
  cfg: ConfigDimensionado,
): SalidaAgentePar {
  const sin = (descartes: string[], mercado: ContextoParAgente | null = null): SalidaAgentePar => ({
    simbolo: par.simbolo,
    mercado,
    candidatos: [],
    descartes,
  });
  if (e.historial.ocupados.includes(par.simbolo)) return sin(['OCUPADO']);
  const ultimoStop = e.historial.ultimoStopEn[par.simbolo];
  if (ultimoStop !== undefined && e.ahora - ultimoStop < e.limites.esperaStopMin * MINUTO) {
    return sin(['ESPERA_STOP']);
  }
  // Nunca una vela sin cerrar: decidir con ella sería mirar al futuro.
  const velas = par.velas.filter((v) => v.t <= barT);
  if (velas.length < MIN_VELAS_AGENTE) return sin(['SIN_DATOS']);
  if (!par.ticker) return sin(['SIN_PRECIO']);
  const ticker = par.ticker;
  const s = serieNumerica(velas);
  const ind = indicadoresAgente(s);
  // La ronda es de la vela `barT`: sin ella, el par se queda fuera de esta.
  const frescas = s.t[s.n - 1] === barT;
  const mercado = contextoPar(s, ind, regimenAgente(s), ticker, par.fundingBps, frescas);
  if (!frescas) return sin(['VELAS_ANTIGUAS'], mercado);
  const j = s.n - 1;
  const atr = ind.atr[j];
  if (!(atr > 0)) return sin(['SIN_DATOS'], mercado);
  const atrD = aDecimal(atr);
  if (D(ticker.ask).minus(ticker.bid).gt(atrD.mul(MAX_SPREAD_ATR_AGENTE))) {
    return sin(['SPREAD'], mercado);
  }
  const detecciones = detectarFamilias(s, ind, j, e.familias, e.lados);
  if (detecciones.length === 0) return sin([], mercado);
  // Las tasas cuestan: solo cuando hay algo que ofrecer.
  const tasas = tasasAgente(s, ind, {
    familias: e.familias,
    lados: e.lados,
    costes: cfg.costes,
    maxVelas: e.limites.maxVelasOperacion,
  });
  const dim = entradaDimensionado(
    cfg,
    par.market,
    e.saldoLibre,
    e.historial,
    par.niveles,
    e.maxApalancamientoUsuario,
    nivelTexto(atrLiquidacion(velas, e.intervalo, atr)),
  );
  const candidatos = detecciones.map((d) =>
    candidatoDe(
      e,
      par,
      ticker,
      barT,
      dim,
      atrD,
      d,
      tasas.get(claveTasasAgente(d.familia, d.lado)) ?? null,
    ),
  );
  return { simbolo: par.simbolo, mercado, candidatos, descartes: [] };
}

export function usoDelDia(h: HistorialAgente, l: LimitesAgente): UsoAgente {
  const capital = D(l.capital);
  return {
    perdidaHoyPct: perdidaHoyPct(h, capital).toNumber(),
    riesgoAbiertoPct: capital.gt(0)
      ? Decimal.max(0, D(h.riesgoAbierto)).div(capital).mul(100).toNumber()
      : 0,
    topeDiarioPct: Number(l.perdidaDiariaPct),
    operacionesHoy: h.operacionesHoy,
    topeOperaciones: l.maxOperacionesDia,
    vivas: h.vivas,
    topeVivas: l.maxVivas,
    rachaPerdidas: h.rachaPerdidas,
  };
}

/** La ronda entera: la vela que acaba de cerrar, en cada par. */
export function herramientaAgente(e: EntradaAgente): SalidaAgente {
  const barT = ultimaCerradaEsperada(e.ahora, e.intervalo);
  const cfg = dimensionadoDeAgente(e.limites, e.venue);
  const pares = e.pares.map((p) => analizarPar(e, p, barT, cfg));
  return {
    version: 1,
    barT,
    generadaEn: e.ahora,
    intervalo: e.intervalo,
    pares,
    uso: usoDelDia(e.historial, e.limites),
    huella: huellaAgente(barT, pares),
  };
}

/** El mejor R neto que puede dar un candidato con alguno de sus esquemas viables. */
function mejorR(c: CandidatoAgente): number {
  let mejor = Number.NEGATIVE_INFINITY;
  for (const o of c.stops) {
    if (!o.viable) continue;
    for (const x of o.esquemasViables) {
      const r = x === EsquemaObjetivo.OPUESTO ? o.rNetoTp2 : o.rNetoTp1;
      if (r !== null && r > mejor) mejor = r;
    }
  }
  return mejor;
}

export interface PuestoOferta {
  letra: string;
  candidato: CandidatoAgente;
}

/**
 * Lo que se le enseña al modelo, con su letra: los elegibles, ordenados por lo
 * que dice el histórico —el límite inferior de Wilson de su familia y lado en
 * el par—, luego por el mejor R neto y por último por id, para que el orden no
 * dependa de nada más. Como mucho `MAX_OFERTA_AGENTE`.
 *
 * El orden importa solo por el recorte: el juez elige el primero que puede, y
 * el modelo los ve todos con sus números.
 */
export function ofertaAgente(salida: SalidaAgente, max = MAX_OFERTA_AGENTE): PuestoOferta[] {
  const elegibles = salida.pares.flatMap((p) => p.candidatos).filter(esElegibleAgente);
  const clave = new Map(
    elegibles.map((c) => [c.id, { w: c.tasas?.wilsonInferior ?? -1, r: mejorR(c) }]),
  );
  elegibles.sort((a, b) => {
    const ka = clave.get(a.id);
    const kb = clave.get(b.id);
    if (ka && kb && ka.w !== kb.w) return kb.w - ka.w;
    if (ka && kb && ka.r !== kb.r) return kb.r > ka.r ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return elegibles
    .slice(0, Math.min(max, LETRAS_OFERTA.length))
    .map((candidato, i) => ({ letra: LETRAS_OFERTA[i], candidato }));
}
