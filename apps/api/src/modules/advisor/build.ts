import type { MarketSpec } from '@crypton/shared';
import type { MarketFeatures } from './market-features';
import { MAX_SAFE_LEVERAGE, ladderCoveragePct } from './sanitize';

/**
 * De perillas a configuracion completa.
 *
 * Este es el UNICO sitio donde nacen los numeros de una recomendacion, y lo es a
 * proposito. Las dos ramas —la que decide la IA y la de reglas— pasan por aqui
 * con las mismas perillas; lo unico que cambia es quien las elige. Asi, «las dos
 * ramas producen configuraciones igual de validas» deja de ser disciplina y pasa
 * a ser estructura.
 *
 * El modelo NUNCA emite un importe ni un precio: emite perillas discretas. Un
 * precio absoluto salido de un modelo es la forma mas rapida de dejar una
 * rejilla entera fuera de mercado, y un importe en USDC seria dejarle decidir
 * cuanto arriesga alguien.
 *
 * Todo es puro y se prueba sin levantar la API.
 */

export type Profile = 'PRUDENTE' | 'EQUILIBRADA' | 'AGRESIVA';

export const PROFILES: readonly Profile[] = ['PRUDENTE', 'EQUILIBRADA', 'AGRESIVA'];

/** Bandas discretas. Son las unicas que el modelo puede elegir. */
export type Band = 'MUY_BAJA' | 'BAJA' | 'MEDIA' | 'ALTA' | 'MUY_ALTA';

export const BANDS: readonly Band[] = ['MUY_BAJA', 'BAJA', 'MEDIA', 'ALTA', 'MUY_ALTA'];

/**
 * Lo que el modelo decide. Todo son enums: es lo unico que las salidas
 * estructuradas acotan de verdad (`minimum`/`maximum` no estan soportados y los
 * SDK los borran del esquema antes de enviarlo).
 */
export interface Knobs {
  profile: Profile;
  /** Cuanto apalancamiento respecto de lo que la volatilidad aconseja. */
  leverage: Band;
  /** Cuanto recorrido adverso quiere cubrir antes de quedarse sin escalera. */
  coverage: Band;
  /** Como de rapido se separan los niveles o de ancha va la rejilla. */
  spread: Band;
  /** Cuanto crece el tamano de cada nivel respecto del anterior. */
  sizeGrowth: Band;
  /** Cada cuanto actua el bot: ciclos cortos o pacientes. */
  cadence: Band;
}

