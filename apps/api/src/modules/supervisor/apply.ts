import {
  D,
  Decimal,
  distanciaLiquidacion,
  isFiniteNum,
  ladoMasEstrecho,
  maintenanceMarginRateOf,
  Mutability,
  stopMaximoRoi,
  type BotConfig,
  type FieldMeta,
  type MarketSpec,
  type Numeric,
} from '@crypton/shared';
import {
  camposEfectivos,
  diffConfig,
  type ConfigDiff,
  type Strategy,
} from '@crypton/strategy-core';
import { buildConfig, shiftBand, type Band, type BuildContext, type Knobs } from '../advisor/build';
import { enforceCouplings, maxApalancamientoSeguro } from '../advisor/sanitize';

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
 *
 * Y desde el spec 051, una cuarta que es la que hace que todo lo anterior sirva
 * sobre un bot de verdad: **lo que se aplica es el DESPLAZAMIENTO de cada campo,
 * no su valor generado**. Ver `trasladarCampo`.
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

/** Las cinco perillas, en el orden del contrato. */
export const PERILLAS = Object.keys(SIN_MOVIMIENTO) as (keyof Desplazamientos)[];

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

/** Cuantas perillas pide mover una decision. */
export function perillasMovidas(d: Desplazamientos): number {
  return PERILLAS.filter((p) => d[p] !== 'IGUAL').length;
}

/**
 * Cuantas perillas puede mover una sola decision (spec 051, decision del
 * usuario).
 *
 * Sustituye al tope de cuatro CAMPOS del spec 046, que media lo equivocado: el
 * diferencial de un market maker V2 son siete campos que se mueven juntos —las
 * dos distancias, el minimo, el umbral de recotizacion, el techo dinamico, el
 * multiplicador de volatilidad y la separacion de capas— y moria SIEMPRE en
 * `DEMASIADOS_CAMPOS`, justo en la perilla que mas importa a un market maker.
 * Mientras tanto dejaba pasar, con tres campos, un «menos apalancamiento» que
 * multiplicaba por cinco el tope de posicion de un bot ajustado a mano. Lo que
 * hace atribuible un resultado es cuantas DECISIONES se tomaron a la vez, no
 * cuantos campos arrastra cada una.
 */
export const MAX_PERILLAS_POR_CAMBIO = 2;

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

// ─────────────────────────────────────────────────────────────────────────────
// El traslado del delta (spec 051)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Campos que se trasladan en proporcion aunque no sean importes: son una
 * fraccion de algo, y sumarles un delta cambia su escala.
 */
const PROPORCIONALES = new Set(['riskPerTradePct']);

/**
 * Cuanto puede moverse un campo, como fraccion de SU valor vivo, por cada
 * escalon que pidio el modelo (spec 052, F-02, F-03 y F-11).
 *
 * El spec 051 arreglo la mitad del problema: dejo de copiar el valor generado y
 * paso a trasladar su salto. Pero el salto se calcula con los numeros que el
 * generador produciria, y el bot puede tener otros muy distintos:
 *
 *   - un market maker ajustado a 6 bps, con el generador yendo de 22 a 8, recibe
 *     un delta de −14 y acaba en el minimo del descriptor: cotizar por debajo de
 *     las comisiones, que es perder en cada par;
 *   - un importe trasladado en proporcion hereda la proporcion del generador, y
 *     entre dos bandas de apalancamiento hay saltos de mas del doble: con el bot
 *     plano —sin guarda de posicion que lo frene— una revision duplica el tamaño
 *     por lado y el tope de posicion.
 *
 * Un cuarto por escalon (la mitad con `MUCHO_`) mantiene el ajuste RELATIVO que
 * pidio el usuario: el bot se mueve desde donde esta, no hacia donde estaria si
 * lo hubiera configurado el asesor. Un bot muy lejos de lo generado tarda varias
 * revisiones en llegar, y eso es exactamente lo que se quiere.
 *
 * Y trae de regalo una regla que hay que decir en voz alta: **de cero no se sale
 * por traslado**. El cuarto de cero es cero, asi que un campo que su dueño apago
 * poniendolo a cero —`orderMaxAgeSeconds`, las ordenes que no caducan por edad—
 * sigue apagado. Encenderlo no es ajustar: es decidir por el.
 */
export const TOPE_RELATIVO_POR_PASO = D('0.25');

/** Los decimales con los que se puede escribir este campo sin destruirlo. */
function decimalesDe(field: FieldMeta, vivo: Decimal): number {
  // En modo «cantidad de moneda», `orderSizePerSide` no es un importe: es una
  // cantidad de BTC, y `camposEfectivos` le pone de minimo el paso de cantidad
  // del venue. Redondear a dos decimales convertia 0,009 BTC en 0,00 y, acotado
  // al minimo, en 0,00001: mil veces menos (spec 052, F-04).
  const delDescriptor = [field.min, field.step]
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .map((v) => D(v).decimalPlaces());
  return Math.max(vivo.decimalPlaces(), ...delDescriptor, 2);
}

