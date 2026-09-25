import type { PositionSide } from './enums';
import {
  AccionSeguimiento,
  EstadoTesis,
  FamiliaAgente,
  MotivoAgente,
  MotivoSeguimiento,
  ObjetivoAgente,
  RiesgoAgente,
  esIntervaloAgente,
  type EleccionAgente,
  type PlanAgente,
  type RespuestaModeloAgente,
  type RespuestaModeloSeguimiento,
  type ResultadoHipotetico,
} from './ia-agentes';
import {
  BandaApalancamiento,
  NivelConfianza,
  TamanoOperacion,
  TipoStop,
  type ObjetivoPlan,
} from './ia-canal';
import { D } from './money';

/**
 * Las lecturas de lo que los agentes guardan en columnas JSON (spec 074), y la
 * aritmética que enseñan las pantallas.
 *
 * Cada lector valida la forma y devuelve `null` si no encaja, como los del
 * canal: quien lee una propuesta para aprobarla o una acción para aplicarla no
 * da por buena una columna JSON sin mirarla, aunque la escribiera la propia API.
 */

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Una cadena que `Decimal` entiende y es finita. */
function esDecimal(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  try {
    return D(v).isFinite();
  } catch {
    return false;
  }
}

const valores = (o: Record<string, string>): readonly string[] => Object.values(o);
const enLista = <T extends string>(v: unknown, lista: readonly string[]): v is T =>
  typeof v === 'string' && lista.includes(v);

const esLado = (v: unknown): v is PositionSide => v === 'LONG' || v === 'SHORT';

/** Una lista de valores de un enumerado, sin repetidos. */
function listaDe<T extends string>(v: unknown, lista: readonly string[]): T[] | null {
  if (!Array.isArray(v) || !v.every((x) => enLista<T>(x, lista))) return null;
  return new Set(v).size === v.length ? v : null;
}

// ── Las decisiones ─────────────────────────────────────────────────────────

