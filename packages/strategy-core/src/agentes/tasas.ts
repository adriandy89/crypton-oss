/**
 * Tasas base de cada familia y lado en el histórico cargado del par (spec 074).
 *
 * Como las del canal (`canal/tasas-base.ts`): se recorre la serie como la
 * habría vivido el agente, con la misma detección causal, y cada señal se
 * etiqueta con la misma triple barrera pesimista —entrada al cierre de la
 * vela, stop NORMAL, primer objetivo y barrera de tiempo—, con costes.
 *
 * Es información para quien elige, no una puerta: el motor solo descarta un
 * candidato cuando la evidencia es de verdad y la esperanza negativa, como en
 * el canal.
 */
import { TipoStop, type FamiliaAgente, type TasasBase } from '@crypton/shared';
import type { Costes } from '../canal/costes';
import type { SerieNumerica } from '../canal/numeros';
import { etiquetarTripleBarrera, tasasDeResultados } from '../canal/tasas-base';
import { detectarFamilias } from './familias';
import type { IndicadoresAgente } from './mercado';

export interface ParametrosTasasAgente {
  familias: readonly FamiliaAgente[];
  lados: readonly ('LONG' | 'SHORT')[];
  costes: Costes;
  /** La barrera de tiempo, en velas del intervalo. */
  maxVelas: number;
}

export interface EtiquetaAgente {
  familia: FamiliaAgente;
  lado: 'LONG' | 'SHORT';
  indice: number;
  salida: number;
  resultado: 'OBJETIVO' | 'STOP' | 'TIEMPO';
  r: number;
}

/** Desde aquí la EMA de 50 y su pendiente ya tienen historia. */
const PRIMERA_VELA = 60;

export const claveTasasAgente = (familia: FamiliaAgente, lado: 'LONG' | 'SHORT'): string =>
  `${familia}|${lado}`;

/**
 * Las etiquetas del histórico. Las de una misma familia y lado no se solapan:
 * mientras una operación sigue abierta, el agente no abriría otra igual en el
 * par (una operación viva por par, R-20).
 */
export function etiquetasAgente(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  p: ParametrosTasasAgente,
): EtiquetaAgente[] {
  const out: EtiquetaAgente[] = [];
  const libreDesde = new Map<string, number>();
  for (let j = PRIMERA_VELA; j < s.n - 1; j++) {
    for (const d of detectarFamilias(s, ind, j, p.familias, p.lados)) {
      const clave = claveTasasAgente(d.familia, d.lado);
      if (j < (libreDesde.get(clave) ?? 0)) continue;
      const a = ind.atr[j];
      const distancia = d.stopsAtr[TipoStop.NORMAL] * a;
      const stop = d.lado === 'LONG' ? d.extremo - distancia : d.extremo + distancia;
      const e = etiquetarTripleBarrera(s, j, d.lado, s.c[j], stop, d.tp1, p.maxVelas, p.costes);
      if (!e) continue;
      out.push({
        familia: d.familia,
        lado: d.lado,
        indice: j,
        salida: e.salida,
        resultado: e.resultado,
        r: e.r,
      });
      libreDesde.set(clave, e.salida + 1);
    }
  }
  return out;
}

/** Las tasas por familia y lado (`claveTasasAgente`). */
export function tasasAgente(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  p: ParametrosTasasAgente,
): Map<string, TasasBase> {
  const grupos = new Map<string, number[]>();
  for (const e of etiquetasAgente(s, ind, p)) {
    const clave = claveTasasAgente(e.familia, e.lado);
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(e.r);
    else grupos.set(clave, [e.r]);
  }
  const out = new Map<string, TasasBase>();
  for (const [clave, rs] of grupos) {
    const t = tasasDeResultados(rs);
    if (t) out.set(clave, t);
  }
  return out;
}
