import { Mutability, type BotConfig, type FieldMeta, type MarketSpec } from '@crypton/shared';
import {
  camposEfectivos,
  diffConfig,
  type ConfigDiff,
  type Strategy,
} from '@crypton/strategy-core';
import { buildConfig, shiftBand, type Band, type BuildContext, type Knobs } from '../advisor/build';
import { coerceConfig, enforceCouplings, MAX_SAFE_LEVERAGE } from '../advisor/sanitize';

/**
 * De lo que dice el modelo a una configuracion que se le puede aplicar a un bot
 * que tiene dinero dentro.
 *
 * Todo este fichero es PURO y sin dependencias de Nest, como `sanitize.ts`: es
 * la barandilla que separa «una sugerencia» de «un cambio en un bot vivo», y se
 * prueba sola, sin levantar la API.
 *
 * El reparto de responsabilidades es el mismo que en el asesor, con una vuelta
 * mas de tuerca. Alli el modelo elige PERILLAS y un generador determinista las
 * convierte en parametros; aqui el modelo elige DESPLAZAMIENTOS sobre las
 * perillas que el bot ya tiene, y hay tres razones:
 *
 *   1. `buildConfig` no es invertible. La configuracion de un bot que lleva tres
 *      semanas —tocada a mano, reparada por acoplamientos, ajustada al capital—
 *      no dice con que perillas nacio. Por eso las perillas de referencia se
 *      GUARDAN (`bot_ai_settings.knobs`) y el modelo las mueve.
 *   2. Un desplazamiento acotado a dos posiciones es una cota dura de conducta.
 *      Con perillas absolutas, un modelo confundido puede pedir el maximo de
 *      todo en una sola revision; asi, como mucho, se mueve dos escalones.
 *   3. **El perfil no se desplaza**, y eso resuelve de raiz el problema mas feo.
 *      `buildConfig` deriva del perfil campos que definen QUE CLASE DE BOT es:
 *      `limitAction` sale `CLOSE_ALL` con perfil prudente y `PAUSE_ENTRIES` con
 *      cualquier otro, es decir, la diferencia entre «deja de entrar al llegar
 *      al limite» y «cierra la posicion». Y como es HOT, ningun filtro de
 *      mutabilidad lo protegeria. Con el perfil congelado son estables por
 *      construccion, y hay un test que lo comprueba campo a campo.
 */

/** Lo que el modelo puede pedir sobre cada perilla. */
export const MOVIMIENTOS = ['MUCHO_MENOS', 'MENOS', 'IGUAL', 'MAS', 'MUCHO_MAS'] as const;
export type Movimiento = (typeof MOVIMIENTOS)[number];

/** Cuantas posiciones mueve cada uno. */
const PASOS: Record<Movimiento, number> = {
  MUCHO_MENOS: -2,
  MENOS: -1,
  IGUAL: 0,
  MAS: 1,
  MUCHO_MAS: 2,
};

/** Las cinco perillas que el modelo puede mover. El perfil NO esta, a proposito. */
export type Desplazamientos = Record<
  'leverage' | 'coverage' | 'spread' | 'sizeGrowth' | 'cadence',
  Movimiento
>;

export const SIN_MOVIMIENTO: Desplazamientos = {
  leverage: 'IGUAL',
  coverage: 'IGUAL',
  spread: 'IGUAL',
  sizeGrowth: 'IGUAL',
  cadence: 'IGUAL',
};

/**
 * Aplica los desplazamientos a las perillas. El perfil viaja intacto.
 *
 * `shiftBand` acota en los extremos, asi que pedir `MUCHO_MAS` sobre una perilla
 * que ya esta al maximo no la saca de la escala: la deja donde estaba.
 */
