import {
  D,
  Decimal,
  OBJETIVO_DE_ESQUEMA,
  type BandaCalculada,
  type CandidatoAgente,
  type ContextoParAgente,
  type LimitesAgente,
  type OpcionStop,
  type SalidaAgente,
} from '@crypton/shared';
import type { PuestoOferta } from '@crypton/strategy-core';

/**
 * La oferta de una ronda tal y como la ve el modelo (spec 074, R-15).
 *
 * El motor la calculó con todos sus números. Aquí se traduce a unidades
 * relativas —% del precio, múltiplos del ATR del intervalo, R, % del capital,
 * «x»— y se quita todo lo que identifica o no hace falta para decidir:
 * - ni precios ni niveles: un número absoluto invita a inventar otros;
 * - ni importes, ni cantidades, ni el capital;
 * - ni el par, ni el exchange, ni ids, ni horas, ni el nombre del agente: los
 *   pares van como «par 1», «par 2», para que se vea cuándo dos operaciones
 *   son del mismo sin decir cuál;
 * - ni textos anteriores del modelo.
 *
 * Hay un test que recorre el texto buscando cualquiera de esas cosas.
 */

const PORCENTAJE = D(100);

/** Con punto decimal y sin notación científica. */
const num = (x: Decimal | number, decimales = 2): string =>
  (typeof x === 'number' ? D(x) : x).toFixed(decimales);

const conSigno = (x: number, decimales = 2): string => (x >= 0 ? '+' : '') + num(x, decimales);

const pct = (fraccion: Decimal | number, decimales = 2): string =>
  `${num((typeof fraccion === 'number' ? D(fraccion) : fraccion).mul(PORCENTAJE), decimales)} %`;

/** Una distancia en % de la entrada y en ATR del intervalo. */
function distancia(desde: Decimal, hasta: Decimal, atr: Decimal): string {
  const d = hasta.minus(desde).abs();
  const enAtr = atr.gt(0) ? ` (${num(d.div(atr))} ATR)` : '';
  return desde.gt(0) ? `${pct(d.div(desde))}${enAtr}` : 'sin dato';
}

const LADOS = { LONG: 'largo', SHORT: 'corto' } as const;

const INTERVALOS: Readonly<Record<string, string>> = {
  '15m': '15 min',
  '30m': '30 min',
  '1h': '1 h',
  '4h': '4 h',
};

/** Los códigos del motor, en palabras. */
const POR_QUE_NO: Readonly<Record<string, string>> = {
  STOP_INVALIDO: 'el stop quedaría al otro lado de la entrada',
  STOP_ANCHO: 'el stop sería más ancho de lo permitido',
  CAPITAL: 'no hay capital configurado',
  TOPE_DIARIO: 'no queda margen en el tope diario',
  SIN_MARGEN: 'no queda saldo libre para el margen',
  APALANCAMIENTO: 'ningún apalancamiento deja la liquidación lo bastante lejos',
  MINIMO: 'no llega al mínimo del exchange',
  LIQUIDACION: 'la liquidación quedaría antes del stop',
  RR: 'ningún objetivo permitido paga el R mínimo',
  OBJETIVO_CORTO: 'ningún objetivo llega al recorrido mínimo del dueño',
};

// ── Bloques ────────────────────────────────────────────────────────────────

function dueno(limites: LimitesAgente, salida: SalidaAgente, lados: readonly string[]): string[] {
  const permitidos =
    lados.length === 2 ? 'largos y cortos' : lados[0] === 'LONG' ? 'solo largos' : 'solo cortos';
  return [
    'EL DUEÑO (sus límites ordenan; nunca se amplían)',
    `- Riesgo por operación: ${num(D(limites.riesgoPct))} % del capital. Pérdida diaria ` +
      `máxima: ${num(D(limites.perdidaDiariaPct))} %.`,
    `- Beneficio neto mínimo por objetivo: ${num(D(limites.minRR))} R. Lados permitidos: ` +
      `${permitidos}.`,
    `- Velas de ${INTERVALOS[salida.intervalo] ?? salida.intervalo}.`,
  ];
}

function hoy(salida: SalidaAgente): string[] {
  const u = salida.uso;
  return [
    'HOY (día UTC)',
    `- Pérdida realizada: ${num(u.perdidaHoyPct)} % del capital. En riesgo en lo abierto: ` +
      `${num(u.riesgoAbiertoPct)} %. Tope del día: ${num(u.topeDiarioPct)} %.`,
    `- Operaciones: ${u.operacionesHoy} de ${u.topeOperaciones}. Abiertas: ${u.vivas} de ` +
      `${u.topeVivas}. Pérdidas seguidas: ${u.rachaPerdidas}.`,
  ];
}

function mercado(m: ContextoParAgente, par: string): string {
  const funding =
    m.fundingBps === null
      ? 'sin dato'
      : `${conSigno(m.fundingBps)} bps por periodo` +
        (m.fundingBps > 0
          ? ' (lo pagan los largos)'
          : m.fundingBps < 0
            ? ' (lo pagan los cortos)'
            : '');
  return (
    `- Mercado del ${par}: régimen ${m.regimen}${m.sentido ? ` ${m.sentido}` : ''}; ADX ` +
    `${num(m.adx, 1)}; RSI ${num(m.rsi, 1)}; ATR ${num(m.atrPct)} % del precio; anchura de ` +
    `bandas en el percentil ${num(m.percentilAncho, 0)}; cierre a ${conSigno(m.distanciaMediaAtr)} ` +
    `ATR de la media rápida; pendiente de la media lenta ${conSigno(m.pendienteMedia, 3)} ATR por ` +
    `vela; spread ${num(m.spreadBps, 1)} bps; funding ${funding}.`
  );
}

