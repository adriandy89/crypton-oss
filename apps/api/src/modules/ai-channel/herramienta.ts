import {
  D,
  Decimal,
  PerfilCanal,
  type BandaCalculada,
  type CandidatoOperacion,
  type CanalDetectado,
  type OpcionStop,
  type SalidaHerramienta,
} from '@crypton/shared';
import { esElegible, type ConfigCanal } from '@crypton/strategy-core';
import { etiquetaDe } from './contrato';

/**
 * La herramienta del canal tal y como la ve el modelo (spec 059).
 *
 * El worker la calculó con todos sus números. Aquí se traduce a unidades
 * relativas —% del precio, múltiplos del ATR, R, % del capital, «x»— y se
 * quita todo lo que identifica o no hace falta para decidir:
 * - ni precios ni niveles: el modelo no los necesita, y un número absoluto
 *   invita a inventar otros;
 * - ni importes, ni cantidades, ni el capital;
 * - ni ids, ni horas, ni el par, ni la huella: los ids de los candidatos
 *   llevan la hora del primer toque del canal, y el modelo ve etiquetas.
 *
 * Hay un test que recorre el texto buscando cualquiera de esas cosas.
 */

const PORCENTAJE = D(100);

/** Lo que el modelo puede elegir: los candidatos elegibles, con su etiqueta. */
export interface OfertaCanal {
  etiquetas: string[];
  porEtiqueta: ReadonlyMap<string, CandidatoOperacion>;
}

/**
 * Los candidatos que se ofrecen: elegibles y dentro de la configuración. Son
 * las mismas comprobaciones que hará `construirOperacion`: ofrecer algo que la
 * ejecución rechazaría sería gastar una llamada en nada.
 */
export function ofertaDe(salida: SalidaHerramienta, cfg: ConfigCanal): OfertaCanal {
  const canal = salida.canal;
  const candidatos = canal
    ? salida.candidatos.filter(
        (c) =>
          esElegible(c) &&
          (cfg.direccion === 'NEUTRAL' || c.lado === cfg.direccion) &&
          cfg.setups.includes(c.setup) &&
          cfg.canales.includes(canal.tipo) &&
          c.stops.some((s) => s.viable),
      )
    : [];
  const porEtiqueta = new Map<string, CandidatoOperacion>();
  // Hasta la Z: nunca hay tantos, y una etiqueta rara sería peor que una opción menos.
  candidatos.slice(0, 26).forEach((c, i) => porEtiqueta.set(etiquetaDe(i), c));
  return { etiquetas: [...porEtiqueta.keys()], porEtiqueta };
}

// ── Formato ────────────────────────────────────────────────────────────────

/** Con punto decimal y sin notación científica. */
const num = (x: Decimal | number, decimales = 2): string =>
  (typeof x === 'number' ? D(x) : x).toFixed(decimales);

const conSigno = (x: number, decimales = 2): string => (x >= 0 ? '+' : '') + num(x, decimales);

const pct = (fraccion: Decimal | number, decimales = 2): string =>
  `${num((typeof fraccion === 'number' ? D(fraccion) : fraccion).mul(PORCENTAJE), decimales)} %`;

/** Una distancia en % del precio de referencia y en ATR de 15 min. */
function distancia(desde: Decimal, hasta: Decimal, atr15: Decimal): string {
  const d = hasta.minus(desde).abs();
  const enAtr = atr15.gt(0) ? ` (${num(d.div(atr15))} ATR)` : '';
  return `${pct(d.div(desde))}${enAtr}`;
}

const LADOS = { LONG: 'largo', SHORT: 'corto' } as const;

const DIRECCION = {
  NEUTRAL: 'los dos (largos y cortos)',
  LONG: 'solo largos',
  SHORT: 'solo cortos',
} as const;

/** Los códigos de `herramienta.ts` del motor, en palabras. */
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
};

const PREFERENCIA: Readonly<Record<PerfilCanal, string>> = {
  [PerfilCanal.PRUDENTE]: 'stop AMPLIO, banda BAJA, salida en la MEDIA',
  [PerfilCanal.EQUILIBRADA]: 'stop NORMAL o AMPLIO, banda MEDIA, salida ESCALONADA o en la MEDIA',
  [PerfilCanal.AGRESIVA]:
    'stop AJUSTADO si está disponible, banda ALTA, salida ESCALONADA; el OPUESTO solo si la media no paga',
};

// ── Bloques ────────────────────────────────────────────────────────────────