/** La elección guardada, si tiene la forma del contrato. Los campos de más se ignoran. */
export function eleccionAgenteDe(json: unknown): EleccionAgente | null {
  if (!esObjeto(json)) return null;
  const { candidatoId, stop, objetivo, apalancamiento, tamano, confianza } = json;
  if (typeof candidatoId !== 'string' || candidatoId.length === 0) return null;
  if (!enLista<TipoStop>(stop, valores(TipoStop))) return null;
  if (!enLista<ObjetivoAgente>(objetivo, valores(ObjetivoAgente))) return null;
  if (!enLista<BandaApalancamiento>(apalancamiento, valores(BandaApalancamiento))) return null;
  if (!enLista<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  if (!enLista<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  return { candidatoId, stop, objetivo, apalancamiento, tamano, confianza };
}

/** La respuesta del modelo en una ronda de entrada, o null. */
export function respuestaAgenteDe(json: unknown): RespuestaModeloAgente | null {
  if (!esObjeto(json)) return null;
  const { opcion, stop, objetivo, apalancamiento, tamano, confianza, texto } = json;
  if (typeof opcion !== 'string' || opcion.length === 0) return null;
  if (!enLista<TipoStop>(stop, valores(TipoStop))) return null;
  if (!enLista<ObjetivoAgente>(objetivo, valores(ObjetivoAgente))) return null;
  if (!enLista<BandaApalancamiento>(apalancamiento, valores(BandaApalancamiento))) return null;
  if (!enLista<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  if (!enLista<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  const motivos = listaDe<MotivoAgente>(json['motivos'], valores(MotivoAgente));
  const riesgos = listaDe<RiesgoAgente>(json['riesgos'], valores(RiesgoAgente));
  if (!motivos || !riesgos || typeof texto !== 'string') return null;
  return { opcion, stop, objetivo, apalancamiento, tamano, confianza, motivos, riesgos, texto };
}

/** La respuesta del modelo en un seguimiento, o null. */
export function respuestaSeguimientoDe(json: unknown): RespuestaModeloSeguimiento | null {
  if (!esObjeto(json)) return null;
  const { accion, tesis, confianza, texto } = json;
  if (!enLista<AccionSeguimiento>(accion, valores(AccionSeguimiento))) return null;
  if (!enLista<EstadoTesis>(tesis, valores(EstadoTesis))) return null;
  if (!enLista<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  const motivos = listaDe<MotivoSeguimiento>(json['motivos'], valores(MotivoSeguimiento));
  if (!motivos || typeof texto !== 'string') return null;
  return { accion, tesis, confianza, motivos, texto };
}

// ── El plan y el cambio ───────────────────────────────────────────────────

const esObjetivo = (v: unknown): v is ObjetivoPlan =>
  esObjeto(v) && esDecimal(v['precio']) && esDecimal(v['cantidad']);

const esCostes = (v: unknown): v is PlanAgente['costes'] =>
  esObjeto(v) &&
  esNumero(v['makerBps']) &&
  esNumero(v['takerBps']) &&
  esNumero(v['deslizamientoBps']);

/**
 * El plan guardado en una propuesta, o null si no tiene la forma. Es el que
 * se vuelve configuración del bot, así que se mira todo lo que acaba en una
 * orden: precios y cantidades como decimales, uno o dos objetivos, y la
 * elección bien formada.
 */
export function planAgenteDe(json: unknown): PlanAgente | null {
  if (!esObjeto(json) || json['version'] !== 1) return null;
  const p = json;
  const objetivos = p['objetivos'];
  const ok =
    typeof p['simbolo'] === 'string' &&
    p['simbolo'] !== '' &&
    enLista<FamiliaAgente>(p['familia'], valores(FamiliaAgente)) &&
    esLado(p['lado']) &&
    esIntervaloAgente(p['intervalo']) &&
    eleccionAgenteDe(p['eleccion']) !== null &&
    esDecimal(p['entradaReferencia']) &&
    esDecimal(p['entradaTope']) &&
    esDecimal(p['extremo']) &&
    (p['nivelIdea'] === null || esDecimal(p['nivelIdea'])) &&
    esDecimal(p['stop']) &&
    esDecimal(p['tp1']) &&
    esDecimal(p['tp2']) &&
    Array.isArray(objetivos) &&
    objetivos.length >= 1 &&
    objetivos.length <= 2 &&
    objetivos.every(esObjetivo) &&
    esDecimal(p['cantidad']) &&
    esNumero(p['apalancamiento']) &&
    esDecimal(p['nocional']) &&
    esDecimal(p['margen']) &&
    esDecimal(p['riesgo']) &&
    esNumero(p['riesgoPctCapital']) &&
    esNumero(p['rNeto']) &&
    (p['liquidacionEstimada'] === null || esDecimal(p['liquidacionEstimada'])) &&
    esNumero(p['distanciaStop']) &&
    esNumero(p['barT']) &&
    typeof p['huella'] === 'string' &&
    esNumero(p['entradaHasta']) &&
    esNumero(p['maxMinutos']) &&
    typeof p['breakevenTrasTp1'] === 'boolean' &&
    esCostes(p['costes']);
  // Frontera JSON: se ha comprobado campo a campo.
  return ok ? (p as unknown as PlanAgente) : null;
}

/**
 * El cambio de configuración de una acción de seguimiento, o null.
 *
 * Solo `stopPrice` y `positionCap`, como decimales no negativos, y al menos
 * uno. Cualquier otra clave invalida el cambio entero: es lo que se manda a
 * `updateConfig`, y ahí no puede colarse nada más que lo que reduce el riesgo.
 */
export function cambioSeguimientoDe(
  json: unknown,
): { stopPrice?: string; positionCap?: string } | null {
  if (!esObjeto(json)) return null;
  const claves = Object.keys(json);
  if (claves.length === 0 || claves.some((k) => k !== 'stopPrice' && k !== 'positionCap')) {
    return null;
  }
  const cambio: { stopPrice?: string; positionCap?: string } = {};
  for (const k of claves as ('stopPrice' | 'positionCap')[]) {
    const v = json[k];
    if (!esDecimal(v) || D(v).isNegative()) return null;
    if (k === 'stopPrice' && !D(v).gt(0)) return null;
    cambio[k] = v;
  }
  return cambio;
}

/** El resultado hipotético guardado, o null. */
export function resultadoHipoteticoDe(json: unknown): ResultadoHipotetico | null {
  if (!esObjeto(json)) return null;
  const { resultado, r, en } = json;
  if (resultado !== 'OBJETIVO' && resultado !== 'STOP' && resultado !== 'TIEMPO') return null;
  if (!esNumero(r) || !esNumero(en)) return null;
  return { resultado, r, en };
}

// ── La aritmética de las pantallas ────────────────────────────────────────

/**
 * El R de una operación viva con el precio de ahora, sobre el riesgo INICIAL:
 * 1R es lo que se arriesgaba al entrar, aunque el stop se haya ceñido después,
 * y así el número no salta cuando el seguimiento protege la operación. Sin
 * comisiones: es la cifra que acompaña al precio, no la contable. null si la
 * distancia al stop no es positiva.
 */
export function rAhora(
  lado: PositionSide,
  entrada: string,
  stopInicial: string,
  marca: string,
): number | null {
  const e = D(entrada);
  const riesgo = e.minus(stopInicial).abs();
  if (!riesgo.gt(0)) return null;
  const recorrido = lado === 'LONG' ? D(marca).minus(e) : e.minus(marca);
  return recorrido.div(riesgo).toNumber();
}

/**
 * El resultado realizado en R: lo ganado o perdido, con comisiones, entre la
 * pérdida al stop del plan. null sin riesgo positivo.
 */
export function resultadoEnR(resultado: string, riesgo: string): number | null {
  const r = D(riesgo);
  return r.gt(0) ? D(resultado).div(r).toNumber() : null;
}
