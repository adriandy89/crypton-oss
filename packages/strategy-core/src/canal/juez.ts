/**
 * El juez de reglas: la elección determinista (spec 058).
 *
 * Es el modo `REGLAS` y lo que usa el backtest en lugar de la IA. Elige entre
 * lo que la herramienta ofrece, con las preferencias del perfil:
 *
 * | Perfil      | Stop     | Apalancamiento | Objetivo   |
 * |-------------|----------|----------------|------------|
 * | PRUDENTE    | AMPLIO   | BAJA           | MEDIA      |
 * | EQUILIBRADA | NORMAL   | MEDIA          | ESCALONADO |
 * | AGRESIVA    | AJUSTADO | ALTA           | ESCALONADO |
 *
 * Si lo preferido no está disponible, prueba lo contiguo hacia lo prudente,
 * nunca hacia lo arriesgado. Entre candidatos, el de mayor R.
 *
 * El perfil ordena preferencias; los límites ya los puso la herramienta.
 */
import {
  BandaApalancamiento,
  CalidadCanal,
  EsquemaObjetivo,
  NivelConfianza,
  PerfilCanal,
  TamanoOperacion,
  TipoStop,
  Veredicto,
  type CandidatoOperacion,
  type EleccionOperacion,
  type OpcionStop,
  type SalidaHerramienta,
} from '@crypton/shared';
import type { ConfigCanal } from './config';
import { esElegible } from './herramienta';

interface Preferencias {
  stops: readonly TipoStop[];
  banda: BandaApalancamiento;
  objetivos: readonly EsquemaObjetivo[];
}

export const PREFERENCIAS: Readonly<Record<PerfilCanal, Preferencias>> = {
  [PerfilCanal.PRUDENTE]: {
    stops: [TipoStop.AMPLIO],
    banda: BandaApalancamiento.BAJA,
    objetivos: [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO],
  },
  [PerfilCanal.EQUILIBRADA]: {
    stops: [TipoStop.NORMAL, TipoStop.AMPLIO],
    banda: BandaApalancamiento.MEDIA,
    objetivos: [EsquemaObjetivo.ESCALONADO, EsquemaObjetivo.MEDIA],
  },
  [PerfilCanal.AGRESIVA]: {
    stops: [TipoStop.AJUSTADO, TipoStop.NORMAL, TipoStop.AMPLIO],
    banda: BandaApalancamiento.ALTA,
    // El opuesto solo paga su R cuando la media no llega: es lo último.
    objetivos: [EsquemaObjetivo.ESCALONADO, EsquemaObjetivo.MEDIA, EsquemaObjetivo.OPUESTO],
  },
};

interface Eleccion {
  candidato: CandidatoOperacion;
  opcion: OpcionStop;
  objetivo: EsquemaObjetivo;
  r: number;
}

/** El R con el que se compara: el del objetivo más corto que se usa. */
const rDe = (o: OpcionStop, objetivo: EsquemaObjetivo): number =>
  (objetivo === EsquemaObjetivo.OPUESTO ? o.rNetoTp2 : o.rNetoTp1) ?? Number.NEGATIVE_INFINITY;

function elegirEn(
  c: CandidatoOperacion,
  pref: Preferencias,
  objetivos: readonly EsquemaObjetivo[],
): Eleccion | null {
  for (const tipo of pref.stops) {
    const opcion = c.stops.find((o) => o.tipo === tipo);
    if (!opcion?.viable) continue;
    const objetivo = objetivos.find((x) => opcion.esquemasViables.includes(x));
    if (objetivo) return { candidato: c, opcion, objetivo, r: rDe(opcion, objetivo) };
  }
  return null;
}

export function juezDeReglas(salida: SalidaHerramienta, cfg: ConfigCanal): EleccionOperacion {
  const pref = PREFERENCIAS[cfg.perfil];
  // Si el usuario dejó un único esquema, ese es el que se usa, sea cual sea el
  // perfil: el perfil ordena, no prohíbe lo único permitido.
  const objetivos = cfg.esquemas.length === 1 ? cfg.esquemas : pref.objetivos;
  let mejor: Eleccion | null = null;
  for (const c of salida.candidatos) {
    if (!esElegible(c)) continue;
    const e = elegirEn(c, pref, objetivos);
    if (e && (!mejor || e.r > mejor.r)) mejor = e;
  }
  if (!mejor) {
    return {
      veredicto: Veredicto.NO_OPERAR,
      opcion: 'NINGUNA',
      stop: pref.stops[0],
      objetivo: objetivos[0],
      apalancamiento: pref.banda,
      tamano: TamanoOperacion.COMPLETO,
      confianza: NivelConfianza.BAJA,
    };
  }
  return {
    veredicto: Veredicto.OPERAR,
    opcion: mejor.candidato.id,
    stop: mejor.opcion.tipo,
    objetivo: mejor.objetivo,
    apalancamiento: pref.banda,
    tamano: TamanoOperacion.COMPLETO,
    // Solo informativa: el modo reglas no filtra por confianza.
    confianza:
      salida.canal?.calidad === CalidadCanal.A ? NivelConfianza.ALTA : NivelConfianza.MEDIA,
  };
}