/**
 * El valor que tendria que tomar UN campo del bot vivo cuando la perilla se
 * mueve, o `undefined` si ese campo no se debe tocar.
 *
 * `antes` y `despues` son lo que produce el generador con las perillas de antes
 * y con las de despues, sobre el mercado de hoy. Su diferencia es lo que el
 * desplazamiento SIGNIFICA para ese campo; lo que se hace aqui es aplicar esa
 * diferencia a lo que el bot tiene, no copiar `despues`.
 *
 * Copiar `despues` era lo que hacia el spec 046, y sobre un bot ajustado a mano
 * —lo normal en uno que lleva semanas— salia al reves de lo pedido. En
 * el market maker V2 de LIT, con 12 bps de distancia puestos por su dueño, «diferencial MAS»
 * generaba 1→3 (la V2 acota su distancia base a 1) y habria dejado el bot en 3
 * bps: un «ensancha» convertido en «estrecha a la cuarta parte». Y en un market
 * maker ajustado con 300 de tamaño y 2000 de tope, «apalancamiento MUCHO_MENOS»
 * escribia los 555,55 y 10000 generados: menos apalancamiento que multiplicaba el
 * tope por cinco.
 *
 * Las reglas, de la mas cerrada a la mas abierta:
 *
 *   - Un **precio** no se traslada nunca: el generado sale del mercado de hoy y
 *     no guarda relacion con el que puso el dueño.
 *   - Un **enumerado, booleano o texto** no tiene «cuanto»: se toma el valor
 *     nuevo solo si el bot tenia exactamente el de antes. Si lo eligio su dueño,
 *     no se pisa.
 *   - Un **importe** se traslada en PROPORCION y redondeando hacia abajo: sumarle
 *     el delta a un tope de 2000 cuando el generado baja de 15000 a 10000 lo deja
 *     en el minimo del descriptor, y en un perfil prudente eso cierra la posicion
 *     en el siguiente tick. Con un cero (que en los topes significa «sin tope»)
 *     no se construye nada: de «sin limite» no se sale por proporcion.
 *   - El resto de **numeros** se desplaza lo mismo que el generado, redondeando
 *     el delta al paso del campo con redondeo simetrico: subir y bajar vuelve
 *     exactamente al valor de partida.
 *
 * Y tres cortes que valen para todos: un valor vivo que no es un numero o que ya
 * esta fuera del descriptor no se toca —no se inventa nada que el dueño no
 * pusiera—; ningun campo se mueve mas de `TOPE_RELATIVO_POR_PASO` de su propio
 * valor por escalon pedido (spec 052); y un resultado que acotado queda igual, o
 * que se mueve en sentido contrario al generado, se descarta.
 */
