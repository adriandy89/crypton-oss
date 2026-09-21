/**
 * Canales: horizontales y inclinados, con puertas duras y puntuación (spec 058).
 *
 * Un canal no es «dos líneas que se pueden dibujar»; se pueden dibujar sobre
 * cualquier gráfico. Aquí solo lo es si pasa TODAS las puertas del plan:
 * - toques de verdad a los dos lados y alternados;
 * - el precio dentro casi siempre;
 * - una anchura que pague los costes;
 * - la duración suficiente;
 * - que el precio cruce la media;
 * - que revierta a ella deprisa;
 * - un toque reciente.
 *
 * Lo que no pasa se devuelve con su motivo, para que la nota del bot diga por
 * qué no opera.
 */
import { CalidadCanal, TipoCanal, type CanalDetectado } from '@crypton/shared';
import { bollinger, cambiosDeSigno, mediaVidaOU, olsParalelas } from './estadistica';
import type { SerieNumerica } from './numeros';
import type { Giro } from './swings';

export interface ParametrosCanal {
  /** Velas de 15 min en las que se busca el canal. */
  ventana: number;
  /** Coste de ida y vuelta en unidades de precio (comisiones, deslizamiento, spread). */
  costeIdaVuelta: number;
  tiposPermitidos: readonly TipoCanal[];
  /** Un cierre fuera del borde por más de esto (en ATR) invalida el canal. */
  invalidacionAtr: number;
}

export interface FalsoQuiebre {
  /** El lado de la operación que propone: por debajo del soporte, largo. */
  lado: 'LONG' | 'SHORT';
  /** El extremo de la ruptura, del que cuelga el stop. */
  extremo: number;
  /** La vela de 15 min que cerró fuera. */
  indice: number;
}

export interface CanalEvaluado {
  canal: CanalDetectado | null;
  /** Por qué no hay canal, si no lo hay. */
  motivos: string[];
  invalidado: boolean;
  falsoQuiebre: FalsoQuiebre | null;
}

/** Las dos líneas de un canal candidato, como funciones de la vela. */
interface Lineas {
  tipo: TipoCanal;
  soporteEn: (i: number) => number;
  resistenciaEn: (i: number) => number;
  pendiente: number;
  toquesSoporte: Giro[];
  toquesResistencia: Giro[];
  r2: number | null;
  motivos: string[];
}

// Umbrales de las puertas. Son del diseño, no de la configuración: aflojarlos
// cambia lo que el sistema entiende por «canal».
const MIN_TOQUES = 2;
const MIN_ALTERNANCIAS = 2;
const MIN_CONTENCION = 0.9;
const MIN_ANCHURA_ATR = 3;
const MAX_ANCHURA_ATR = 10;
/**
 * Anchura mínima del canal, en costes de ida y vuelta.
 *
 * Se probó a subirla a 30 (spec 066), con el razonamiento de que el objetivo es
 * la MEDIA del canal y por tanto la mitad de la anchura. Medido sobre datos
 * reales, ese 30 rechazaba **27.166 de 27.360 ticks**: la puerta se comía el
 * 99,3 % de los canales antes de que ninguna otra opinara. Se queda en 10 y la
 * selección la hace `minObjetivoCoste`, sobre el objetivo de la operación de
 * verdad, que es donde se midió que cambia el signo.
 */
const MIN_ANCHURA_COSTES = 10;
const MIN_DURACION = 30;
const MIN_CRUCES = 3;
const MAX_ULTIMO_TOQUE = 48;
const EPS_ATR = 0.25;
const MIN_R2 = 0.6;
const MAX_DESVIO_PENDIENTE = 0.25;
const MIN_GIROS_INCLINADO = 3;
/** Una pendiente que en toda la ventana no mueve medio ATR es un canal horizontal. */
const PENDIENTE_MINIMA_ATR = 0.5;
/** Una ruptura de más de esto (en ATR) no es falsa: el canal se acabó. */
const MAX_FALSO_QUIEBRE_ATR = 1;