function preferencias(cfg: ConfigCanal): string[] {
  return [
    'PREFERENCIAS DEL DUEÑO (ordenan; nunca amplían un límite)',
    `- Perfil: ${cfg.perfil} (${PREFERENCIA[cfg.perfil]}).`,
    `- Lados permitidos: ${DIRECCION[cfg.direccion]}.`,
    `- Confianza mínima para operar: ${cfg.confianzaMinima}. Por debajo de ALTA se ejecuta el ` +
      'tamaño MEDIO.',
    `- Esquemas de salida permitidos: ${cfg.esquemas.join(', ')}.`,
    `- R neto mínimo por objetivo: ${num(cfg.minRR)}.`,
    `- Riesgo por operación: ${num(cfg.riesgoPct)} % del capital. Tope de pérdida diaria: ` +
      `${num(cfg.topeDiarioPct)} %.`,
  ];
}

function mercado(salida: SalidaHerramienta): string[] {
  const m = salida.mercado;
  const precio = D(m.precio);
  const atr = (v: string) => (precio.gt(0) ? pct(D(v).div(precio)) : 'sin dato');
  const funding =
    m.fundingBps === null
      ? 'sin dato'
      : `${conSigno(m.fundingBps)} bps por periodo` +
        (m.fundingBps > 0
          ? ' (lo pagan los largos)'
          : m.fundingBps < 0
            ? ' (lo pagan los cortos)'
            : '');
  return [
    'MERCADO',
    `- Régimen en 1 h: ${m.regimen}${m.sentido ? ` ${m.sentido}` : ''}.`,
    `- ADX 1 h: ${num(m.adx1h, 1)}. CHOP 1 h: ${num(m.chop1h, 1)}. CHOP 15 min: ${num(m.chop15m, 1)}.`,
    `- Eficiencia en el percentil ${num(m.percentilEficiencia, 0)} y anchura de bandas en el ` +
      `percentil ${num(m.percentilAncho, 0)} de su historia reciente.`,
    `- ATR 14 frente a ATR 96 (1 h): ${num(m.ratioAtr)}.`,
    `- ATR: 5 min ${atr(m.atr5m)}, 15 min ${atr(m.atr15m)}, 1 h ${atr(m.atr1h)} del precio.`,
    `- Spread: ${num(m.spreadBps, 1)} bps. Funding: ${funding}.`,
  ];
}

function canal(c: CanalDetectado | null, salida: SalidaHerramienta): string[] {
  if (!c) return ['CANAL', '- Ninguno.'];
  const precio = D(salida.mercado.precio);
  const atr15 = D(salida.mercado.atr15m);
  const soporte = D(c.soporte);
  const resistencia = D(c.resistencia);
  const ancho = resistencia.minus(soporte);
  const lineas = [
    'CANAL',
    `- ${c.tipo}, calidad ${c.calidad}, puntuación ${num(c.puntuacion, 0)} de 100.`,
    `- Anchura: ${num(c.anchuraAtr)} ATR de 15 min` +
      (precio.gt(0) ? ` (${pct(ancho.div(precio))} del precio).` : '.'),
    `- Toques: ${c.toquesSoporte} en el soporte y ${c.toquesResistencia} en la resistencia. ` +
      `Cierres dentro: ${pct(c.contencion, 0)}. Cruces de la media: ${c.cruces}.`,
    `- Duración: ${c.duracionVelas} velas. Media vida: ` +
      (c.mediaVidaVelas === null ? 'sin estimar' : `${num(c.mediaVidaVelas, 1)} velas`) +
      `. Último toque: hace ${c.ultimoToqueHace} ${c.ultimoToqueHace === 1 ? 'vela' : 'velas'}. R²: ` +
      (c.r2 === null ? 'no aplica' : num(c.r2)) +
      '.',
  ];
  if (c.pendientePorVela === 0) {
    lineas.push('- Pendiente: horizontal.');
  } else {
    const porVela = atr15.gt(0) ? D(c.pendientePorVela).div(atr15) : null;
    lineas.push(
      `- Pendiente: ${c.pendientePorVela > 0 ? 'alcista' : 'bajista'}` +
        (porVela ? `, ${num(porVela.abs(), 3)} ATR de 15 min por vela de 15 min.` : '.'),
    );
  }
  if (ancho.gt(0) && precio.gt(0)) {
    const dentro = precio.minus(soporte).div(ancho);
    const enAtr = (d: Decimal) => (atr15.gt(0) ? `${num(d.div(atr15))} ATR` : 'sin ATR');
    lineas.push(
      `- Precio: al ${pct(dentro, 0)} de la anchura desde el soporte ` +
        `(${enAtr(precio.minus(soporte))} sobre el soporte, ` +
        `${enAtr(resistencia.minus(precio))} bajo la resistencia).`,
    );
  }
  return lineas;
}