export function trasladarCampo(
  field: FieldMeta,
  vigente: unknown,
  antes: unknown,
  despues: unknown,
  escalones = 1,
): unknown {
  if (igual(antes, despues)) return undefined;

  switch (field.kind) {
    case 'price':
      return undefined;
    case 'boolean':
    case 'enum':
    case 'text':
      return igual(vigente, antes) ? despues : undefined;
    default:
      break;
  }

  if (!isFiniteNum(vigente) || !isFiniteNum(antes) || !isFiniteNum(despues)) return undefined;
  const v = D(vigente as Numeric);
  const a = D(antes as Numeric);
  const d = D(despues as Numeric);
  if (field.min !== undefined && v.lt(field.min)) return undefined;
  if (field.max !== undefined && v.gt(field.max)) return undefined;

  // Un cero no se mueve. El cero de un campo de usuario no es un numero pequeño:
  // es «apagado» —las ordenes de `orderMaxAgeSeconds: 0` no caducan por edad— o
  // «sin tope», y las dos cosas las decidio su dueño. Encenderlo no es ajustar
  // (spec 052, F-11). Ademas la banda de abajo alrededor de cero es cero, asi que
  // esto solo hace explicito lo que la aritmetica ya diria.
  if (v.isZero()) return undefined;

  const enProporcion = field.kind === 'money' || PROPORCIONALES.has(field.key);
  if (enProporcion && (a.lte(0) || v.lte(0))) return undefined;

  // La banda relativa: el resultado se queda dentro de [v / f, v × f], con
  // f = 1 + un cuarto por escalon. Es una banda MULTIPLICATIVA y no una suma, y
  // esa es justo la propiedad que hace falta: subir hasta el tope y volver a
  // bajar devuelve EXACTAMENTE el valor de partida (v × f / f), mientras que una
  // banda aditiva —cuyo tamaño crece con el valor— dejaria el bot un 6 % mas
  // abajo en cada ida y vuelta. Y eso es el vaiven que este fichero existe para
  // impedir.
  const f = TOPE_RELATIVO_POR_PASO.mul(Math.max(1, Math.abs(escalones))).plus(1);
  const subida = v.abs().mul(f).minus(v.abs());
  const bajada = v.abs().minus(v.abs().div(f));

  let nuevo: Decimal;
  if (enProporcion) {
    // Se cuantiza UNA vez, ya acotado, SIEMPRE hacia abajo y con los decimales del
    // campo EFECTIVO —que en modo «cantidad de moneda» son los del venue y no dos
    // (spec 052, F-04)—. Hacia abajo aunque eso deje el valor un ultimo decimal
    // por debajo del suelo de la banda: la regla de la casa para cantidades
    // (`precision.ts`) es que el redondeo nunca sume, y una ida y vuelta que
    // devuelve un centimo de mas es peor que una que pierde uno.
    nuevo = v.mul(d).div(a);
    nuevo = Decimal.min(Decimal.max(nuevo, v.minus(bajada)), v.plus(subida));
    nuevo = nuevo.toDecimalPlaces(decimalesDe(field, v), Decimal.ROUND_DOWN);
  } else {
    const paso = field.step ?? (field.kind === 'integer' ? 1 : undefined);
    let delta = d.minus(a);
    if (paso !== undefined && paso > 0) {
      delta = delta.div(paso).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(paso);
    }
    // La cota, en numero entero de pasos y nunca menos de UNO: con medio paso de
    // margen, un campo de valor pequeño —el apalancamiento a 2x, una sola capa—
    // no podria moverse jamas, y eso no es acotar, es congelar.
    let cota = delta.isNeg() ? bajada : subida;
    if (paso !== undefined && paso > 0) {
      cota = Decimal.max(cota.div(paso).floor().mul(paso), paso);
    }
    if (delta.abs().gt(cota)) delta = cota.mul(delta.isNeg() ? -1 : 1);
    nuevo = v.plus(delta);
  }

  if (field.min !== undefined) nuevo = Decimal.max(nuevo, field.min);
  if (field.max !== undefined) nuevo = Decimal.min(nuevo, field.max);

  const real = nuevo.comparedTo(v);
  if (real === 0 || real !== d.comparedTo(a)) return undefined;

  // Los importes viajan como cadena (invariante 1). El resto conserva el tipo
  // con el que el bot lo guardaba: cambiar un 12 por un '12' no es un cambio
  // para `diffConfig`, pero ensucia la revision que se guarda.
  if (field.kind === 'money') return nuevo.toFixed();
  return typeof vigente === 'string' ? nuevo.toFixed() : nuevo.toNumber();
}

/**
 * La configuracion vigente con cada campo desplazado como dice `trasladarCampo`.
 *
 * Lo que no se mueve se queda EXACTAMENTE como estaba. Es la otra mitad del
 * arreglo del spec 051: antes la configuracion entera pasaba por `coerceConfig`,
 * que re-cuantiza cada campo contra el descriptor, y un bot con `'12.5'` bps
 * salia con 13, o un `null` salia como `''`, sin que nadie hubiera pedido nada.
 */
export function trasladarDelta(
  strategy: Strategy<BotConfig>,
  vigente: BotConfig,
  antes: Record<string, unknown>,
  despues: Record<string, unknown>,
  market: MarketSpec,
  escalones = 1,
): Record<string, unknown> {
  const base = vigente as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  const intocables = new Set<string>(INTOCABLES);

  for (const campo of camposEfectivos(strategy.meta.fields, base, market)) {
    if (campo.mutability === Mutability.COLD || intocables.has(campo.key)) continue;
    if (!(campo.key in despues)) continue;
    const valor = trasladarCampo(
      campo,
      base[campo.key],
      antes[campo.key],
      despues[campo.key],
      escalones,
    );
    if (valor !== undefined) out[campo.key] = valor;
  }

  // Con una sola capa, la separacion y el crecimiento ENTRE capas no hacen nada:
  // no hay segunda capa que separar. Pero son WARM, asi que moverlos convertia un
  // cambio de diferencial —HOT, lo que mas le importa a un market maker— en uno
  // que cancela y vuelve a tender las ordenes, pide permiso de recolocacion y
  // gasta el enfriamiento WARM. Se dejan como estaban (spec 052, F-12).
  if (esMarketMaker(strategy.kind) && (num(out['layers']) ?? 1) <= 1) {
    for (const clave of ['layerDistanceMultiplier', 'layerSizeMultiplier']) {
      if (clave in base) out[clave] = base[clave];
      else delete out[clave];
    }
  }
  return out;
}

const esMarketMaker = (kind: string): boolean =>
  kind === 'MARKET_MAKER' || kind === 'MARKET_MAKER_V2';

/**
 * Los acoplamientos que solo aparecen al trasladar, y que `enforceCouplings` no
 * conoce porque el asesor nunca los produce.
 *
 * Varias capas con separacion 1 ponen todas las capas al MISMO precio, y la V2
 * lo rechaza. El generador nunca lo emite —su suelo con varias capas es 1,05
 * (`build.ts`, spec 037 R-2)—, pero un bot con los valores de fabrica (una capa,
 * separacion 1) al que se le sube el crecimiento gana capas sin que la
 * separacion se mueva. Se repara hacia el suelo del propio generador.
 */
