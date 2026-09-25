/**
 * El juez de reglas del agente (spec 074): la elección determinista.
 *
 * Es el modo `REGLAS` —el agente decide sin pagar ninguna llamada— y la línea
 * base con la que se compara al modelo: en modo IA se guarda también lo que
 * habría elegido el juez, y la tarjeta enseña si el modelo lo mejora.
 *
 * Elige el primer puesto de la oferta que tenga una opción usable, con
 * preferencias prudentes para dinero real: stop NORMAL (o AMPLIO), la banda de
 * apalancamiento más baja y el objetivo escalonado. La banda no cambia lo que
 * se pierde en el stop; cambia el margen inmovilizado y la distancia a la
 * liquidación, y la baja es la que más la aleja.
 *
 * El juez no tiene una confianza que dar: dice ALTA para que la regla de la
 * confianza (`eleccionEfectiva`) no le parta el tamaño. El tamaño lo fijan los
 * límites, que ya están dentro de cada opción.
 */
import {
  BandaApalancamiento,
  ESQUEMA_DE_OBJETIVO,
  NivelConfianza,
  ObjetivoAgente,
  TamanoOperacion,
  TipoStop,
  type EleccionAgente,
  type SalidaAgente,
} from '@crypton/shared';
import { ofertaAgente } from './herramienta';

const STOPS: readonly TipoStop[] = [TipoStop.NORMAL, TipoStop.AMPLIO];
const OBJETIVOS: readonly ObjetivoAgente[] = [
  ObjetivoAgente.ESCALONADO,
  ObjetivoAgente.CERCANO,
  ObjetivoAgente.LEJANO,
];
const BANDAS: readonly BandaApalancamiento[] = [
  BandaApalancamiento.BAJA,
  BandaApalancamiento.MEDIA,
  BandaApalancamiento.ALTA,
];

/** Lo que elegiría el juez, o null si nada de la oferta se puede usar. */
export function juezAgente(salida: SalidaAgente): EleccionAgente | null {
  for (const { candidato } of ofertaAgente(salida)) {
    for (const stop of STOPS) {
      const opcion = candidato.stops.find((o) => o.tipo === stop);
      if (!opcion?.viable) continue;
      const objetivo = OBJETIVOS.find((x) =>
        opcion.esquemasViables.includes(ESQUEMA_DE_OBJETIVO[x]),
      );
      const banda = BANDAS.find((b) => opcion.bandas.some((x) => x.banda === b));
      if (!objetivo || !banda) continue;
      return {
        candidatoId: candidato.id,
        stop,
        objetivo,
        apalancamiento: banda,
        tamano: TamanoOperacion.COMPLETO,
        confianza: NivelConfianza.ALTA,
      };
    }
  }
  return null;
}