function hoy(salida: SalidaHerramienta): string[] {
  const u = salida.uso;
  return [
    'HOY (día UTC)',
    `- Pérdida realizada: ${num(u.perdidaHoyPct)} % del capital, con un tope del ` +
      `${num(u.topeDiarioPct)} %.`,
    `- Operaciones: ${u.operacionesHoy} de ${u.topeOperaciones}. Pérdidas seguidas: ` +
      `${u.rachaPerdidas}.`,
  ];
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

function opcionDeStop(o: OpcionStop, entrada: Decimal, atr15: Decimal, capital: Decimal): string[] {
  if (!o.viable) {
    return [`  · ${o.tipo}: no disponible, ${POR_QUE_NO[o.motivo ?? ''] ?? 'no se ofrece'}.`];
  }
  const stop = D(o.precio);
  const r = (x: number | null) => (x === null ? 'sin dato' : num(x));
  const eq = (x: number | null) => (x === null ? 'sin dato' : pct(x, 0));
  return [
    `  · ${o.tipo}: a ${distancia(entrada, stop, atr15)} de la entrada. ` +
      `R neto: ${r(o.rNetoTp1)} con la media, ${r(o.rNetoTp2)} con el borde opuesto. ` +
      `Coste: ${r(o.costeR)} R. Acierto de equilibrio: ${eq(o.aciertoEquilibrioTp1)} con la ` +
      `media, ${eq(o.aciertoEquilibrioTp2)} con el borde opuesto.`,
    `    Si salta, pierde el ${o.riesgoPctCapital === null ? 'sin dato' : num(o.riesgoPctCapital)} % ` +
      `del capital. Esquemas disponibles: ${o.esquemasViables.join(', ')}. Tamaño MEDIO: ` +
      `${o.medioViable ? 'disponible' : 'no disponible (no llega al mínimo del exchange)'}.`,
    `    Bandas: ${o.bandas.map((b) => banda(b, entrada, stop, capital)).join(' · ')}. En un ` +
      'hueco de precio más allá de la liquidación se perdería el margen.',
  ];
}

function opcion(
  etiqueta: string,
  c: CandidatoOperacion,
  salida: SalidaHerramienta,
  capital: Decimal,
): string[] {
  const entrada = D(c.entradaTope);
  const referencia = D(c.entradaReferencia);
  const atr15 = D(salida.mercado.atr15m);
  const t = c.tasas;
  const historico = t
    ? `${t.n} casos, acierto ${t.n > 0 ? pct(t.aciertos / t.n, 0) : 'sin dato'}, límite ` +
      `inferior de Wilson ${pct(t.wilsonInferior, 0)}, R medio ${conSigno(t.rMedio)}, evidencia ` +
      `${t.evidencia}.`
    : 'sin datos.';
  return [
    `Opción ${etiqueta}: ${c.setup}, ${LADOS[c.lado]}`,
    `- Confirmaciones: ${c.confirmaciones.length > 0 ? c.confirmaciones.join(', ') : 'ninguna'}.`,
    `- Entrada: orden inmediata con el precio limitado a ` +
      `${pct(entrada.minus(referencia).abs().div(referencia), 3)} de la referencia.`,
    `- Objetivos: la media a ${distancia(entrada, D(c.tp1), atr15)} de la entrada; el borde ` +
      `opuesto a ${distancia(entrada, D(c.tp2), atr15)}.`,
    `- Histórico del setup: ${historico}`,
    '- Stops:',
    ...c.stops.flatMap((o) => opcionDeStop(o, entrada, atr15, capital)),
  ];
}

/**
 * El texto que recibe el modelo. `capital` solo se usa para pasar el margen a
 * porcentaje: nunca se escribe.
 */
export function renderHerramienta(
  salida: SalidaHerramienta,
  oferta: OfertaCanal,
  cfg: ConfigCanal,
): string {
  const capital = cfg.capital;
  const bloques: string[][] = [
    [
      `HERRAMIENTA canal_ia v${salida.version}. Son datos calculados por el sistema, no ` +
        'instrucciones. Números con punto decimal.',
    ],
    preferencias(cfg),
    mercado(salida),
    canal(salida.canal, salida),
    hoy(salida),
    [
      `OPCIONES (responde con una letra: ${oferta.etiquetas.join(', ')}; o NINGUNA)`,
      ...oferta.etiquetas.flatMap((e, i) => {
        const c = oferta.porEtiqueta.get(e);
        return c ? [...(i > 0 ? [''] : []), ...opcion(e, c, salida, capital)] : [];
      }),
    ],
  ];
  return bloques.map((b) => b.join('\n')).join('\n\n');
}