/**
 * Periodo y desviaciones de la banda de Bollinger del canal `BANDA` (spec 067).
 *
 * 20 y 2 son los de toda la vida, y son los que se midieron: sobre 12 pares y
 * 190 días, el toque de banda con ADX < 20, stop a 2 ATR y objetivo en la media
 * dio n = 1.804 y t = 2,12. No se tocan sin volver a medir.
 */
const PERIODO_BANDA = 20;
const SIGMAS_BANDA = 2;
/**
 * Fracción de la anchura de la banda que cuenta como «estar en el borde».
 *
 * Una banda a dos sigmas es, por construcción, más ancha que el recorrido de
 * cualquier oscilación acotada: un seno de amplitud A tiene sigma 0,71·A, o sea
 * bandas a 1,41·A, que el precio **nunca** alcanza. Tocarla de verdad solo pasa
 * cuando la volatilidad se contrae y luego el precio da un salto raro.
 *
 * Por eso la regla que se midió no entraba EN la banda sino en el décimo
 * exterior de su anchura —%B ≤ 0,1 para el largo, ≥ 0,9 para el corto—, y eso
 * es lo que cuenta aquí como toque.
 */
export const DECIMO_BANDA = 0.1;

const media = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Un nivel como texto, sin el ruido de la coma flotante (98.95000000000002 → 98.95). */
export const nivelTexto = (x: number): string => String(Number(x.toPrecision(12)));

/**
 * El grupo más numeroso de giros a menos de `eps` entre sí, sembrado desde los
 * tres más recientes. A igualdad, el más reciente.
 */
function agrupar(giros: readonly Giro[], eps: number): Giro[] {
  let mejor: Giro[] = [];
  const recientes = [...giros].reverse();
  for (let s = 0; s < Math.min(3, recientes.length); s++) {
    const grupo = [recientes[s]];
    let centro = recientes[s].precio;
    for (let j = 0; j < recientes.length; j++) {
      if (j === s) continue;
      if (Math.abs(recientes[j].precio - centro) <= eps) {
        grupo.push(recientes[j]);
        centro = media(grupo.map((g) => g.precio));
      }
    }
    if (grupo.length > mejor.length) mejor = grupo;
  }
  return mejor.sort((a, b) => a.indice - b.indice);
}

function lineasHorizontales(altos: Giro[], bajos: Giro[], eps: number): Lineas | null {
  if (altos.length === 0 || bajos.length === 0) return null;
  const toquesResistencia = agrupar(altos, eps);
  const toquesSoporte = agrupar(bajos, eps);
  const r = media(toquesResistencia.map((g) => g.precio));
  const s = media(toquesSoporte.map((g) => g.precio));
  if (!(r > s)) return null;
  return {
    tipo: TipoCanal.HORIZONTAL,
    soporteEn: () => s,
    resistenciaEn: () => r,
    pendiente: 0,
    toquesSoporte,
    toquesResistencia,
    r2: null,
    motivos: [],
  };
}