function acoplamientosDelSupervisor(
  kind: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!esMarketMaker(kind)) return config;
  const capas = num(config['layers']);
  const separacion = num(config['layerDistanceMultiplier']);
  if (capas === null || capas <= 1 || separacion === null || separacion > 1) return config;
  return {
    ...config,
    layerDistanceMultiplier: typeof config['layerDistanceMultiplier'] === 'string' ? '1.05' : 1.05,
  };
}

/** Las distancias de un market maker que forman lo que cotiza. */
const DISTANCIAS_MM = ['buyDistanceBps', 'sellDistanceBps', 'minAllowedDistanceBps'] as const;

/**
 * Con la perilla del diferencial, las distancias de un market maker y su suelo
 * solo se mueven en el sentido pedido (spec 055, 054/H-02).
 *
 * El generador de la V2 reparte el diferencial objetivo entre la distancia base
 * y el multiplicador de volatilidad —lo que ya suma `composeSpreadBps` no se
 * escribe en la distancia—, asi que al pedir MAS la distancia base BAJA mientras
 * el multiplicador sube. En la configuracion generada la suma cuadra; en un bot
 * vivo no, porque el traslado acota cada campo por su lado con su propia banda.
 * En torno a una de cada cuatro propuestas «diferencial MAS» estrechaba lo que de
 * verdad cotiza, y en calma —sin volatilidad que multiplicar— casi siempre.
 *
 * Se quedan quietas en vez de descartar la propuesta entera: el resto de lo que
 * mueve la perilla —el multiplicador, el techo dinamico, el umbral de
 * recotizacion y la separacion entre capas— ya va en el sentido pedido, y con
 * las distancias quietas ningun componente del diferencial compuesto va al
 * reves, sea cual sea la volatilidad. En la V1 no cambia nada: su generador
 * mueve las distancias siempre con la perilla.
 */
function distanciasEnElSentidoPedido(
  kind: string,
  config: Record<string, unknown>,
  vigente: BotConfig,
  ajustes: Desplazamientos,
): Record<string, unknown> {
  const sentido = Math.sign(PASOS[ajustes.spread]);
  if (!esMarketMaker(kind) || sentido === 0) return config;
  const base = vigente as unknown as Record<string, unknown>;
  const out = { ...config };
  for (const clave of DISTANCIAS_MM) {
    const de = base[clave];
    const a = out[clave];
    if (!isFiniteNum(de) || !isFiniteNum(a)) continue;
    const movido = D(a as Numeric).comparedTo(D(de as Numeric));
    if (movido !== 0 && movido !== sentido) out[clave] = de;
  }
  return out;
}

/**
 * En una V2, el suelo que puso su dueño se queda donde lo puso (spec 055,
 * 054/H-01).
 *
 * `enforceCouplings` baja la distancia minima hasta la menor de las distancias,
 * y para el ASESOR esta bien: una configuracion recien generada no debe nacer
 * incoherente. Pero en la V2 un suelo por encima de las distancias no es una
 * incoherencia —el validador solo avisa de que «se elevaran hasta ahi», y el
 * suelo compuesto hace justo eso—, y aplicada a un bot vivo la reparacion lo
 * bajaba con CUALQUIER perilla y sin banda: 20 → 10 bps con «apalancamiento». La
 * V1 si la necesita —alli el validador la exige— y nunca sale de la banda de la
 * distancia que la provoca, asi que alli se queda.
 */