export function aplicarDesplazamientos(knobs: Knobs, d: Desplazamientos): Knobs {
  const mover = (b: Band, m: Movimiento): Band => shiftBand(b, PASOS[m]);
  return {
    profile: knobs.profile,
    leverage: mover(knobs.leverage, d.leverage),
    coverage: mover(knobs.coverage, d.coverage),
    spread: mover(knobs.spread, d.spread),
    sizeGrowth: mover(knobs.sizeGrowth, d.sizeGrowth),
    cadence: mover(knobs.cadence, d.cadence),
  };
}

/**
 * Con inventario abierto, solo se honra lo que BAJA el riesgo.
 *
 * El criterio es el mismo que gobierna `enforceCouplings` —se repara siempre
 * hacia menos riesgo— y aqui importa mas todavia: con escalones ya ejecutados
 * hay dinero comprometido en el mercado, y subir el apalancamiento o recortar la
 * cobertura de una escalera a medio tender acerca la liquidacion de una posicion
 * que ya existe.
 *
 * Que significa «menos riesgo» en cada perilla:
 *   - `leverage` y `sizeGrowth`: menos es menos.
 *   - `coverage`: MAS es menos riesgo. Cubrir mas recorrido adverso es
 *     exactamente aguantar mas antes de quedarse sin escalera.
 *   - `spread`: no toca riesgo de ruina, asi que se deja pasar.
 *   - `cadence`: tampoco.
 */
export function recortarConInventario(d: Desplazamientos): Desplazamientos {
  const soloBaja = (m: Movimiento): Movimiento => (PASOS[m] < 0 ? m : 'IGUAL');
  const soloSube = (m: Movimiento): Movimiento => (PASOS[m] > 0 ? m : 'IGUAL');
  return {
    leverage: soloBaja(d.leverage),
    sizeGrowth: soloBaja(d.sizeGrowth),
    coverage: soloSube(d.coverage),
    spread: d.spread,
    cadence: d.cadence,
  };
}

/**
 * Campos que NO se tocan jamas, pase lo que pase.
 *
 * Los cuatro los escribe `buildConfig` incondicionalmente (ver el final de
 * `buildConfig`, donde pone `direction` y `totalInvestment` sobre lo que devuelva
 * cada generador), y ninguno es asunto del supervisor:
 *
 *   - `exchangeAccountId` y `symbol` son COLD y los pone el formulario.
 *   - `direction` es COLD de facto: un bot que cambia de lado es otro bot.
 *   - `totalInvestment` es el dinero del usuario. La doctrina de `prompt.ts` es
 *     literal: proponer un importe en USDC «seria dejarle decidir cuanto
 *     arriesga alguien». No lo decide ni por desplazamiento.
 */
const INTOCABLES = ['exchangeAccountId', 'symbol', 'direction', 'totalInvestment'] as const;

/**
 * Funde lo generado sobre lo vigente, conservando todo lo que no se puede tocar.
 *
 * Se parte de la configuracion VIGENTE y no de la generada, y ese orden es la
 * pieza clave del fichero: la del bot es la verdad —lleva sus ajustes a mano y
 * sus reparaciones— y la generada es solo una propuesta. Al reves, un campo que
 * `buildConfig` no produjera se perderia en silencio.
 *
 * Solo se pisan campos que cumplan las tres condiciones: estar en el descriptor
 * EFECTIVO (los campos activos dependen de la config y del mercado, asi que no
 * vale `meta.fields` en crudo), no ser COLD, y haber sido producidos por el
 * generador.
 *
 * Un campo que la estrategia no declara se trata como COLD, que es la misma
 * regla conservadora de `diffConfig`: antes conservar un valor desconocido que
 * pisarlo a ciegas sobre un bot con dinero dentro.
 */
export function fusionarConservandoInmutables(
  strategy: Strategy<BotConfig>,
  vigente: BotConfig,
  generada: Record<string, unknown>,
  market: MarketSpec,
): Record<string, unknown> {
  const base = vigente as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };

  const campos: readonly FieldMeta[] = camposEfectivos(strategy.meta.fields, vigente, market);

  for (const campo of campos) {
    if (campo.mutability === Mutability.COLD) continue;
    if (!(campo.key in generada)) continue;
    out[campo.key] = generada[campo.key];
  }

  // Y los cuatro de siempre, por encima de todo lo demas. Se refijan aunque la
  // vuelta anterior no deberia haberlos tocado: cuesta cuatro asignaciones y
  // cierra la puerta a que un descriptor mal marcado los deje pasar.
  for (const clave of INTOCABLES) out[clave] = base[clave];

  return out;
}