function lineasInclinadas(
  altos: Giro[],
  bajos: Giro[],
  eps: number,
  atr: number,
  ventana: number,
): Lineas | null {
  if (altos.length < MIN_GIROS_INCLINADO || bajos.length < MIN_GIROS_INCLINADO) return null;
  const r = olsParalelas(
    altos.map((g) => g.indice),
    altos.map((g) => g.precio),
    bajos.map((g) => g.indice),
    bajos.map((g) => g.precio),
  );
  if (!r || !(r.ordenadaA > r.ordenadaB)) return null;
  const motivos: string[] = [];
  if (Math.abs(r.pendiente) * ventana < PENDIENTE_MINIMA_ATR * atr) motivos.push('PENDIENTE_PLANA');
  const tope = MAX_DESVIO_PENDIENTE * Math.abs(r.pendiente);
  if (
    Math.abs(r.propiaA - r.pendiente) > tope ||
    Math.abs(r.propiaB - r.pendiente) > tope ||
    Math.sign(r.propiaA) !== Math.sign(r.propiaB)
  ) {
    motivos.push('PARALELAS');
  }
  if (r.r2A < MIN_R2 || r.r2B < MIN_R2) motivos.push('R2');
  const resistenciaEn = (i: number) => r.ordenadaA + r.pendiente * i;
  const soporteEn = (i: number) => r.ordenadaB + r.pendiente * i;
  // Toques: los giros que quedan cerca de su línea.
  const cerca = (g: Giro, linea: (i: number) => number) =>
    Math.abs(g.precio - linea(g.indice)) <= 2 * eps;
  return {
    tipo: TipoCanal.INCLINADO,
    soporteEn,
    resistenciaEn,
    pendiente: r.pendiente,
    toquesSoporte: bajos.filter((g) => cerca(g, soporteEn)),
    toquesResistencia: altos.filter((g) => cerca(g, resistenciaEn)),
    r2: Math.min(r.r2A, r.r2B),
    motivos,
  };
}

/**
 * Las líneas de un canal de banda: Bollinger sobre los cierres (spec 067).
 *
 * La diferencia con las otras dos no es cosmética. Un borde trazado desde giros
 * es un precio que el mercado defendió de verdad; una banda es una frontera
 * estadística, que existe aunque nadie la haya respetado nunca. Por eso aquí un
 * «toque» no es un pivote confirmado sino una vela cuyo extremo llegó a la
 * banda, y por eso el stop de este tipo va más lejos (`ATR_POR_STOP`).
 *
 * Las tres puertas que NO le llegan —`PARALELAS`, `PENDIENTE_PLANA` y `R2`— son
 * las que comprueban que dos RECTAS ajustadas a giros son de verdad un canal.
 * Una banda no es una recta ajustada a nada, así que no hay nada que comprobar:
 * no se están aflojando, es que no se le pueden aplicar. Todas las demás
 * —contención, anchura en ATR, anchura en costes, toques, alternancia, cruces,
 * media vida, duración y recencia— se le aplican igual que a las otras.
 */
function lineasDeBanda(s: SerieNumerica, ventana: number): Lineas | null {
  if (s.n < PERIODO_BANDA + 2) return null;
  const bb = bollinger(s.c, PERIODO_BANDA, SIGMAS_BANDA);
  const ultima = s.n - 1;
  if (!Number.isFinite(bb.superior[ultima]) || !(bb.superior[ultima] > bb.inferior[ultima])) {
    return null;
  }
  // Fuera de la ventana con banda, se prolonga el valor del extremo más cercano:
  // `evaluar` mira desde el primer toque y `nivelesEn` proyecta hacia delante.
  const en = (v: Float64Array, i: number): number =>
    v[Math.max(PERIODO_BANDA - 1, Math.min(ultima, i))];
  const soporteEn = (i: number) => en(bb.inferior, i);
  const resistenciaEn = (i: number) => en(bb.superior, i);

  // Un toque es una vela cuyo extremo llegó a la banda. Se cuentan dentro de la
  // ventana pedida, igual que los giros de los otros dos tipos.
  const desde = Math.max(PERIODO_BANDA - 1, s.n - ventana);
  const toquesSoporte: Giro[] = [];
  const toquesResistencia: Giro[] = [];
  for (let i = desde; i <= ultima; i++) {
    const borde = DECIMO_BANDA * (resistenciaEn(i) - soporteEn(i));
    if (s.l[i] <= soporteEn(i) + borde) {
      toquesSoporte.push({ tipo: 'BAJO', indice: i, precio: s.l[i], confirmadoEn: i });
    }
    if (s.h[i] >= resistenciaEn(i) - borde) {
      toquesResistencia.push({ tipo: 'ALTO', indice: i, precio: s.h[i], confirmadoEn: i });
    }
  }

  // La pendiente es la de la media móvil en las últimas velas: es lo que
  // `nivelesEn` usa para proyectar los niveles más allá de `refT`.
  const atras = Math.min(PERIODO_BANDA, ultima - (PERIODO_BANDA - 1));
  const pendiente = atras > 0 ? (bb.media[ultima] - bb.media[ultima - atras]) / atras : 0;

  return {
    tipo: TipoCanal.BANDA,
    soporteEn,
    resistenciaEn,
    pendiente: Number.isFinite(pendiente) ? pendiente : 0,
    toquesSoporte,
    toquesResistencia,
    r2: null,
    motivos: [],
  };
}