function conElSueloDeLaV2(
  kind: string,
  reparada: Record<string, unknown>,
  trasladada: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== 'MARKET_MAKER_V2' || !('minAllowedDistanceBps' in trasladada)) return reparada;
  return { ...reparada, minAllowedDistanceBps: trasladada['minAllowedDistanceBps'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// La guarda de posicion (spec 051)
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el supervisor sabe de la posicion del bot al decidir. */
export interface PosicionViva {
  abierta: boolean;
  /** |cantidad| × marca, en la moneda de cotizacion; null si no se conoce. */
  exposicion: string | null;
  /**
   * Hace cuanto se midio la exposicion, en milisegundos. `null` es «no se sabe»,
   * y se trata como rancia.
   *
   * El estado del bot se acepta hasta con diez minutos de antiguedad
   * (`SNAPSHOT_FRESCO_MS`), que para describir el bot esta bien y para decidir si
   * bajarle el tope a un market maker no: un market maker acumula inventario en
   * minutos, y la holgura del 25 % no cubre diez (spec 052, F-05).
   */
  medidaHace: number | null;
}

type Sentido = 'SUBE' | 'BAJA';

interface CampoDeRiesgo {
  /** En que sentido este campo acerca la ruina. */
  arriesgado: Sentido;
  /** Vacio, null o cero significan «sin tope»: infinito, no nada. */
  tope?: true;
}

const RIESGO_COMUN: Readonly<Record<string, CampoDeRiesgo>> = {
  leverage: { arriesgado: 'SUBE' },
  stopLossPct: { arriesgado: 'SUBE' },
  maxDailyLossPct: { arriesgado: 'SUBE' },
  maxNotionalCap: { arriesgado: 'SUBE', tope: true },
};

const RIESGO_MM: Readonly<Record<string, CampoDeRiesgo>> = {
  ...RIESGO_COMUN,
  orderSizePerSide: { arriesgado: 'SUBE' },
  maxBotPositionValue: { arriesgado: 'SUBE' },
  maxLongPosition: { arriesgado: 'SUBE', tope: true },
  maxShortPosition: { arriesgado: 'SUBE', tope: true },
  // Subir el umbral defensivo es llegar MAS TARDE al modo que protege el
  // inventario. Es lo que hacia «cobertura MAS» en un market maker, y el recorte
  // del spec 046 lo dejaba pasar con inventario creyendo que cubrir mas era
  // arriesgar menos, que solo es cierto en una escalera.
  defensiveThresholdPct: { arriesgado: 'SUBE', tope: true },
  highRiskThresholdPct: { arriesgado: 'SUBE', tope: true },
  layers: { arriesgado: 'SUBE' },
  layerSizeMultiplier: { arriesgado: 'SUBE' },
  // Al reves que los demas: cuanto mas sesgo, antes descarga el inventario.
  inventorySkewFactor: { arriesgado: 'BAJA' },
};

/**
 * Los campos que, con una posicion abierta, no pueden moverse en su sentido
 * arriesgado.
 *
 * Por CAMPO y no por perilla, y es deliberado: que perilla sube el riesgo
 * depende de la estrategia —la cobertura de una escalera y la de un market maker
 * van en sentidos opuestos—, y el recorte por perillas del spec 046 se equivoco
 * justo por eso. Mirar el resultado no depende de acertar esa semantica.
 */
export const CAMPOS_DE_RIESGO: Readonly<Record<string, Readonly<Record<string, CampoDeRiesgo>>>> = {
  MARKET_MAKER: RIESGO_MM,
  MARKET_MAKER_V2: RIESGO_MM,
  TREND_FOLLOW: { ...RIESGO_COMUN, riskPerTradePct: { arriesgado: 'SUBE' } },
  TRAILING_PROFIT: RIESGO_COMUN,
};

/**
 * Los campos que con una posicion abierta no se cambian EN NINGUN SENTIDO, porque
 * cambiarlos puede cerrarla en el acto.
 *
 * Estrechar un stop parece prudente y no lo es con una posicion viva: su precio
 * sale del precio de entrada, asi que un largo que pierde un 4 % con el stop
 * pasado del 5 al 3 % salta en el siguiente tick. Lo mismo el objetivo y el
 * retroceso de la estrategia de seguimiento: moverlos puede dejar el disparo por
 * encima del precio. El spec 046 le prohibe al supervisor cerrar posiciones, y
 * esto es lo que lo hace verdad.
 *
 * Con una condicion que el spec 051 no cumplio: hay que bloquear el stop QUE LA
 * ESTRATEGIA USA, no el que se llama `stopLossPct`. En `TREND_FOLLOW` el stop
 * sale de `atrStopMultiplier` (`atrValor × multiplicador`) y el validador RECHAZA
 * que venga `stopLossPct` con valor —«el stop lo pone la estrategia»—, asi que la
 * guarda vigilaba un campo que siempre esta vacio mientras la perilla
 * `diferencial` movia el de verdad (spec 052, F-01).
 */
export const BLOQUEADOS_CON_POSICION: Readonly<Record<string, readonly string[]>> = {
  // El apalancamiento, en todas desde el spec 080 (P-3): con los % de resultado
  // sobre el margen, cambiarlo con la posicion abierta movería en silencio el
  // stop y el objetivo de lo que ya esta abierto, y acerca la liquidacion.
  MARKET_MAKER: ['stopLossPct', 'leverage'],
  MARKET_MAKER_V2: ['stopLossPct', 'leverage'],
  TREND_FOLLOW: ['stopLossPct', 'atrStopMultiplier', 'leverage'],
  TRAILING_PROFIT: ['stopLossPct', 'takeProfitPct', 'trailingCallbackPct', 'leverage'],
};

/**
 * Cuanto por encima de la exposicion tiene que quedar el tope de un market maker
 * que cierra al tocarlo. Un tope que baja justo hasta lo expuesto se toca con el
 * siguiente fill.
 */
const HOLGURA_TOPE = D('1.25');

/**
 * Cuanto vale una medida de exposicion para decidir bajar un tope que cierra.
 *
 * Dos minutos: el motor escribe el estado cada pocos ticks de quince segundos,
 * asi que con un bot vivo hay medida de sobra dentro de la ventana. Mas alla, lo
 * honesto es decir que no se sabe — y no saber ya vale `CIERRE`.
 */
const EXPOSICION_FRESCA_MS = 2 * 60_000;

function paraComparar(valor: unknown, regla: CampoDeRiesgo): Decimal | null {
  if (regla.tope) {
    const vacio = valor === null || valor === undefined || valor === '';
    if (vacio || (isFiniteNum(valor) && D(valor as Numeric).isZero())) return new Decimal(Infinity);
  }
  return isFiniteNum(valor) ? D(valor as Numeric) : null;
}

/**
 * Con una posicion abierta, `RIESGO` si algun campo se mueve en su sentido
 * arriesgado y `CIERRE` si el cambio puede cerrarla. Sin posicion, nada.
 */
export function guardaDePosicion(
  kind: string,
  vigente: BotConfig,
  propuesta: Record<string, unknown>,
  posicion: PosicionViva,
): 'RIESGO' | 'CIERRE' | null {
  if (!posicion.abierta) return null;
  const antes = vigente as unknown as Record<string, unknown>;

  for (const clave of BLOQUEADOS_CON_POSICION[kind] ?? []) {
    if (!igual(antes[clave], propuesta[clave])) return 'CIERRE';
  }

  // Un market maker que CIERRA al tocar su tope: bajarle el tope por debajo de
  // lo que ya tiene expuesto aplana la posicion en el siguiente tick. Sin saber
  // la exposicion no se arriesga.
  if (esMarketMaker(kind)) {
    const accion =
      typeof propuesta['limitAction'] === 'string' ? propuesta['limitAction'] : 'PAUSE_ENTRIES';
    const topeAntes = antes['maxBotPositionValue'];
    const topeNuevo = propuesta['maxBotPositionValue'];
    if (accion !== 'PAUSE_ENTRIES' && isFiniteNum(topeAntes) && isFiniteNum(topeNuevo)) {
      const nuevo = D(topeNuevo as Numeric);
      if (nuevo.lt(D(topeAntes as Numeric))) {
        if (posicion.exposicion === null || !isFiniteNum(posicion.exposicion)) return 'CIERRE';
        if (posicion.medidaHace === null || posicion.medidaHace > EXPOSICION_FRESCA_MS) {
          return 'CIERRE';
        }
        if (nuevo.lt(D(posicion.exposicion).mul(HOLGURA_TOPE))) return 'CIERRE';
      }
    }
  }

  for (const [clave, regla] of Object.entries(CAMPOS_DE_RIESGO[kind] ?? {})) {
    const de = paraComparar(antes[clave], regla);
    const a = paraComparar(propuesta[clave], regla);
    if (de === null || a === null) continue;
    if (regla.arriesgado === 'SUBE' ? a.gt(de) : a.lt(de)) return 'RIESGO';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// La cadena
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Por que no se propone nada. Alimenta la fila de la decision y el aviso.
 *
 * `bot_ai_decisions.discard_reason` es `VARCHAR(24)` y el comentario del esquema
 * enumera los del spec 046; los del 051 (`DEMASIADAS_PERILLAS`, `RIESGO`,
 * `CIERRE`, y `AVISO_REPETIDO` en el servicio) caben y viven documentados aqui,
 * porque el esquema no se toca sin un spec que lo pida.
 */
export type MotivoDescarte =
  | 'SIN_CAMBIOS'
  | 'COLD'
  | 'RESHAPE'
  | 'VALIDACION'
  | 'VENUE'
  | 'DEMASIADAS_PERILLAS'
  | 'RIESGO'
  | 'CIERRE';

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
  /**
   * Escalones ya ejecutados del ciclo abierto. Es lo que mira `updateConfig`
   * para su guarda de reshape, y por eso lo mira tambien la de aqui.
   */
  inventario: number;
  /**
   * La posicion, si se conoce. Sin ella se asume abierta en cuanto hay
   * inventario, que en un market maker es SIEMPRE —su ciclo no cierra nunca—:
   * es la suposicion prudente, no la exacta.
   */
  posicion?: PosicionViva;
  /** false = solo se aceptan cambios HOT; un WARM se descarta entero. */
  permitirWarm: boolean;
}

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
  const posicion = input.posicion ?? {
    abierta: inventario > 0,
    exposicion: null,
    medidaHace: null,
  };

  // 0. No pedir nada no cuesta nada, aunque el bot tenga algo que reparar. Sin
  //    esto, un bot con el apalancamiento por encima de un tope que su dueño
  //    bajo despues salia con una «propuesta» que nadie habia hecho: la
  //    reparacion de `enforceCouplings`.
  const movidas = perillasMovidas(input.ajustes);
  if (movidas === 0) return 'SIN_CAMBIOS';

  // 1. Como mucho dos perillas, contando lo PEDIDO: es lo que el prompt promete.
  if (movidas > MAX_PERILLAS_POR_CAMBIO) return 'DEMASIADAS_PERILLAS';

  const knobs = aplicarDesplazamientos(input.knobs, input.ajustes);

  // 2. El generador determinista, DOS VECES: con las perillas de antes y con las
  //    de despues. El capital sale del bot vivo, nunca del modelo. Lo que cambia
  //    entre las dos es lo que el desplazamiento significa.
  //    Los % sobre el MARGEN (spec 080), los dos con el apalancamiento del BOT:
  //    así su diferencia es solo lo que cambió el % de PRECIO que pide la
  //    perilla, y mover el apalancamiento deja el resultado sobre el margen como
  //    estaba (D-4). Cada uno con el suyo, la diferencia mezclaba los dos
  //    cambios y el ruido del redondeo.
  const ctxCapital = {
    ...ctx,
    totalInvestment: Number(vigente.totalInvestment ?? ctx.totalInvestment),
    apalancamientoDeResultados:
      num((vigente as unknown as Record<string, unknown>)['leverage']) ?? undefined,
  };
  const antes = buildConfig(strategy.kind, input.knobs, ctxCapital);
  const despues = buildConfig(strategy.kind, knobs, ctxCapital);

  // 3. El traslado: cada campo se mueve sobre lo que el bot tiene, acotado a un
  //    cuarto de su valor por escalon pedido, y lo que no se mueve se queda como
  //    estaba. Sin `coerceConfig` de la config entera.
  const escalones = Math.max(...PERILLAS.map((p) => Math.abs(PASOS[input.ajustes[p]])));
  let config = trasladarDelta(strategy, vigente, antes, despues, market, escalones);

  // 3b. Con la perilla del diferencial, las distancias de un market maker solo
  //     van en el sentido pedido (spec 055, 054/H-02).
  config = distanciasEnElSentidoPedido(strategy.kind, config, vigente, input.ajustes);

  // 4. Los acoplamientos que ninguna validacion deduce de un campo aislado, los
  //    del asesor y los que solo aparecen al trasladar. Salvo el suelo de una
  //    V2, que no es una incoherencia (spec 055, 054/H-01).
  const trasladada = config;
  config = enforceCouplings(strategy.kind, config, market, ctx.maxLeverageUsuario);
  config = conElSueloDeLaV2(strategy.kind, config, trasladada);
  config = acoplamientosDelSupervisor(strategy.kind, config);

  // 5. Y la fusion OTRA VEZ. `enforceCouplings` puede tocar campos que en alguna
  //    estrategia son COLD —`numLimitBuys` lo es en varias—, y reparar primero y
  //    volver a fijar despues sale mas barato que razonar sobre que repara que.
  config = fusionarConservandoInmutables(strategy, vigente, config, market);

  // 6. El tope propio del supervisor: una revision no sube el apalancamiento mas
  //    de un punto. Bajarlo es libre. Sin esto, dos revisiones seguidas pueden
  //    llevar a un bot de 2x a 10x sin que nadie mire.
  config = conTopeDeApalancamiento(config, vigente, market, ctx.maxLeverageUsuario);

  // 7. El stop loss solo se ESTRECHA. Ensancharlo o apagarlo es exactamente lo
  //    que nadie quiere que haga un proceso automatico de madrugada.
  config = conStopQueSoloSeEstrecha(config, vigente);

  // 7b. Y nunca detras de la liquidacion: el stop es un % del margen (spec 080),
  //     y con el apalancamiento que sale de aqui un stop que era valido puede
  //     quedar detras de ella. Se estrecha al mas ancho valido.
  config = conStopDelanteDeLaLiquidacion(config, market);

  // 8. Con posicion abierta, ni mas riesgo ni nada que pueda cerrarla.
  const guarda = guardaDePosicion(strategy.kind, vigente, config, posicion);
  if (guarda) return guarda;

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

  // 12. Un campo que redibuja la escalera con escalones ya ejecutados deja la
  //     salida de lo comprado en una linea que ya no existe (001/F-90). La API
  //     lo rechaza con 409; se descarta aqui para no gastar el viaje y para
  //     poder decir el motivo.
  if (inventario > 0 && redibuja(strategy, diff)) return 'RESHAPE';

  return { config: paraValidar, level: diff.level, diff, knobs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Que tiene efecto (spec 051)
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que pasaria si el modelo pidiera mover una sola perilla un paso. */
export type Efecto = 'APLICABLE' | 'EXTREMO' | MotivoDescarte;

export interface EfectoDePerilla {
  MENOS: Efecto;
  MAS: Efecto;
  /** Los campos que cambiarian, cuando el efecto es `APLICABLE`. */
  campos: { MENOS: string[]; MAS: string[] };
  /**
   * `true` cuando un escalon se queda corto y hacen falta los DOS (`MUCHO_`).
   *
   * Con la cota relativa del spec 052 esto deja de ser raro: un escalon puede no
   * llegar al paso del campo y dos si. El prompt promete que «solo tienen efecto
   * los movimientos marcados si», asi que o se prueban los dos escalones o la
   * promesa es falsa (spec 052, F-08).
   */
  soloDoble: { MENOS: boolean; MAS: boolean };
}

export type Efectos = Record<keyof Desplazamientos, EfectoDePerilla>;

/**
 * Para cada perilla y sentido, que produciria pedirlo: si cambia algo, que
 * campos, o por que no.
 *
 * Existe porque el modelo pedia lo imposible y lo volvia a pedir. El diferencial
 * del market maker de BTC ya cotizaba en el suelo por coste, asi que «estrechar» no
 * cambiaba nada; el modelo no lo sabia y pagaba una llamada cada media hora para
 * oirlo. Se calcula con la MISMA cadena que aplica —misma posicion, mismo
 * permiso para WARM—, asi que lo que aqui sale `APLICABLE` es lo que se aplicaria.
 *
 * Son diez traducciones, todas CPU: dos `buildConfig`, una validacion y una
 * vista previa cada una, sin tocar la red.
 */
export function movimientosConEfecto(base: Omit<EntradaDeCambio, 'ajustes'>): Efectos {
  const out = {} as Efectos;
  for (const perilla of PERILLAS) {
    const fila: EfectoDePerilla = {
      MENOS: 'SIN_CAMBIOS',
      MAS: 'SIN_CAMBIOS',
      campos: { MENOS: [], MAS: [] },
      soloDoble: { MENOS: false, MAS: false },
    };
    for (const mov of ['MENOS', 'MAS'] as const) {
      if (shiftBand(base.knobs[perilla], PASOS[mov]) === base.knobs[perilla]) {
        fila[mov] = 'EXTREMO';
        continue;
      }
      let r = decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: mov } });
      // Un escalon que no mueve nada no significa que la perilla este muerta:
      // con la cota relativa, el delta de un escalon puede no llegar al paso del
      // campo y el de dos si. Solo se prueba en ese caso, que es puro CPU.
      if (r === 'SIN_CAMBIOS') {
        const doble = mov === 'MENOS' ? 'MUCHO_MENOS' : 'MUCHO_MAS';
        const conDos = decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: doble } });
        if (typeof conDos !== 'string') {
          r = conDos;
          fila.soloDoble[mov] = true;
        }
      }
      if (typeof r === 'string') {
        fila[mov] = r;
      } else {
        fila[mov] = 'APLICABLE';
        fila.campos[mov] = r.diff.changed.map((c) => c.key);
      }
    }
    out[perilla] = fila;
  }
  return out;
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
 * `maxApalancamientoSeguro`, el del venue y el del usuario). Lo que anade esto es una
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

  const topes = [
    actual + 1,
    maxApalancamientoSeguro(market, (vigente as unknown as Record<string, unknown>)['direction']),
    market.maxLeverage,
  ];
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
 *
 * Con una posicion abierta ni siquiera se estrecha: eso lo corta
 * `guardaDePosicion`, porque un stop estrechado sobre una posicion que ya pierde
 * salta en el acto.
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

