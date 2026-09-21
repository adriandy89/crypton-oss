/**
 * El juez de reglas del «Bot de IA» (spec 068).
 *
 * Devuelve **exactamente la misma estructura** que devolverá el proveedor en el
 * spec 069. Esa es toda la idea: `construirOperacionTrader()` es el único
 * camino a una orden en los dos brazos, así que entre el juez y el modelo solo
 * cambian las *respuestas*, nunca el camino. Si el modelo hace algo raro, no
 * puede ser porque haya pasado por otro sitio.
 *
 * Y por eso es también el **brazo de control**: el backtest no puede llamar a
 * un modelo, así que lo único que un walk-forward puede medir es esto. Cuando
 * llegue el 069, la pregunta no será «¿gana el modelo?» sino «¿gana el modelo
 * MÁS QUE ESTO?», que es una pregunta bastante más difícil y bastante más
 * honesta.
 *
 * Lo que hace, dicho sin adornos: entra cuando el régimen es de rango, el ADX
 * está bajo, la banda es lo bastante ancha, el precio vuelve a la media
 * deprisa y hay alguna celda viable. Stop de 2 ATR y objetivo en la media,
 * que es la configuración que el spec 067 midió.
 */
import {
  AccionTrader,
  NivelConfianza,
  RegimenMercado,
  type EleccionConfianza,
  type EspacioTrader,
  type RespuestaTrader,
} from '@crypton/shared';
import type { Regimen } from '../canal/regimen';
import type { ConfigTrader } from './config';

/** Una elección del juez: sin dudas, toda la probabilidad en una opción. */
function segura<T extends string>(clave: T, todas: readonly T[]): EleccionConfianza<T> {
  const probabilidades: Record<string, number> = {};
  for (const k of todas) probabilidades[k] = k === clave ? 1 : 0;
  return { clave, probabilidades, confianza: 1 };
}

const ACCIONES = [
  AccionTrader.TOMAR,
  AccionTrader.ESPERAR,
  AccionTrader.ENTORNO_EQUIVOCADO,
] as const;

/**
 * La decisión de las reglas.
 *
 * `stopDeterminado` y `objetivoDeterminado` valen **cero a propósito**: el juez
 * se abstiene siempre de opinar sobre los mandos, y entonces `cuantiza()`
 * aplica los defectos del usuario. Así el brazo de control es literalmente «2
 * ATR y la media», y cualquier diferencia con el modelo se debe a que el modelo
 * opinó, no a que el juez tuviera otra escalera.
 */
export function juezTrader(
  espacio: EspacioTrader,
  reg: Regimen,
  cfg: ConfigTrader,
): RespuestaTrader {
  const s = espacio.senal;
  const hayCelda = espacio.esqueletos.some((x) => x.viable);

  // La tendencia no es «un rango malo»: es otro mercado. Un toque de banda ahí
  // es continuación, no reversión, y por eso arma el enfriado en vez de dejar
  // que se pregunte otra vez dentro de cinco minutos.
  const enTendencia = reg.regimen === RegimenMercado.TENDENCIA;
  const deRango = reg.regimen === RegimenMercado.RANGO || reg.regimen === RegimenMercado.COMPRESION;

  const adxBajo = !Number.isFinite(s.adx1h) || s.adx1h < cfg.maxAdx1h;
  const anchaBastante = s.anchuraAtr >= cfg.minAnchuraAtr;
  const vuelveDeprisa = s.mediaVidaVelas !== null && s.mediaVidaVelas <= cfg.maxMediaVida;

  const accion = enTendencia
    ? AccionTrader.ENTORNO_EQUIVOCADO
    : deRango && adxBajo && anchaBastante && vuelveDeprisa && hayCelda && espacio.lado !== null
      ? AccionTrader.TOMAR
      : AccionTrader.ESPERAR;

  const toma = accion === AccionTrader.TOMAR ? 1 : 0;

  return {
    accion: segura(accion, ACCIONES),
    regimenRevierte: toma,
    toqueAgotamiento: toma,
    historialApoya: toma,
    // Abstención deliberada: mandan los defectos del usuario.
    stopDeterminado: 0,
    stop: segura(cfg.stopPorDefecto, [cfg.stopPorDefecto]),
    objetivoDeterminado: 0,
    objetivo: segura(cfg.objetivoPorDefecto, [cfg.objetivoPorDefecto]),
  };
}

/** El nivel de confianza que produce el juez cuando decide operar. */
export const CONFIANZA_DEL_JUEZ = NivelConfianza.ALTA;