/** Las puertas y la puntuación de unas líneas. */
/** La inicial del tipo abre el id del canal, que tiene que ser estable y corto. */
const INICIAL: Readonly<Record<TipoCanal, string>> = {
  [TipoCanal.HORIZONTAL]: 'H',
  [TipoCanal.INCLINADO]: 'I',
  [TipoCanal.BANDA]: 'B',
};

function evaluar(
  lineas: Lineas,
  s: SerieNumerica,
  atr: number,
  eps: number,
  costeIdaVuelta: number,
): { canal: CanalDetectado | null; motivos: string[] } {
  const motivos = [...lineas.motivos];
  const n = s.n;
  const ultima = n - 1;
  const { toquesSoporte, toquesResistencia } = lineas;
  if (toquesSoporte.length < MIN_TOQUES || toquesResistencia.length < MIN_TOQUES) {
    motivos.push('TOQUES');
  }
  const toques = [
    ...toquesSoporte.map((g) => ({ g, lado: 'S' as const })),
    ...toquesResistencia.map((g) => ({ g, lado: 'R' as const })),
  ].sort((a, b) => a.g.indice - b.g.indice);
  if (toques.length === 0) return { canal: null, motivos: [...motivos, 'TOQUES'] };

  let alternancias = 0;
  for (let i = 1; i < toques.length; i++) if (toques[i].lado !== toques[i - 1].lado) alternancias++;
  if (alternancias < MIN_ALTERNANCIAS) motivos.push('ALTERNANCIA');

  const primero = toques[0].g.indice;
  const duracion = ultima - primero;
  if (duracion < MIN_DURACION) motivos.push('DURACION');
  const ultimoToqueHace = ultima - toques[toques.length - 1].g.indice;
  if (ultimoToqueHace > MAX_ULTIMO_TOQUE) motivos.push('RECENCIA');

  let dentro = 0;
  const residuos: number[] = [];
  for (let i = primero; i <= ultima; i++) {
    const sop = lineas.soporteEn(i);
    const res = lineas.resistenciaEn(i);
    if (s.c[i] >= sop - eps && s.c[i] <= res + eps) dentro++;
    residuos.push(s.c[i] - (sop + res) / 2);
  }
  const contencion = dentro / (ultima - primero + 1);
  if (contencion < MIN_CONTENCION) motivos.push('CONTENCION');

  const cruces = cambiosDeSigno(residuos);
  if (cruces < MIN_CRUCES) motivos.push('CRUCES');
  const mediaVida = mediaVidaOU(residuos);
  if (mediaVida === null || mediaVida > duracion / 4) motivos.push('MEDIA_VIDA');

  const soporte = lineas.soporteEn(ultima);
  const resistencia = lineas.resistenciaEn(ultima);
  const anchura = resistencia - soporte;
  const anchuraAtr = atr > 0 ? anchura / atr : 0;
  if (anchuraAtr < MIN_ANCHURA_ATR || anchuraAtr > MAX_ANCHURA_ATR) motivos.push('ANCHURA_ATR');
  if (anchura < MIN_ANCHURA_COSTES * costeIdaVuelta) motivos.push('ANCHURA_COSTE');

  if (motivos.length > 0) return { canal: null, motivos };

  const puntuacion = puntuar({
    toques: toques.length,
    contencion,
    anchuraAtr,
    mediaVida: mediaVida ?? duracion,
    duracion,
    alternancias,
    ultimoToqueHace,
    r2: lineas.r2,
  });
  const calidad = calidadDe(puntuacion);
  if (!calidad) return { canal: null, motivos: ['PUNTUACION'] };

  return {
    canal: {
      id: INICIAL[lineas.tipo] + String(s.t[primero]),
      tipo: lineas.tipo,
      calidad,
      puntuacion,
      soporte: nivelTexto(soporte),
      resistencia: nivelTexto(resistencia),
      media: nivelTexto((soporte + resistencia) / 2),
      pendientePorVela: lineas.pendiente,
      refT: s.t[ultima],
      anchuraAtr,
      toquesSoporte: toquesSoporte.length,
      toquesResistencia: toquesResistencia.length,
      contencion,
      cruces,
      mediaVidaVelas: mediaVida,
      duracionVelas: duracion,
      ultimoToqueHace,
      r2: lineas.r2,
    },
    motivos: [],
  };
}