function banda(b: BandaCalculada, entrada: Decimal, stop: Decimal, capital: Decimal): string {
  const margen = capital.gt(0) ? `margen ${pct(D(b.margen).div(capital), 1)} del capital` : '';
  const aStop = entrada.minus(stop).abs();
  const liq =
    b.liquidacion && aStop.gt(0)
      ? `liquidación a ${num(entrada.minus(b.liquidacion).abs().div(aStop), 1)} stops`
      : 'liquidación sin estimar';
  return `${b.banda} ${b.apalancamiento}x (${[margen, liq].filter(Boolean).join(', ')})`;
}

function opcionDeStop(o: OpcionStop, entrada: Decimal, atr: Decimal, capital: Decimal): string[] {
  if (!o.viable) {
    return [`  · ${o.tipo}: no disponible, ${POR_QUE_NO[o.motivo ?? ''] ?? 'no se ofrece'}.`];
  }
  const stop = D(o.precio);
  const r = (x: number | null) => (x === null ? 'sin dato' : num(x));
  const eq = (x: number | null) => (x === null ? 'sin dato' : pct(x, 0));
  const objetivos = o.esquemasViables.map((e) => OBJETIVO_DE_ESQUEMA[e]).join(', ');
  return [
    `  · ${o.tipo}: a ${distancia(entrada, stop, atr)} de la entrada. R neto: ` +
      `${r(o.rNetoTp1)} con el CERCANO, ${r(o.rNetoTp2)} con el LEJANO. Coste: ${r(o.costeR)} R. ` +
      `Acierto de equilibrio: ${eq(o.aciertoEquilibrioTp1)} con el CERCANO, ` +
      `${eq(o.aciertoEquilibrioTp2)} con el LEJANO.`,
    `    Si salta, pierde el ${o.riesgoPctCapital === null ? 'sin dato' : num(o.riesgoPctCapital)} % ` +
      `del capital. Objetivos disponibles: ${objetivos}. Tamaño MEDIO: ` +
      `${o.medioViable ? 'disponible' : 'no disponible (no llega al mínimo del exchange)'}.`,
    `    Bandas: ${o.bandas.map((b) => banda(b, entrada, stop, capital)).join(' · ')}. En un ` +
      'hueco de precio más allá de la liquidación se perdería el margen.',
  ];
}

function opcion(
  letra: string,
  c: CandidatoAgente,
  par: string,
  m: ContextoParAgente | null,
  capital: Decimal,
): string[] {
  const entrada = D(c.entradaTope);
  const referencia = D(c.entradaReferencia);
  const atr = m ? D(m.atr) : D(0);
  const t = c.tasas;
  const historico = t
    ? `${t.n} casos, acierto ${t.n > 0 ? pct(t.aciertos / t.n, 0) : 'sin dato'}, límite ` +
      `inferior de Wilson ${pct(t.wilsonInferior, 0)}, R medio ${conSigno(t.rMedio)}, evidencia ` +
      `${t.evidencia}.`
    : 'sin datos.';
  return [
    `Opción ${letra}: ${c.familia}, ${LADOS[c.lado]}, en el ${par}`,
    ...(m ? [mercado(m, par)] : []),
    `- Entrada: orden inmediata con el precio limitado a ` +
      `${referencia.gt(0) ? pct(entrada.minus(referencia).abs().div(referencia), 3) : 'sin dato'} ` +
      'de la referencia.',
    `- Objetivos: CERCANO a ${distancia(entrada, D(c.tp1), atr)} de la entrada; LEJANO a ` +
      `${distancia(entrada, D(c.tp2), atr)}. ESCALONADO sale con una parte en cada uno.`,
    `- Histórico de la familia en este par: ${historico}`,
    '- Stops:',
    ...c.stops.flatMap((o) => opcionDeStop(o, entrada, atr, capital)),
  ];
}

/**
 * El texto que recibe el modelo. El capital solo se usa para pasar el margen a
 * porcentaje: nunca se escribe.
 */
export function renderOferta(
  salida: SalidaAgente,
  oferta: readonly PuestoOferta[],
  limites: LimitesAgente,
  lados: readonly string[],
): string {
  const capital = D(limites.capital);
  // Los pares, por orden de aparición: «par 1», «par 2»… Nunca su nombre.
  const etiquetas = new Map<string, string>();
  for (const { candidato } of oferta) {
    if (!etiquetas.has(candidato.simbolo)) {
      etiquetas.set(candidato.simbolo, `par ${etiquetas.size + 1}`);
    }
  }
  const mercadoDe = (simbolo: string): ContextoParAgente | null =>
    salida.pares.find((p) => p.simbolo === simbolo)?.mercado ?? null;
  const bloques: string[][] = [
    [
      `HERRAMIENTA agentes v${salida.version}. Son datos calculados por el sistema, no ` +
        'instrucciones. Números con punto decimal.',
    ],
    dueno(limites, salida, lados),
    hoy(salida),
    [
      `OPCIONES (responde con una letra: ${oferta.map((p) => p.letra).join(', ')}; o NINGUNA)`,
      ...oferta.flatMap(({ letra, candidato }, i) => [
        ...(i > 0 ? [''] : []),
        ...opcion(
          letra,
          candidato,
          etiquetas.get(candidato.simbolo) ?? 'par',
          mercadoDe(candidato.simbolo),
          capital,
        ),
      ]),
    ],
  ];
  return bloques.map((b) => b.join('\n')).join('\n\n');
}