/**
 * Lo que cambia entre dos generaciones: el efecto REAL del desplazamiento.
 *
 * Es lo que permite ajustar un bot sin reescribirlo. Un bot que lleva semanas
 * tiene la configuracion que su dueño dejo, no la que `buildConfig` produciria
 * hoy; regenerarla entera cambiaria decenas de campos que nadie pidio, y el
 * usuario veria «el supervisor te ha cambiado veinte cosas» cuando lo unico que
 * decidio el modelo fue «cotiza un poco mas ancho».
 *
 * La comparacion es laxa a proposito, como `sameValue` de `diffConfig`: los
 * generadores emiten cadenas para unos campos y numeros para otros, y '20' y 20
 * son el mismo valor.
 */
function soloLoQueCambia(
  antes: Record<string, unknown>,
  despues: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(despues)) {
    if (!igual(antes[clave], valor)) out[clave] = valor;
  }
  return out;
}

function igual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  // Ultimo escalon, con null y numeros ya descartados arriba: lo que queda de lo
  // que emite un generador son cadenas y enumerados. Mismo razonamiento —y misma
  // excepcion— que `sameValue` en `strategy-core/mutability.ts`.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(a) === String(b);
}

/** Por que no se propone nada. Alimenta la fila de la decision y el aviso. */
export type MotivoDescarte =
  'SIN_CAMBIOS' | 'COLD' | 'RESHAPE' | 'VALIDACION' | 'VENUE' | 'DEMASIADOS_CAMPOS';

export interface CambioPropuesto {
  config: BotConfig;
  level: 'HOT' | 'WARM';
  diff: ConfigDiff;
  knobs: Knobs;
}

export interface EntradaDeCambio {
  strategy: Strategy<BotConfig>;
  vigente: BotConfig;
  knobs: Knobs;
  ajustes: Desplazamientos;
  ctx: BuildContext;
  refPrice: string;
  /** Escalones ya ejecutados del ciclo abierto. */
  inventario: number;
  /** false = solo se aceptan cambios HOT; un WARM se descarta entero. */
  permitirWarm: boolean;
}

/**
 * Cuantos campos puede mover una sola revision.
 *
 * Cuatro. Mas que eso deja de ser un ajuste y es otro bot, y ademas hace
 * imposible atribuir el resultado: si el supervisor cambia diez cosas a la vez y
 * el bot empeora, no hay forma de saber cual fue.
 */
export const MAX_CAMPOS_POR_CAMBIO = 4;

/**
 * Cuatro, y la cifra sale de medir.
 *
 * Un desplazamiento aislado mueve entre cero y cinco campos segun la estrategia
 * y la perilla: el diferencial de un market maker V2 toca cinco —las dos
 * distancias, el minimo, el multiplicador de volatilidad y el de capas—, y el de
 * la estrategia de tendencia toca uno. Con el tope en cuatro, ese caso concreto
 * se descarta y los demas pasan, que es el reparto que se quiere: dos perillas
 * movidas a la vez ya no es un ajuste, es otro bot.
 *
 * Ojo con subirlo «porque se descartan cosas»: lo que de verdad hacia que se
 * descartara TODO era regenerar la configuracion entera en vez de aplicar el
 * delta, y eso ya esta resuelto en `decidirCambio`.
 */

/**
 * La cadena entera, de desplazamientos a configuracion aplicable.
 *
 * Devuelve el cambio, o el MOTIVO por el que no hay ninguno — que es lo que
 * luego permite decirle al usuario la causa real en vez de callar.
 *
 * **No se reintenta con otros desplazamientos.** Es la misma decision que toma
 * `AdvisorService.materialize`: se repara lo que es aritmetica entre parametros
 * y se descarta lo demas, porque insistir sobre un validador que no converge es
 * como se llega al tiempo de espera.
 */