/**
 * Puntuación de 0 a 100 de un canal que ya pasó las puertas. Reparto:
 * - toques: 20;
 * - contención: 20;
 * - anchura en ATR, con el óptimo entre 4 y 7: 15;
 * - media vida: 15;
 * - alternancia: 10;
 * - recencia: 10;
 * - R²: 10 (el horizontal los suma fijos).
 */
export function puntuar(x: {
  toques: number;
  contencion: number;
  anchuraAtr: number;
  mediaVida: number;
  duracion: number;
  alternancias: number;
  ultimoToqueHace: number;
  r2: number | null;
}): number {
  const acotar = (v: number) => Math.max(0, Math.min(1, v));
  const toques = 20 * acotar((x.toques - 4) / 4 + 0.5);
  const contencion = 20 * acotar((x.contencion - MIN_CONTENCION) / (1 - MIN_CONTENCION));
  const fuera = x.anchuraAtr < 4 ? 4 - x.anchuraAtr : x.anchuraAtr > 7 ? x.anchuraAtr - 7 : 0;
  const anchura = 15 * acotar(1 - fuera / 3);
  const mediaVida = 15 * acotar(1 - x.mediaVida / Math.max(1, x.duracion / 4));
  const alternancia = 10 * acotar(x.alternancias / 5);
  const recencia = 10 * acotar(1 - x.ultimoToqueHace / MAX_ULTIMO_TOQUE);
  const r2 = x.r2 === null ? 10 : 10 * acotar((x.r2 - MIN_R2) / (1 - MIN_R2));
  return Math.round(toques + contencion + anchura + mediaVida + alternancia + recencia + r2);
}

export function calidadDe(puntuacion: number): CalidadCanal | null {
  if (puntuacion >= 75) return CalidadCanal.A;
  if (puntuacion >= 60) return CalidadCanal.B;
  if (puntuacion >= 45) return CalidadCanal.C;
  return null;
}

/** ¿Pasa `calidad` el mínimo pedido? A es mejor que B, y B que C. */
export function calidadSuficiente(calidad: CalidadCanal, minima: CalidadCanal): boolean {
  const orden: Record<CalidadCanal, number> = { A: 3, B: 2, C: 1 };
  return orden[calidad] >= orden[minima];
}

/**
 * El canal de la serie de 15 min, si lo hay, con su invalidación y su falso
 * quiebre.
 *
 * `giros` son los de la serie ENTERA; aquí se usan los que caen en la ventana.
 * `atr` es el ATR(15m) de la última vela.
 */