/**
 * El stop, nunca detras de la liquidacion (spec 080, 079/F-01).
 *
 * Solo en AISLADO y solo cuando el stop queda en la liquidacion o detras —lo
 * que `validate()` rechaza—: entonces se estrecha al mas ancho que deja medio
 * stop de holgura (`stopMaximoRoi`). Un stop que el dueño dejo en la zona del
 * aviso, por delante de la liquidacion, no se toca: estrecharlo sin que nadie lo
 * pida tambien seria decidir por el. En cruzado la liquidacion real queda mas
 * lejos y la validacion solo avisa.
 */
export function conStopDelanteDeLaLiquidacion(
  config: Record<string, unknown>,
  market: MarketSpec,
): Record<string, unknown> {
  const stop = num(config['stopLossPct']);
  if (stop === null || stop <= 0 || config['marginMode'] === 'CROSS') return config;
  const lev = num(config['leverage']) ?? 1;
  const direction = config['direction'];
  const lado = ladoMasEstrecho(
    direction === 'LONG' || direction === 'SHORT' ? direction : 'NEUTRAL',
  );
  const mmr = maintenanceMarginRateOf(market);
  const d = distanciaLiquidacion(lev, mmr, lado);
  const s = D(stop).div(lev).div(100);
  if (!d.gt(0) || s.lt(d)) return config;
  const maximo = stopMaximoRoi(lev, mmr, lado);
  if (!maximo.gt(0)) return config;
  return {
    ...config,
    stopLossPct: typeof config['stopLossPct'] === 'string' ? maximo.toFixed() : maximo.toNumber(),
  };
}

/** Algun campo cambiado redibuja la escalera o la reticula. */
function redibuja(strategy: Strategy<BotConfig>, diff: ConfigDiff): boolean {
  const porClave = new Map(strategy.meta.fields.map((f) => [f.key, f]));
  return diff.changed.some((c) => porClave.get(c.key)?.reshapes === true);
}

/**
 * Igualdad laxa, como `sameValue` de `diffConfig`: los generadores emiten cadenas
 * para unos campos y numeros para otros, y '20' y 20 son el mismo valor.
 */
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