export interface BuildContext {
  market: MarketSpec;
  features: MarketFeatures;
  /** Capital que el usuario ha puesto, en unidades de la moneda de cotizacion. */
  totalInvestment: number;
  /** Tope de apalancamiento del usuario, si lo tiene configurado. */
  maxLeverageUsuario: number | null;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/** Factor de cada banda: el centro es 1 y los extremos se alejan simetricamente. */
const FACTOR: Record<Band, number> = {
  MUY_BAJA: 0.55,
  BAJA: 0.75,
  MEDIA: 1,
  ALTA: 1.35,
  MUY_ALTA: 1.75,
};

/** Redondea a un numero de decimales y lo devuelve como cadena. */
const dec = (v: number, decimales: number): string => v.toFixed(decimales);

/** Cuantiza al paso, anclando al minimo, y devuelve cadena. */
function stepped(v: number, min: number, max: number, step: number, decimales: number): string {
  const pasos = Math.round((clamp(v, min, max) - min) / step);
  return dec(clamp(min + pasos * step, min, max), decimales);
}

const floorToTick = (precio: number, tick: number): number =>
  tick > 0 ? Math.floor(precio / tick) * tick : precio;

const ceilToTick = (precio: number, tick: number): number =>
  tick > 0 ? Math.ceil(precio / tick) * tick : precio;

/**
 * Apalancamiento sugerido.
 *
 * Sale de la volatilidad y NO de la banda a secas: en un par que se mueve un
 * 200 % anual, «agresivo» a 10x no es agresivo, es una liquidacion con fecha. La
 * banda solo escala una base que ya tiene en cuenta cuanto respira el mercado.
 *
 * Encima van tres topes duros:
 *   - el tope real del servidor (ver `MAX_SAFE_LEVERAGE`),
 *   - el del venue,
 *   - y el del propio usuario si lo ha puesto.
 *
 * Y uno mas, el que de verdad protege: el peor dia del periodo no puede comerse
 * mas de un tercio de la distancia a liquidacion. Un par que un dia cayo un 20 %
 * no admite 10x por mucho que la media diga lo contrario.
 */
export function leverageFor(k: Knobs, ctx: BuildContext, techoEstrategia: number): number {
  // La distancia a liquidacion tiene que valer N sesiones tipicas.
  //
  // La formula anterior era `60 / volatilidadAnual` redondeado, y estaba mal de
  // una forma que no se veia: por encima del 45 % de volatilidad —o sea, en casi
  // cualquier par real— colapsaba a 1 para las tres bandas, y los tres perfiles
  // salian con el mismo apalancamiento. La funcion entera perdia su sentido.
  //
  // Esta se apoya en la volatilidad DIARIA, que es la escala a la que un bot
  // sufre: se pide que `100/apalancamiento` cubra N dias tipicos, y la banda
  // mueve N. Asi el prudente exige mas colchon y el agresivo menos, pero los dos
  // siguen atados a cuanto respira el par.
  const volDiaria = Math.max(ctx.features.volAnnualPct, 10) / Math.sqrt(365);
  const sesiones = 8 / FACTOR[k.leverage];
  let lev = Math.round(clamp(100 / (sesiones * volDiaria), 1, MAX_SAFE_LEVERAGE));

  const peorDia = Math.abs(ctx.features.worstDayPct);
  if (peorDia > 0.5) lev = Math.min(lev, Math.floor(100 / (3 * peorDia)));

  const topes = [MAX_SAFE_LEVERAGE, ctx.market.maxLeverage, techoEstrategia];
  if (ctx.maxLeverageUsuario != null) topes.push(ctx.maxLeverageUsuario);
  return Math.max(1, Math.min(lev, ...topes));
}

/**
 * Perillas por reglas: el plan B, y tambien el punto de partida cuando la IA
 * solo mueve algunas.
 *
 * Se leen los rasgos del mercado, no una tabla fija: un mercado en tendencia
 * limpia (eficiencia alta) es mal terreno para una rejilla, y ahi el perfil
 * prudente ensancha en vez de estrechar.
 */
export function defaultKnobs(profile: Profile, f: MarketFeatures): Knobs {
  const porPerfil: Record<Profile, Band> = {
    PRUDENTE: 'BAJA',
    EQUILIBRADA: 'MEDIA',
    AGRESIVA: 'ALTA',
  };
  const inverso: Record<Profile, Band> = {
    PRUDENTE: 'ALTA',
    EQUILIBRADA: 'MEDIA',
    AGRESIVA: 'BAJA',
  };
  return {
    profile,
    leverage: porPerfil[profile],
    // Cobertura al reves que el apetito: el prudente cubre MAS caida, no menos.
    coverage: inverso[profile],
    // En un mercado que va en linea recta se ensancha todo: la rejilla estrecha
    // solo sirve cuando el precio va y viene.
    //
    // Se DESPLAZA la banda del perfil en vez de fijarla en 'ALTA' para todos.
    // Fijarla borraba la diferencia entre perfiles justo donde mas importa: en
    // un mercado salvaje los tres salian con la misma anchura y, como ahi el
    // apalancamiento tambien cae a 1 para todos, dos de las tres tarjetas eran
    // literalmente la misma configuracion.
    spread: f.efficiency > 0.5 ? shiftBand(inverso[profile], 1) : inverso[profile],
    sizeGrowth: porPerfil[profile],
    cadence: porPerfil[profile],
  };
}

/**
 * Mueve una banda `pasos` posiciones, sin salirse de la escala.
 *
 * Se exporta desde el spec 046: el supervisor construye sobre ella su contrato
 * de DESPLAZAMIENTOS, y tener dos implementaciones de «mover una banda» seria
 * tener dos escalas que se separan el dia que alguien toque una.
 */
export function shiftBand(band: Band, pasos: number): Band {
  const i = BANDS.indexOf(band);
  return BANDS[clamp(i + pasos, 0, BANDS.length - 1)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Generadores por familia
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escalera de seguridad: martingala y GridMart.
 *
 * La restriccion que lo gobierna todo es que la escalera QUEPA antes de la
 * liquidacion: si la cobertura acumulada llega a `100/apalancamiento`, los
 * ultimos niveles no se ejecutarian jamas y el bot muere con la escalera a
 * medio tender. Se apunta al 85 % de esa distancia y no al 100 % porque la
 * liquidacion con la que se compara esta estimada con una tasa de mantenimiento
 * documentada como OPTIMISTA: la real llega antes.
 *
 * Por eso la separacion inicial se DESPEJA en vez de elegirse. Como la cobertura
 * es una serie geometrica de razon `stepScale`, hay una unica separacion que da
 * la cobertura objetivo, y salir de ahi es o desperdiciar recorrido o no caber.
 */
function buildLadder(k: Knobs, ctx: BuildContext): Record<string, unknown> {
  const f = ctx.features;

  // Techo por CAPITAL antes que nada: el reparto de la escalera es proporcional
  // a pesos geometricos, asi que con seis niveles y poco capital los primeros
  // caen por debajo del notional minimo del venue y el bot nace mandando ordenes
  // que le rechazan una a una. Vale mas una escalera de tres niveles que cabe
  // que una de ocho que el exchange no acepta.
  const minNotional = Math.max(Number(ctx.market.minNotional ?? 0), 1);
  const levProvisional = leverageFor(k, ctx, 10);
  const cabenPorCapital = Math.floor((ctx.totalInvestment * levProvisional) / (minNotional * 1.6));
  const niveles = Math.round(
    clamp(Math.min(6 * FACTOR[k.coverage], Math.max(cabenPorCapital, 1)), 1, 12),
  );
  const stepScale = clamp(1.1 * FACTOR[k.spread], 1, 3);
  const volumeScale = clamp(1.2 * FACTOR[k.sizeGrowth], 1, 2.5);
  const lev = levProvisional;

  // Cuanto recorrido adverso se quiere cubrir, atado a lo que este par se mueve
  // de verdad y acotado por lo que cabe antes de la liquidacion.
  const distanciaLiq = 100 / lev;
  const deseada = Math.max(2 * f.atrPct1d, 0.6 * f.rangePct30) * FACTOR[k.coverage];
  const objetivo = clamp(deseada, distanciaLiq * 0.35, distanciaLiq * 0.85);

  // Se despeja la separacion que da exactamente esa cobertura.
  const suma = ladderCoveragePct(niveles, 1, stepScale);
  const separacion = clamp(objetivo / suma, 0.05, 20);

  // El objetivo no puede quedar por debajo del coste de cruzar el libro: un
  // beneficio menor que la comision no es beneficio.
  const sueloTp = (4 * f.tickBps) / 100 + 0.1;
  const tp = clamp(f.atrPct1h * 1.5 * (2 - FACTOR[k.cadence]), sueloTp, 50);

  return {
    leverage: lev,
    numLimitBuys: niveles,
    initialSeparationPct: stepped(separacion, 0.05, 20, 0.05, 2),
    stepScale: stepped(stepScale, 1, 3, 0.05, 2),
    volumeScale: stepped(volumeScale, 1, 5, 0.1, 1),
    takeProfitPct: stepped(tp, 0.05, 50, 0.05, 2),
    baseOrderType: k.profile === 'PRUDENTE' ? 'LIMIT' : 'MARKET',
    tpMode: 'LIMIT',
    cooldownMinutes: Math.round(clamp(10 / FACTOR[k.cadence], 0, 10080)),
  };
}

/** GridMart: la escalera de martingala mas su rejilla de ventas. */
function buildGridMart(k: Knobs, ctx: BuildContext): Record<string, unknown> {
  const base = buildLadder(k, ctx);
  const tp = Number(base['takeProfitPct']);
  return {
    ...base,
    classicMode: false,
    satelliteTpPct: stepped(tp * 0.6, 0.05, 20, 0.05, 2),
    gridSellCount: Math.round(clamp(4 * FACTOR[k.coverage], 1, 20)),
    gridSellInitialSeparationPct: stepped(tp, 0.05, 20, 0.05, 2),
    gridSellDistanceMultiplier: stepped(clamp(1.1 * FACTOR[k.spread], 1, 3), 1, 3, 0.05, 2),
    // Cuanto del nucleo se suelta en el primer escalon. El prudente suelta mas
    // pronto: recupera capital antes aunque renuncie a parte del recorrido.
    corePctSoldAtLevel1: Math.round(clamp(25 / FACTOR[k.sizeGrowth], 1, 100)),
    gridSellQtyMultiplier: stepped(1, 0.1, 3, 0.05, 2),
    gridRebuyDiscountPct: stepped(tp / 2, 0.05, 20, 0.05, 2),
  };
}

/**
 * Rejillas: clasica y neutral.
 *
 * Dos decisiones mandan: cuanto se abre el rango —en multiplos de lo que este
 * par se mueve, nunca en un porcentaje fijo— y cuantas lineas caben dentro. Lo
 * segundo NO se elige libremente: el paso resultante tiene que superar dos ticks
 * del mercado, o al redondear las lineas se solapan y la rejilla deja de existir.
 *
 * El apalancamiento se topa a 3 aunque el usuario admita mas: una rejilla con
 * todas sus lineas llenas es una posicion apalancada SIN escalera de rescate.
 */
function buildGrid(k: Knobs, ctx: BuildContext, neutral: boolean): Record<string, unknown> {
  const f = ctx.features;
  const market = ctx.market;
  const tick = Number(market.tickSize) || 0;
  const lev = leverageFor(k, ctx, 3);

  // Medio ancho del rango, en % y en multiplos del recorrido diario.
  const medio = clamp(
    Math.max(3 * f.atrPct1d, f.rangePct30 / 2) * FACTOR[k.spread],
    2 * f.atrPct1d,
    60,
  );

  // En la rejilla clasica, que solo compra, el centro se baja si el precio esta
  // pegado al techo del rango reciente: centrarla ahi seria comprar en maximos.
  const sesgo = !neutral && f.posInRange > 0.7 ? 1 - (0.25 * medio) / 100 : 1;
  const centro = f.mark * sesgo;

  const lower = floorToTick(centro * (1 - medio / 100), tick);
  const upper = ceilToTick(centro * (1 + medio / 100), tick);

  // Numero de lineas por PASO objetivo, no al reves.
  const pasoPct = clamp(f.atrPct1h * FACTOR[k.spread], (4 * f.tickBps) / 100, medio / 2);
  let lineas = Math.round((2 * medio) / Math.max(pasoPct, 0.01)) + 1;

  // Techo por el tick: el paso no puede bajar de dos ticks.
  if (tick > 0 && upper > lower) {
    const maxPorTick = Math.floor((upper - lower) / (2 * tick)) + 1;
    lineas = Math.min(lineas, maxPorTick);
  }
  // Techo por el notional minimo del venue: mas lineas de las que el capital
  // puede llenar deja ordenes que el exchange rechaza una a una.
  const minNotional = Number(market.minNotional ?? 0);
  if (minNotional > 0) {
    lineas = Math.min(lineas, Math.floor((ctx.totalInvestment * lev) / (minNotional * 1.2)));
  }
  lineas = Math.round(clamp(lineas, neutral ? 4 : 3, 200));

  const decimales = market.priceDecimals ?? 2;
  const comun: Record<string, unknown> = {
    leverage: lev,
    lowerPrice: dec(lower, decimales),
    upperPrice: dec(upper, decimales),
    gridLevels: lineas,
    gridSpacing: medio > 25 ? 'GEOMETRIC' : 'ARITHMETIC',
  };

  if (!neutral) {
    return {
      ...comun,
      sizingMode: 'QUOTE',
      // Salirse del rango con la rejilla puesta es quedarse con la posicion
      // entera en contra. Solo el perfil agresivo lo desactiva.
      stopOnRangeExit: k.profile !== 'AGRESIVA',
    };
  }

  return {
    ...comun,
    // Pegado al borde dejaria una de las dos patas sin lineas.
    anchorPrice: dec(clamp(f.mark, lower + tick, upper - tick), decimales),
    sizeMultiplier: stepped(clamp(1 * FACTOR[k.sizeGrowth], 1, 3), 1, 3, 0.05, 2),
    // Sin tope de exposicion la posicion neta crece hasta agotar el margen; el
    // propio validador avisa de ello.
    maxExposure: dec(ctx.totalInvestment * lev * 0.8, 2),
  };
}

/**
 * DCA temporizado.
 *
 * El importe por compra se DERIVA del capital y del numero de compras, nunca al
 * reves: si se eligiera libremente, el plan de compras podria superar el capital
 * —que es un ERROR duro del validador— y ademas nadie sabe cuanto es «poco» sin
 * saber cuantas veces va a comprar.
 *
 * Apalancamiento 1 salvo en agresivo: apalancar la estrategia paciente
 * contradice su propia tesis.
 */
function buildDca(k: Knobs, ctx: BuildContext): Record<string, unknown> {
  const f = ctx.features;
  const lev = Math.min(leverageFor(k, ctx, 2), k.profile === 'AGRESIVA' ? 2 : 1);
  const minNotional = Math.max(Number(ctx.market.minNotional ?? 0), 1);

  // Cuantas compras caben con el capital, sin bajar del minimo del venue.
  const techoPorCapital = Math.floor(ctx.totalInvestment / Math.max(minNotional * 1.2, 1));
  const deseadas = Math.round(20 * FACTOR[k.coverage]);
  const compras = Math.round(clamp(Math.min(deseadas, techoPorCapital), 1, 500));

  const porCompra = Math.max(1, Math.floor((ctx.totalInvestment / compras) * 100) / 100);

  // En un par que se mueve mucho se espacian las compras: comprar cada hora en
  // algo que respira un 5 % diario es promediar contra el ruido.
  const minutos = Math.round(
    clamp((240 / FACTOR[k.cadence]) * clamp(20 / Math.max(f.atrPct1d, 0.5), 0.5, 2), 1, 10080),
  );

  return {
    leverage: lev,
    amountPerBuy: dec(porCompra, 2),
    maxBuysPerCycle: compras,
    intervalMinutes: minutos,
    buyOnlyIfImprovesAverage: true,
    marginBelowAveragePct: stepped(clamp(0.5 / FACTOR[k.cadence], 0, 100), 0, 100, 0.1, 1),
    takeProfitPct: stepped(
      clamp(f.atrPct1d * 2 * (2 - FACTOR[k.cadence]), 0.05, 100),
      0.05,
      100,
      0.05,
      2,
    ),
    maxPositionNotional: dec(ctx.totalInvestment * lev, 2),
  };
}

/**
 * Market makers, V1 y V2.
 *
 * Todo cuelga del SUELO POR COSTE: la comision de ida y vuelta mas el margen de
 * beneficio minimo. Cotizar por debajo de ese suelo es perder en cada
 * operacion, por mucho que se ejecuten las dos patas. El diferencial se calcula
 * hacia arriba desde ahi, nunca desde una cifra bonita.
 *
 * `minAllowedDistanceBps` se deriva de las distancias de cotizacion para que
 * cumpla `min <= min(compra, venta)` POR CONSTRUCCION. V1 valida esa relacion;
 * V2 no, asi que si se eligiera libre, V2 aceptaria una configuracion incoherente.
 */
function buildMarketMaker(k: Knobs, ctx: BuildContext, v2: boolean): Record<string, unknown> {
  const f = ctx.features;
  const lev = leverageFor(k, ctx, 3);

  const feeBps = 2;
  const margenMinimo = 8;
  const suelo = 2 * feeBps + margenMinimo + 1.5;

  const maxBps = v2 ? 2000 : 1000;

  // El horizonte de una cotizacion viva son MINUTOS, no una hora (spec 035).
  //
  // Antes esto era `0,35 x ATR(1h)`, que sobre un par con ATR del 2,9 % pedia
  // 102 bps por lado: eso no es cotizar, es pedir como mucho una ejecucion por
  // hora. La cotizacion vive lo que tarda en recotizarse o caducar, asi que la
  // referencia es el recorrido esperado en esa ventana. Con escalado por raiz,
  // el recorrido a cinco minutos es ATR(1h)/sqrt(12).
  const recorrido5m = (f.atrPct1h * 100) / Math.sqrt(12);
  const objetivo = clamp(
    Math.max(0.5 * recorrido5m * FACTOR[k.spread], suelo + 2),
    suelo + 2,
    maxBps,
  );

  // Y la volatilidad NO se cuenta dos veces (spec 035).
  //
  // En la V2, `composeSpreadBps` vuelve a sumar el margen de libro, la comision
  // de ida y vuelta, el colchon y `volatilityMultiplier x recorrido`. Escribir
  // el objetivo entero en `buyDistanceBps` hacia que el bot cotizase a la suma
  // de las dos: el asesor creia haber pedido 102 bps y el bot ponia 121. Aqui se
  // escribe el RESTO, y el suelo por coste de la propia estrategia se encarga de
  // que nunca baje de lo que cuesta operar.
  const volMulNum = clamp(0.35 * FACTOR[k.spread], 0, 5);
  const volMul = stepped(volMulNum, 0, 5, 0.05, 2);
  const yaSumado = v2 ? 1.5 + 2 * feeBps + 1 + volMulNum * recorrido5m : 0;
  const distancia = Math.round(clamp(objetivo - yaSumado, 1, maxBps));

  // El suelo por coste, que es lo que este campo dice ser. Antes era
  // `0,4 x spread`: un umbral de deriva disfrazado de suelo.
  //
  // En la V1 hay que llegar a un compromiso, porque alli el mismo campo hace DOS
  // trabajos: es el suelo de la cotizacion Y el umbral de deriva que dispara una
  // recotizacion (spec 035, F-01). El suelo por coste a secas —catorce puntos
  // basicos— frente a una distancia de sesenta convierte el bot en una maquina
  // de recolocar ordenes que nadie ha tocado, y en Lighter eso es cuota. La
  // mitad de la distancia respeta las dos funciones: cubre el coste de sobra y
  // no recotiza antes de que el mercado haya hecho medio camino.
  //
  // La V2 no lo necesita: tiene `repriceThresholdBps` aparte, asi que aqui el
  // campo puede ser lo que dice ser.
  const sueloEfectivo = v2 ? suelo : Math.max(suelo, distancia * 0.5);
  const minDistancia = Math.round(clamp(Math.min(sueloEfectivo, distancia - 1), 1, 500));

  const minNotional = Math.max(Number(ctx.market.minNotional ?? 0), 1);
  // Cada capa cotiza a los DOS lados, asi que N capas son 2N ordenes vivas. Con
  // poco capital, repartirlo entre seis ordenes las deja a todas por debajo del
  // minimo del venue.
  //
  // El divisor tiene que ser el MISMO que el del reparto de abajo, o el techo no
  // sirve de nada: se calculaba con `minNotional * 1.5 * 2` mientras el reparto
  // dividia entre `capas * 2 * 3`, asi que autorizaba capas cuyo tamano por lado
  // acababa por debajo del minimo del venue.
  const capasPorCapital = Math.floor((ctx.totalInvestment * lev) / (2 * 3 * minNotional * 1.2));
  const capas = Math.round(
    clamp(
      Math.min((v2 ? 2 : 3) * FACTOR[k.sizeGrowth], Math.max(capasPorCapital, 1)),
      1,
      v2 ? 3 : 10,
    ),
  );

  // El tamano por lado sale del CAPITAL, y el minimo del venue no puede
  // pasarsele por encima.
  //
  // Antes esto era un `Math.max(loQueCabe, minNotional * 1.2)`, y ese maximo
  // convertia el minimo del exchange en el tamano real: con 50 USDC en un par
  // cuyo minimo son 50, salia una configuracion que pedia 120 de margen. Pasaba
  // `validate()` y pasaba `preview()` —los dos miran el venue, no la cartera— y
  // el usuario la habria aplicado sin que nada se lo dijera.
  //
  // Ahora, si no cabe, se devuelve un tamano por debajo del minimo a proposito:
  // el `preview()` lo marcara como violacion y el perfil se descarta con motivo.
  const porLado = Math.floor(((ctx.totalInvestment * lev) / (capas * 2 * 3)) * 100) / 100;
  const defensivo = Math.round(clamp(70 * FACTOR[k.coverage], 1, 94));
  const alto = Math.round(clamp(defensivo + 10, defensivo + 1, 100));
  const refresco = Math.round(clamp(30 / FACTOR[k.cadence], 15, 3600 / 5) / 5) * 5;

  const comun: Record<string, unknown> = {
    leverage: lev,
    direction: 'NEUTRAL',
    orderSizePerSide: dec(porLado, 2),
    maxBotPositionValue: dec(ctx.totalInvestment * lev * clamp(FACTOR[k.coverage], 0.4, 1), 2),
    sizingMode: 'QUOTE',
    buyDistanceBps: distancia,
    sellDistanceBps: distancia,
    minAllowedDistanceBps: minDistancia,
    postOnly: true,
    defensiveThresholdPct: defensivo,
    highRiskThresholdPct: alto,
    refreshSeconds: Math.max(15, refresco),
    layers: capas,
    // Con varias capas el suelo es 1,05 y no 1: con 1 todas caen al MISMO
    // precio, y la banda MUY_BAJA daba justo eso (1,4 x 0,55 = 0,77, acotado a
    // 1). El asesor generaba asi una configuracion que la estrategia rechaza
    // (spec 037 R-2).
    layerDistanceMultiplier: stepped(
      clamp(1.4 * FACTOR[k.spread], capas > 1 ? 1.05 : 1, 3),
      capas > 1 ? 1.05 : 1,
      3,
      0.05,
      2,
    ),
    layerSizeMultiplier: stepped(clamp(1 * FACTOR[k.sizeGrowth], 0.1, 3), 0.1, 3, 0.05, 2),
    // Al tocar el tope, el prudente cierra; los demas dejan de abrir pero
    // conservan lo que tengan.
    limitAction: k.profile === 'PRUDENTE' ? 'CLOSE_ALL' : 'PAUSE_ENTRIES',
    dynamicSpread: true,
  };

  if (!v2) {
    return {
      ...comun,
      riskProfile:
        k.profile === 'PRUDENTE'
          ? 'CONSERVATIVE'
          : k.profile === 'AGRESIVA'
            ? 'AGGRESSIVE'
            : 'BALANCED',
      autoAdjustDistance: k.profile === 'AGRESIVA',
      inventoryPriceAdjustment: true,
      inventorySkewFactor: stepped(clamp(1 * FACTOR[k.sizeGrowth], 0, 3), 0, 3, 0.05, 2),
    };
  }

  return {
    ...comun,
    behaviorPreset:
      k.profile === 'PRUDENTE'
        ? 'CONSERVATIVE'
        : k.profile === 'AGRESIVA'
          ? 'AGGRESSIVE'
          : 'BALANCED',
    feeEstimateBps: dec(feeBps, 1),
    safetyBufferBps: dec(1, 1),
    minProfitMarginBps: dec(margenMinimo, 1),
    orderBookMarginBps: dec(1.5, 1),
    // El centro solo se recalcula cuando el mercado ha recorrido una cotizacion
    // entera. Era `spread x 0,5`, que recotizaba a mitad de camino (spec 035).
    repriceThresholdBps: Math.round(clamp(objetivo, 1, 1000)),
    orderMaxAgeSeconds: Math.round(clamp(300 / FACTOR[k.cadence], 0, 86400) / 5) * 5,
    fillCooldownSeconds: Math.round(clamp(35 / FACTOR[k.cadence], 0, 3600) / 5) * 5,
    volatilitySampleSeconds: 300,
    volatilityMultiplier: volMul,
    // El techo dinamico nunca puede quedar por debajo del suelo por coste, o el
    // bot no podria cotizar con beneficio en ningun momento.
    maxDynamicSpreadBps: Math.round(clamp(objetivo * 4, suelo, 5000)),
    useFullSizeUntilMax: k.profile === 'AGRESIVA',
  };
}

/**
 * Direccion efectiva de la estrategia.
 *
 * Los dos market makers cotizan a los dos lados por definicion, asi que ahi es
 * siempre NEUTRAL por mucho que se pida otra cosa. La rejilla neutral admite las
 * tres. El resto solo tiene sentido en un sentido, y NEUTRAL no es uno de ellos.
 */
function directionFor(kind: string, pedida: 'LONG' | 'SHORT' | 'NEUTRAL'): string {
  if (kind === 'MARKET_MAKER' || kind === 'MARKET_MAKER_V2') return 'NEUTRAL';
  if (kind === 'NEUTRAL_GRID') return pedida;
  return pedida === 'SHORT' ? 'SHORT' : 'LONG';
}

/**
 * Punto de entrada: perillas + contexto -> configuracion completa.
 *
 * Devuelve solo los campos que esta funcion decide. El resto los pone
 * `defaults()` de la estrategia, que el repo ya garantiza coherente con el
 * descriptor.
 */
/**
 * Seguimiento de tendencia (spec 040).
 *
 * Lo que hay que acertar aqui no es la senal, es el TAMANO: la posicion sale de
 * `riesgo / (k x ATR)`, asi que el multiplicador del stop y el riesgo por
 * operacion son los dos unicos numeros que mueven el dinero. Todo lo demas
 * -intervalo, canal- cambia cuantas veces opera, no cuanto arriesga.
 *
 * Y una regla que no se negocia: el stop NUNCA por debajo de 1,5 ATR. Un stop
 * mas pegado no es prudencia, es salirse en el primer respiro del mercado una y
 * otra vez, pagando la comision cada vez. La estrategia lo avisa al validar; el
 * asesor directamente no lo propone.
 */
function buildTrend(k: Knobs, ctx: BuildContext): Record<string, unknown> {
  const f = ctx.features;
  const lev = Math.min(leverageFor(k, ctx, 5), k.profile === 'PRUDENTE' ? 2 : 3);

  // Mas apetito de cadencia, velas mas cortas. Con velas de 15 min el bot opera
  // mucho mas y acierta menos: es una decision de caracter, no de mercado.
  const intervalos = ['1d', '4h', '4h', '1h', '15m'] as const;
  const candleInterval = intervalos[BANDS.indexOf(k.cadence)] ?? '4h';

  // El canal: mas cobertura, mas velas, y por tanto rupturas mas raras y mas
  // fiables.
  const breakoutPeriod = Math.round(clamp(20 * FACTOR[k.coverage], 5, 100));

  // El stop: mas holgura pedida, mas ATR de margen. Suelo duro en 1,5.
  const atrStopMultiplier = stepped(clamp(2.5 * FACTOR[k.spread], 1.5, 6), 1.5, 6, 0.1, 1);

  // El riesgo por operacion: el mando que de verdad decide cuanto se pierde en
  // una mala racha. Con cuatro aciertos de cada diez, un 2 % encadena caidas muy
  // profundas, asi que el techo es 2 aunque el campo admita 5.
  const riskPerTradePct = stepped(clamp(1 * FACTOR[k.sizeGrowth], 0.2, 2), 0.1, 5, 0.1, 1);

  // La exigencia de que el mercado vaya a algun sitio se calibra con el mercado
  // que hay: en uno que ya va recto se puede pedir menos, porque la senal es
  // mas limpia; en uno que va y viene, mas.
  const entryEfficiency = stepped(
    clamp(0.35 * (2 - FACTOR[k.coverage]) * (f.efficiency > 0.5 ? 0.8 : 1.2), 0.1, 0.9),
    0,
    1,
    0.05,
    2,
  );

  return {
    leverage: lev,
    candleInterval,
    breakoutPeriod,
    atrPeriod: 14,
    atrStopMultiplier,
    riskPerTradePct,
    entryEfficiency,
    stopRepriceBps: stepped(clamp(20 / FACTOR[k.cadence], 1, 200), 1, 200, 1, 0),
    allowShort: k.profile !== 'PRUDENTE',
    maxNotionalCap: dec(ctx.totalInvestment * lev, 2),
  };
}

/**
 * Seguimiento de beneficio (spec 043).
 *
 * Aqui solo hay dos numeros que decidan algo, y los dos se miden contra lo que
 * RESPIRA el par, no contra un gusto:
 *
 * - El objetivo, a partir del cual empieza a seguir. Ponerlo por debajo del
 *   recorrido tipico de un dia es pedirle al bot que se active con el ruido.
 * - El retroceso, que decide cuando cierra. Por debajo del recorrido de una
 *   hora, cualquier respiro del par lo dispara: esa es la unica forma de que
 *   esta estrategia sea peor que un objetivo fijo, y es facil de evitar.
 *
 * El apalancamiento va corto a proposito: es una posicion direccional entera,
 * sin escalera que promedie ni cotizacion que recupere.
 */
function buildTrailing(k: Knobs, ctx: BuildContext): Record<string, unknown> {
  const f = ctx.features;
  const lev = Math.min(leverageFor(k, ctx, 5), k.profile === 'PRUDENTE' ? 2 : 3);

  // El objetivo: al menos un dia tipico de recorrido, y mas cuanto mas se pida
  // cubrir. En un par que se mueve un 4 % al dia, un objetivo del 1 % se activa
  // con el ruido de la mañana.
  const objetivo = clamp(Math.max(f.atrPct1d * 1.5, 3) * FACTOR[k.coverage], 1, 100);

  // El retroceso: por encima del recorrido de una hora, que es la sacudida que
  // no significa nada. Mas cadencia pedida, retroceso mas fino y salidas mas
  // tempranas: es una decision de caracter.
  const retroceso = clamp(Math.max(f.atrPct1h, 0.5) * 1.5 * (2 - FACTOR[k.cadence]), 0.3, 10);

  // El stop: el que de verdad manda hasta que se llega al objetivo. Se ata a la
  // peor sesion del periodo para que no salte con una normal.
  const stop = clamp(Math.max(Math.abs(f.worstDayPct), f.atrPct1d * 2), 1, 30);

  return {
    leverage: lev,
    activationMode: 'NONE',
    takeProfitPct: stepped(objetivo, 0.1, 500, 0.1, 1),
    trailingCallbackPct: stepped(retroceso, 0.1, 10, 0.1, 1),
    trailingRepriceBps: stepped(clamp(20 / FACTOR[k.cadence], 1, 200), 1, 200, 1, 0),
    // Sin `trailingTakeProfit`: la estrategia no lo declara en su meta y aqui
    // el seguimiento esta siempre encendido (spec 044 R-4).
    stopLossPct: stepped(stop, 0.1, 90, 0.1, 1),
    maxNotionalCap: dec(ctx.totalInvestment * lev, 2),
  };
}

export function buildConfig(
  kind: string,
  knobs: Knobs,
  ctx: BuildContext,
): Record<string, unknown> {
  const capital = dec(ctx.totalInvestment, 2);

  let propio: Record<string, unknown>;
  switch (kind) {
    case 'GRID_CLASSIC':
      propio = buildGrid(knobs, ctx, false);
      break;
    case 'NEUTRAL_GRID':
      propio = buildGrid(knobs, ctx, true);
      break;
    case 'TDCA':
      propio = buildDca(knobs, ctx);
      break;
    case 'MARTINGALE':
      propio = buildLadder(knobs, ctx);
      break;
    case 'GRIDMART':
      propio = buildGridMart(knobs, ctx);
      break;
    case 'MARKET_MAKER':
      propio = buildMarketMaker(knobs, ctx, false);
      break;
    case 'MARKET_MAKER_V2':
      propio = buildMarketMaker(knobs, ctx, true);
      break;
    case 'TREND_FOLLOW':
      propio = buildTrend(knobs, ctx);
      break;
    case 'TRAILING_PROFIT':
      propio = buildTrailing(knobs, ctx);
      break;
    default:
      propio = {};
  }

  // La direccion se aplica AQUI y no en cada generador: se pedia en el cuerpo de
  // la peticion, se guardaba en el contexto y no la leia nadie, asi que pedir un
  // bot SHORT devolvia tres configuraciones LONG con su preview en LONG.
  return {
    ...propio,
    direction: directionFor(kind, ctx.direction),
    totalInvestment: capital,
  };
}