export function detectarCanal(
  s: SerieNumerica,
  giros: readonly Giro[],
  atr: number,
  p: ParametrosCanal,
): CanalEvaluado {
  const vacio = (motivos: string[]): CanalEvaluado => ({
    canal: null,
    motivos,
    invalidado: false,
    falsoQuiebre: null,
  });
  if (s.n < MIN_DURACION + 1 || !(atr > 0)) return vacio(['DATOS']);

  const desde = Math.max(0, s.n - p.ventana);
  const enVentana = giros.filter((g) => g.indice >= desde);
  const altos = enVentana.filter((g) => g.tipo === 'ALTO');
  const bajos = enVentana.filter((g) => g.tipo === 'BAJO');
  const eps = EPS_ATR * atr;

  const candidatos: { canal: CanalDetectado | null; motivos: string[]; lineas: Lineas }[] = [];
  if (p.tiposPermitidos.includes(TipoCanal.HORIZONTAL)) {
    const l = lineasHorizontales(altos, bajos, eps);
    if (l) candidatos.push({ ...evaluar(l, s, atr, eps, p.costeIdaVuelta), lineas: l });
  }
  if (p.tiposPermitidos.includes(TipoCanal.INCLINADO)) {
    const l = lineasInclinadas(altos, bajos, eps, atr, p.ventana);
    if (l) candidatos.push({ ...evaluar(l, s, atr, eps, p.costeIdaVuelta), lineas: l });
  }
  if (p.tiposPermitidos.includes(TipoCanal.BANDA)) {
    const l = lineasDeBanda(s, p.ventana);
    if (l) candidatos.push({ ...evaluar(l, s, atr, eps, p.costeIdaVuelta), lineas: l });
  }
  const validos = candidatos.filter((c) => c.canal !== null);
  if (validos.length === 0) {
    const motivos = [...new Set(candidatos.flatMap((c) => c.motivos))];
    return vacio(motivos.length > 0 ? motivos : ['SIN_GIROS']);
  }
  validos.sort((a, b) => b.canal!.puntuacion - a.canal!.puntuacion);
  const elegido = validos[0];

  // Invalidación y falso quiebre, con las líneas en cada vela.
  const ultima = s.n - 1;
  const fuera = (i: number): number => {
    const sop = elegido.lineas.soporteEn(i);
    const res = elegido.lineas.resistenciaEn(i);
    if (s.c[i] > res) return (s.c[i] - res) / atr;
    if (s.c[i] < sop) return -(sop - s.c[i]) / atr;
    return 0;
  };
  const ahora = fuera(ultima);
  if (Math.abs(ahora) > p.invalidacionAtr) {
    return { canal: null, motivos: ['INVALIDADO'], invalidado: true, falsoQuiebre: null };
  }
  let falsoQuiebre: FalsoQuiebre | null = null;
  for (const k of [ultima - 1, ultima - 2]) {
    if (k < 0) continue;
    const f = fuera(k);
    if (Math.abs(f) >= MAX_FALSO_QUIEBRE_ATR) {
      // Una ruptura de verdad, aunque el precio haya vuelto: el canal se acabó.
      return { canal: null, motivos: ['INVALIDADO'], invalidado: true, falsoQuiebre: null };
    }
    if (f !== 0 && ahora === 0 && !falsoQuiebre) {
      const lado = f < 0 ? 'LONG' : 'SHORT';
      let extremo = lado === 'LONG' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      for (let j = k; j <= ultima; j++) {
        extremo = lado === 'LONG' ? Math.min(extremo, s.l[j]) : Math.max(extremo, s.h[j]);
      }
      falsoQuiebre = { lado, extremo, indice: k };
    }
  }
  return { canal: elegido.canal, motivos: [], invalidado: false, falsoQuiebre };
}

/**
 * Los niveles del canal en un instante posterior a su referencia: en un
 * inclinado, las líneas se desplazan con cada vela de 15 min.
 */
export function nivelesEn(
  canal: { soporte: string; resistencia: string; pendientePorVela: number; refT: number },
  t: number,
): { soporte: number; resistencia: number; media: number } {
  const velas = (t - canal.refT) / 900_000;
  const desplazamiento = canal.pendientePorVela * velas;
  const soporte = Number(canal.soporte) + desplazamiento;
  const resistencia = Number(canal.resistencia) + desplazamiento;
  return { soporte, resistencia, media: (soporte + resistencia) / 2 };
}