export function decidirCambio(input: EntradaDeCambio): CambioPropuesto | MotivoDescarte {
  const { strategy, vigente, ctx, refPrice, inventario } = input;
  const market = ctx.market;

  // 1. Con inventario abierto solo se honra lo que baja el riesgo.
  const ajustes = inventario > 0 ? recortarConInventario(input.ajustes) : input.ajustes;
  const knobs = aplicarDesplazamientos(input.knobs, ajustes);

  // 2. El generador determinista, DOS VECES: con las perillas de antes y con las
  //    de despues. El capital sale del bot vivo, nunca del modelo.
  //
  //    Dos veces y no una porque lo que hay que aplicar es el DELTA, no la
  //    configuracion regenerada. Un bot que su dueño ajusto a mano —y eso es lo
  //    normal en un bot que lleva semanas— no se parece a lo que `buildConfig`
  //    produciria hoy, asi que pisarlo entero cambiaria veinte campos que nadie
  //    pidio y el cambio moriria en `DEMASIADOS_CAMPOS` siempre. Comparando las
  //    dos generaciones sale exactamente lo que el desplazamiento significa, y
  //    todo lo demas del bot se queda como su dueño lo dejo.
  const ctxCapital = {
    ...ctx,
    totalInvestment: Number(vigente.totalInvestment ?? ctx.totalInvestment),
  };
  const antes = buildConfig(strategy.kind, input.knobs, ctxCapital);
  const despues = buildConfig(strategy.kind, knobs, ctxCapital);
  const delta = soloLoQueCambia(antes, despues);

  // 3. La fusion: lo vigente manda salvo en los campos mutables que el
  //    desplazamiento de verdad mueve.
  let config = fusionarConservandoInmutables(strategy, vigente, delta, market);

  // 4. Recorte al descriptor, con lo VIGENTE de base y no `strategy.defaults()`:
  //    aqui no se esta creando un bot, se esta ajustando uno que ya existe.
  config = coerceConfig(strategy.meta.fields, vigente, config);

  // 5. Los acoplamientos que ninguna validacion deduce de un campo aislado.
  config = enforceCouplings(strategy.kind, config, market, ctx.maxLeverageUsuario);

  // 6. Y la fusion OTRA VEZ. `enforceCouplings` puede tocar campos que en alguna
  //    estrategia son COLD —`numLimitBuys` lo es en varias—, y reparar primero y
  //    volver a fijar despues sale mas barato que razonar sobre que repara que.
  config = fusionarConservandoInmutables(strategy, vigente, config, market);

  // 7. El tope propio del supervisor: una revision no sube el apalancamiento mas
  //    de un punto. Bajarlo es libre. Sin esto, dos revisiones seguidas pueden
  //    llevar a un bot de 2x a 10x sin que nadie mire.
  //
  //    En la practica casi nunca llega a actuar, y conviene saber por que: en un
  //    market maker el apalancamiento entra en el tamaño por orden y en los tres
  //    topes de inventario, asi que moverlo arrastra cinco campos y el cambio se
  //    descarta antes por `DEMASIADOS_CAMPOS`. Se queda igualmente, porque las
  //    estrategias direccionales SI pueden moverlo con pocos campos y porque una
  //    barandilla que depende del orden de otra no es una barandilla.
  config = conTopeDeApalancamiento(config, vigente, market, ctx.maxLeverageUsuario);

  // 8. El stop loss solo se ESTRECHA. Ensancharlo o apagarlo es exactamente lo
  //    que nadie quiere que haga un proceso automatico de madrugada.
  config = conStopQueSoloSeEstrecha(config, vigente);

  const paraValidar = config as unknown as BotConfig;

  // 9. La validacion de la estrategia decide. Un solo ERROR y se descarta.
  if (!strategy.validate(paraValidar, market).ok) return 'VALIDACION';

  // 10. El preview es lo UNICO que detecta violaciones de tick, paso y notional
  //     minimo del venue: sin el, una configuracion «valida» produce ordenes que
  //     el exchange rechaza una a una.
  try {
    const preview = strategy.preview(paraValidar, market, refPrice);
    if (!preview.valid || preview.levels.some((l) => l.violations.length > 0)) return 'VENUE';
  } catch {
    return 'VENUE';
  }

  // 11. Y lo que de verdad decide si esto se puede aplicar a un bot vivo.
  const diff = diffConfig(strategy, vigente, paraValidar);
  if (diff.level === 'NONE') return 'SIN_CAMBIOS';
  if (diff.level === 'COLD') return 'COLD';
  if (diff.level === 'WARM' && !input.permitirWarm) return 'RESHAPE';
  if (diff.changed.length > MAX_CAMPOS_POR_CAMBIO) return 'DEMASIADOS_CAMPOS';

  // 12. Un campo que redibuja la escalera con escalones ya ejecutados deja la
  //     salida de lo comprado en una linea que ya no existe (001/F-90). La API
  //     lo rechaza con 409; se descarta aqui para no gastar el viaje y para
  //     poder decir el motivo.
  if (inventario > 0 && redibuja(strategy, diff)) return 'RESHAPE';

  return { config: paraValidar, level: diff.level, diff, knobs };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * El apalancamiento sube como mucho un punto por revision; bajar es libre.
 *
 * Los topes absolutos ya los impone `enforceCouplings` (el menor de
 * `MAX_SAFE_LEVERAGE`, el del venue y el del usuario). Lo que anade esto es una
 * cota al SALTO: sin ella, dos revisiones seguidas con la banda al alza llevan un
 * bot de 2x a 10x sin que nadie haya mirado, y cada punto de apalancamiento
 * acerca la liquidacion de una posicion que ya existe.
 */
export function conTopeDeApalancamiento(
  config: Record<string, unknown>,
  vigente: BotConfig,
  market: MarketSpec,
  maxLeverageUsuario: number | null,
): Record<string, unknown> {
  const actual = num((vigente as unknown as Record<string, unknown>)['leverage']) ?? 1;
  const pedido = num(config['leverage']) ?? actual;
  if (pedido <= actual) return config;

  const topes = [actual + 1, MAX_SAFE_LEVERAGE, market.maxLeverage];
  if (maxLeverageUsuario != null) topes.push(maxLeverageUsuario);
  return { ...config, leverage: Math.max(1, Math.floor(Math.min(pedido, ...topes))) };
}

/**
 * El stop loss solo se estrecha.
 *
 * Un porcentaje menor es un stop mas cerca, es decir, menos perdida maxima. Lo
 * que no puede hacer un proceso automatico es ensancharlo —dejar correr mas la
 * perdida— ni, mucho menos, quitarlo: el stop es una orden condicional NATIVA
 * del venue que sobrevive a que el worker muera, y es lo unico que protege a la
 * posicion cuando nadie mira. Un bot que tenia stop no se queda sin el porque un
 * modelo lo creyera conveniente.
 */
export function conStopQueSoloSeEstrecha(
  config: Record<string, unknown>,
  vigente: BotConfig,
): Record<string, unknown> {
  const actual = num((vigente as unknown as Record<string, unknown>)['stopLossPct']);
  if (actual === null) return config;
  const pedido = num(config['stopLossPct']);
  if (pedido !== null && pedido <= actual) return config;
  return { ...config, stopLossPct: (vigente as unknown as Record<string, unknown>)['stopLossPct'] };
}

/** Algun campo cambiado redibuja la escalera o la reticula. */
function redibuja(strategy: Strategy<BotConfig>, diff: ConfigDiff): boolean {
  const porClave = new Map(strategy.meta.fields.map((f) => [f.key, f]));
  return diff.changed.some((c) => porClave.get(c.key)?.reshapes === true);
}
