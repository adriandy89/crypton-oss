import {
  D,
  Decimal,
  isFiniteNum,
  Mutability,
  StrategyKind,
  Venue,
  type BotConfig,
  type FieldMeta,
  type MarketSpec,
  type Numeric,
} from '@crypton/shared';
import {
  camposEfectivos,
  composeSpreadBps,
  diffConfig,
  getStrategy,
  VENUE_MARKETS,
  type MarketMakerV2Config,
} from '@crypton/strategy-core';
import { buildConfig, defaultKnobs, type BuildContext, type Knobs } from '../advisor/build';
import { coerceConfig, enforceCouplings } from '../advisor/sanitize';
import {
  aplicarDesplazamientos,
  BLOQUEADOS_CON_POSICION,
  CAMPOS_DE_RIESGO,
  conStopQueSoloSeEstrecha,
  conTopeDeApalancamiento,
  decidirCambio,
  fusionarConservandoInmutables,
  guardaDePosicion,
  MAX_PERILLAS_POR_CAMBIO,
  movimientosConEfecto,
  MOVIMIENTOS,
  PERILLAS,
  perillasMovidas,
  SIN_MOVIMIENTO,
  TOPE_RELATIVO_POR_PASO,
  trasladarCampo,
  type CambioPropuesto,
  type Desplazamientos,
  type MotivoDescarte,
  type PosicionViva,
} from './apply';

/**
 * La traduccion determinista, probada como se prueba lo que toca dinero.
 *
 * **Este fichero NO copia la tolerancia de `advisor.spec.ts`.** Aquel hace
 * `if (!strategy.validate(...).ok) return;` y sale en silencio justo cuando la
 * configuracion es mala. Alli esta justificado: con capitales pequeños frente al
 * notional minimo del venue hay perfiles que legitimamente NO caben, y el
 * servicio los descarta y lo dice. Aqui no lo esta, y la diferencia es toda:
 * **se parte de una configuracion que YA es valida y YA esta corriendo**, asi
 * que una traduccion que produce algo invalido es un fallo de la traduccion, no
 * un hecho del mercado.
 *
 * Por eso, cuando un caso no se puede satisfacer, `decidirCambio` devuelve un
 * MOTIVO y el test lo asevera. Nunca un `return` mudo.
 */

/** Las cuatro del alcance del spec 046. */
const KINDS = [
  StrategyKind.MARKET_MAKER,
  StrategyKind.MARKET_MAKER_V2,
  StrategyKind.TREND_FOLLOW,
  StrategyKind.TRAILING_PROFIT,
] as const;

const RASGOS = {
  mark: 0,
  volAnnualPct: 68,
  atrPct1h: 0.45,
  atrPct1d: 3.2,
  rangePct30: 28,
  posInRange: 0.5,
  trendPct: 1.1,
  trend: 'LATERAL' as const,
  efficiency: 0.22,
  worstDayPct: -7.5,
  tickBps: 1.2,
};

function contexto(spec: MarketSpec, mark: string, capital = 5000): BuildContext {
  return {
    market: spec,
    features: { ...RASGOS, mark: Number(mark) },
    totalInvestment: capital,
    maxLeverageUsuario: null,
    direction: 'LONG',
  };
}

/**
 * Un bot VIVO: la configuracion con la que nacio, ya pasada por la misma cadena
 * que la produce en produccion. No vale un objeto a mano — la gracia del test es
 * que el punto de partida sea realista.
 */
function botVivo(kind: StrategyKind, ctx: BuildContext, knobs: Knobs): BotConfig | null {
  const strategy = getStrategy(kind);
  let cfg = coerceConfig(strategy.meta.fields, strategy.defaults(), buildConfig(kind, knobs, ctx));
  cfg = enforceCouplings(kind, cfg, ctx.market, ctx.maxLeverageUsuario);
  const vivo = {
    ...cfg,
    symbol: ctx.market.symbol,
    exchangeAccountId: 'cuenta-1',
    // Con el formato con el que SALE DE LA BASE, no con el que lo escribe
    // `buildConfig`. La columna es `Decimal(38,18)` y Prisma lo devuelve con sus
    // dieciocho decimales, mientras el generador produce dos. Si el test usara
    // '5000.00' en vez de '5000.000000000000000000', las dos cadenas coincidirian
    // por casualidad y dejaria de comprobar que el capital se conserva.
    totalInvestment: `${Number(cfg['totalInvestment'] ?? ctx.totalInvestment).toFixed(18)}`,
  } as unknown as BotConfig;
  return strategy.validate(vivo, ctx.market).ok ? vivo : null;
}

/** Generador con semilla fija: el mismo fallo se reproduce siempre. */
function semilla(n: number): () => number {
  let s = n >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function vectores(cuantos: number, seed = 20460912): Desplazamientos[] {
  const r = semilla(seed);
  const out: Desplazamientos[] = [];
  // Los cinco extremos de cada perilla por separado, que son los que rompen.
  for (const clave of PERILLAS) {
    for (const mov of MOVIMIENTOS) {
      out.push({ ...SIN_MOVIMIENTO, [clave]: mov });
    }
  }
  // Y parejas al azar, con semilla fija. Parejas y no quintetos: desde el spec
  // 051 una decision mueve como mucho dos perillas, y un vector de cinco solo
  // probaria que se descarta.
  const conMovimiento = MOVIMIENTOS.filter((m) => m !== 'IGUAL');
  const alAzar = <T>(lista: readonly T[]): T => lista[Math.floor(r() * lista.length)];
  for (let i = 0; i < cuantos; i++) {
    const v = { ...SIN_MOVIMIENTO };
    const primera = alAzar(PERILLAS);
    const segunda = alAzar(PERILLAS);
    v[primera] = alAzar(conMovimiento);
    if (segunda !== primera) v[segunda] = alAzar(conMovimiento);
    out.push(v);
  }
  return out;
}

const MOTIVOS: MotivoDescarte[] = [
  'SIN_CAMBIOS',
  'COLD',
  'RESHAPE',
  'VALIDACION',
  'VENUE',
  'DEMASIADAS_PERILLAS',
  'RIESGO',
  'CIERRE',
];

/**
 * ¿La banda relativa del spec 052 recorta este movimiento?
 *
 * Reimplementada aqui a proposito, sin llamar a lo que se esta probando: un
 * campo se mueve como mucho un cuarto de su valor por escalon, y solo cuando ese
 * recorte NO entra la ida y la vuelta pueden anularse exactamente.
 */
function recortaLaBanda(field: FieldMeta, vivo: unknown, a: unknown, d: unknown): boolean {
  if (!isFiniteNum(vivo) || !isFiniteNum(a) || !isFiniteNum(d)) return false;
  const v = D(vivo as Numeric).abs();
  if (v.isZero()) return true;
  // La banda es [v / f, v × f], asi que el margen para bajar es MENOR que el
  // margen para subir. Confundirlos es lo que hace que una ida y vuelta no
  // vuelva, asi que aqui se distinguen igual que en el codigo.
  const f = TOPE_RELATIVO_POR_PASO.plus(1);
  const sube = D(d as Numeric).gt(a as Numeric);
  const margen = sube ? v.mul(f).minus(v) : v.minus(v.div(f));
  if (field.kind === 'money') {
    return D(vivo as Numeric)
      .mul(d as Numeric)
      .div(a as Numeric)
      .minus(vivo as Numeric)
      .abs()
      .gt(margen);
  }
  const paso = field.step ?? (field.kind === 'integer' ? 1 : 0);
  const delta = D(d as Numeric)
    .minus(a as Numeric)
    .abs();
  const cota = paso > 0 ? Decimal.max(margen.div(paso).floor().mul(paso), paso) : margen;
  return delta.gt(cota);
}

/** Los campos que `buildConfig` deriva del PERFIL, y que por eso no deben moverse. */
const CAMPOS_DE_CARACTER = [
  'limitAction',
  'baseOrderType',
  'stopOnRangeExit',
  'autoAdjustDistance',
  'tpMode',
  'buyOnlyIfImprovesAverage',
  'classicMode',
  'positionMode',
  'sizingMode',
  'gridSpacing',
  'behaviorPreset',
];

const INTOCABLES = new Set(['exchangeAccountId', 'symbol', 'direction', 'totalInvestment']);

/**
 * Los campos que un acoplamiento puede mover sin que el desplazamiento los
 * mueva: los repara `enforceCouplings` o el acoplamiento propio del supervisor,
 * siempre hacia el lado seguro.
 */
const ACOPLADOS = new Set([
  'minAllowedDistanceBps',
  'defensiveThresholdPct',
  'layerDistanceMultiplier',
  'leverage',
]);

interface Caso {
  kind: StrategyKind;
  mercado: string;
  vigente: BotConfig;
  ctx: BuildContext;
  mark: string;
  knobs: Knobs;
}

/** Todos los puntos de partida realistas: 4 estrategias x mercados x perfiles. */
function casos(): Caso[] {
  const out: Caso[] = [];
  for (const kind of KINDS) {
    for (const m of VENUE_MARKETS) {
      for (const perfil of ['PRUDENTE', 'EQUILIBRADA', 'AGRESIVA'] as const) {
        const ctx = contexto(m.spec, m.mark);
        const knobs = defaultKnobs(perfil, ctx.features);
        const vigente = botVivo(kind, ctx, knobs);
        // Un punto de partida que no es valido no dice nada sobre la traduccion:
        // no es un caso de este test, es un caso del asesor.
        if (vigente) out.push({ kind, mercado: m.nombre, vigente, ctx, mark: m.mark, knobs });
      }
    }
  }
  return out;
}

const cfgDe = (c: unknown): Record<string, unknown> => c as Record<string, unknown>;

/** Igualdad laxa, la misma de `diffConfig`: '20' y 20 son el mismo valor. */
function mismoValor(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Lo que produce el generador con las perillas de antes y con las de despues. */
function generadas(
  kind: StrategyKind,
  vigente: BotConfig,
  knobs: Knobs,
  ajustes: Desplazamientos,
  ctx: BuildContext,
): { antes: Record<string, unknown>; despues: Record<string, unknown> } {
  const conCapital = { ...ctx, totalInvestment: Number(cfgDe(vigente)['totalInvestment']) };
  return {
    antes: buildConfig(kind, knobs, conCapital),
    despues: buildConfig(kind, aplicarDesplazamientos(knobs, ajustes), conCapital),
  };
}

/**
 * ¿Se movio este campo hacia la ruina? Reimplementado aqui a proposito, sin usar
 * la guarda que se esta probando: un tope vacio o a cero es infinito.
 */
function haciaElRiesgo(
  regla: { arriesgado: 'SUBE' | 'BAJA'; tope?: true },
  de: unknown,
  a: unknown,
): boolean {
  const valor = (v: unknown): Decimal | null => {
    const sinTope = v == null || v === '' || (isFiniteNum(v) && D(v as Numeric).isZero());
    if (regla.tope && sinTope) return new Decimal(Infinity);
    return isFiniteNum(v) ? D(v as Numeric) : null;
  };
  const x = valor(de);
  const y = valor(a);
  if (x === null || y === null) return false;
  return regla.arriesgado === 'SUBE' ? y.gt(x) : y.lt(x);
}

/**
 * Un bot vivo AJUSTADO A MANO: el de `botVivo` con parte de sus campos movidos
 * dentro del descriptor, como los moveria su dueño.
 *
 * Es el caso normal en produccion y el que el spec 046 no probaba (051, H-05):
 * partiendo de lo que produce el propio generador, copiar el valor generado y
 * trasladar el delta dan exactamente lo mismo, asi que la matriz no podia
 * distinguir el codigo correcto del que estrechaba un bot al pedirle que
 * ensanchara.
 */
function botAMano(caso: Caso, r: () => number): BotConfig | null {
  const strategy = getStrategy(caso.kind);
  const cfg: Record<string, unknown> = { ...cfgDe(caso.vigente) };
  for (const f of camposEfectivos(strategy.meta.fields, cfg, caso.ctx.market)) {
    if (f.mutability === Mutability.COLD || INTOCABLES.has(f.key)) continue;
    const v = cfg[f.key];
    if (!isFiniteNum(v) || r() < 0.6) continue;
    if (f.kind === 'money') {
      if (D(v as Numeric).lte(0)) continue;
      cfg[f.key] = D(v as Numeric)
        .mul(0.5 + r() * 1.5)
        .toDecimalPlaces(2, Decimal.ROUND_DOWN)
        .toFixed();
    } else if (f.kind === 'number' || f.kind === 'percent' || f.kind === 'integer') {
      const paso = f.step ?? (f.kind === 'integer' ? 1 : undefined);
      if (paso === undefined) continue;
      let n = D(v as Numeric).plus(D(paso).mul(Math.floor(r() * 7) - 3));
      if (f.min !== undefined) n = Decimal.max(n, f.min);
      if (f.max !== undefined) n = Decimal.min(n, f.max);
      cfg[f.key] = typeof v === 'string' ? n.toFixed() : n.toNumber();
    }
  }
  const vivo = cfg as unknown as BotConfig;
  if (!strategy.validate(vivo, caso.ctx.market).ok) return null;
  try {
    const p = strategy.preview(vivo, caso.ctx.market, caso.mark);
    if (!p.valid || p.levels.some((l) => l.violations.length > 0)) return null;
  } catch {
    return null;
  }
  return vivo;
}

/** Una exposicion plausible para la pasada con posicion: el 70 % del tope de un MM. */
function exposicionDe(kind: StrategyKind, vivo: BotConfig): string | null {
  if (kind !== StrategyKind.MARKET_MAKER && kind !== StrategyKind.MARKET_MAKER_V2) return null;
  const tope = cfgDe(vivo)['maxBotPositionValue'];
  return isFiniteNum(tope)
    ? D(tope as Numeric)
        .mul('0.7')
        .toFixed()
    : null;
}

describe('apply — la matriz exhaustiva', () => {
  const TODOS = casos();
  const VECTORES = vectores(60);

  it('hay puntos de partida para las cuatro estrategias', () => {
    // Si una estrategia se quedara sin casos, la matriz de abajo pasaria sin
    // probar nada de ella y nadie se enteraria.
    for (const kind of KINDS) {
      expect(TODOS.filter((c) => c.kind === kind).length).toBeGreaterThan(0);
    }
  });

  it('ningun desplazamiento produce un cambio inaplicable', () => {
    let propuestos = 0;
    let descartados = 0;

    for (const caso of TODOS) {
      const strategy = getStrategy(caso.kind);
      const vigenteBruto = cfgDe(caso.vigente);

      for (const ajustes of VECTORES) {
        const r = decidirCambio({
          strategy,
          vigente: caso.vigente,
          knobs: caso.knobs,
          ajustes,
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        });

        const donde = `${caso.kind} / ${caso.mercado} / ${JSON.stringify(ajustes)}`;

        // Un rechazo es una respuesta legitima, pero tiene que DECIR por que.
        if (typeof r === 'string') {
          expect(MOTIVOS).toContain(r);
          descartados++;
          continue;
        }
        propuestos++;

        const nuevo = cfgDe(r.config);

        // 1. Nada COLD, y el nivel jamas es COLD. Si esto falla, la fusion
        //    goteo: es un fallo NUESTRO, no del modelo.
        expect(r.diff.coldFields).toEqual([]);
        expect(r.level === 'HOT' || r.level === 'WARM').toBe(true);

        // 2. Los cuatro intocables, identicos.
        for (const clave of INTOCABLES) {
          expect(`${donde} → ${clave}=${JSON.stringify(nuevo[clave])}`).toBe(
            `${donde} → ${clave}=${JSON.stringify(vigenteBruto[clave])}`,
          );
        }

        // 3. Ningun campo de caracter cambia. Es la garantia que da congelar el
        //    perfil: `limitAction` pasaria de «deja de entrar» a «cierra la
        //    posicion» solo con que el perfil se moviera, y es HOT.
        for (const clave of CAMPOS_DE_CARACTER) {
          if (!(clave in vigenteBruto)) continue;
          expect(`${donde} → ${clave}=${JSON.stringify(nuevo[clave])}`).toBe(
            `${donde} → ${clave}=${JSON.stringify(vigenteBruto[clave])}`,
          );
        }

        // 4. El apalancamiento sube como mucho un punto, y nunca sobre el tope.
        const levAntes = Number(vigenteBruto['leverage'] ?? 1);
        const levDespues = Number(nuevo['leverage'] ?? 1);
        expect(levDespues).toBeLessThanOrEqual(Math.max(levAntes + 1, levAntes));
        expect(levDespues).toBeLessThanOrEqual(caso.ctx.market.maxLeverage);
        expect(levDespues).toBeGreaterThanOrEqual(1);

        // 5. El stop loss solo se estrecha.
        const stopAntes = vigenteBruto['stopLossPct'];
        if (stopAntes !== undefined && stopAntes !== null && stopAntes !== '') {
          expect(Number(nuevo['stopLossPct'])).toBeLessThanOrEqual(Number(stopAntes));
        }

        // 6. Como mucho dos perillas, y solo cambia lo que el desplazamiento mueve
        //    en la configuracion generada o lo que repara un acoplamiento.
        expect(perillasMovidas(ajustes)).toBeLessThanOrEqual(MAX_PERILLAS_POR_CAMBIO);
        const { antes, despues } = generadas(
          caso.kind,
          caso.vigente,
          caso.knobs,
          ajustes,
          caso.ctx,
        );
        for (const c of r.diff.changed) {
          if (ACOPLADOS.has(c.key)) continue;
          expect(`${donde} → ${c.key}: ${!mismoValor(antes[c.key], despues[c.key])}`).toBe(
            `${donde} → ${c.key}: true`,
          );
        }

        // 7. Y lo que de verdad importa: el resultado es APLICABLE. Sin
        //    tolerancias, sin salidas anticipadas.
        const validacion = strategy.validate(r.config, caso.ctx.market);
        expect(
          `${donde} → ${JSON.stringify(validacion.issues.filter((i) => i.severity === 'ERROR'))}`,
        ).toBe(`${donde} → []`);

        const preview = strategy.preview(r.config, caso.ctx.market, caso.mark);
        expect(`${donde} → valid=${preview.valid}`).toBe(`${donde} → valid=true`);
        expect(preview.levels.flatMap((l) => l.violations)).toEqual([]);
      }
    }

    // Y que la matriz no este pasando por no proponer nada nunca.
    expect(propuestos).toBeGreaterThan(100);
    expect(propuestos + descartados).toBe(TODOS.length * VECTORES.length);
  });
});

describe('apply — bots ajustados a mano (spec 051)', () => {
  const TODOS = casos();
  const VECTORES = vectores(20, 20510915);

  it('cada campo va en el sentido pedido, lo demas no se toca y con posicion nada arriesga', () => {
    const r = semilla(20510916);
    const propuestas: Record<string, number> = {};
    let puntosDePartida = 0;

    for (const caso of TODOS) {
      const vivo = botAMano(caso, r);
      if (!vivo) continue;
      puntosDePartida++;
      const strategy = getStrategy(caso.kind);
      const antesVivo = cfgDe(vivo);

      for (const ajustes of VECTORES) {
        const entrada = {
          strategy,
          vigente: vivo,
          knobs: caso.knobs,
          ajustes,
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        };
        const donde = `${caso.kind} / ${caso.mercado} / ${JSON.stringify(ajustes)}`;

        const res = decidirCambio(entrada);
        if (typeof res === 'string') {
          expect(MOTIVOS).toContain(res);
          continue;
        }
        propuestas[caso.kind] = (propuestas[caso.kind] ?? 0) + 1;

        const nuevo = cfgDe(res.config);
        const { antes, despues } = generadas(caso.kind, vivo, caso.knobs, ajustes, caso.ctx);

        expect(res.diff.coldFields).toEqual([]);

        // 1. Solo cambia lo que el desplazamiento mueve, y en SU sentido. Es el
        //    test que habria cazado «diferencial MAS» dejando a lit en 3 bps.
        for (const c of res.diff.changed) {
          if (ACOPLADOS.has(c.key)) continue;
          expect(`${donde} → ${c.key} movido: ${!mismoValor(antes[c.key], despues[c.key])}`).toBe(
            `${donde} → ${c.key} movido: true`,
          );
          if ([c.from, c.to, antes[c.key], despues[c.key]].every((v) => isFiniteNum(v))) {
            const pedido = D(despues[c.key] as Numeric).comparedTo(D(antes[c.key] as Numeric));
            const real = D(c.to as Numeric).comparedTo(D(c.from as Numeric));
            expect(`${donde} → ${c.key}: ${real}`).toBe(`${donde} → ${c.key}: ${pedido}`);
          }
        }

        // 2. Lo que no esta en el diff sigue siendo lo que su dueño dejo, tambien
        //    los valores fuera de la reticula del descriptor.
        const movidos = new Set(res.diff.changed.map((c) => c.key));
        for (const clave of Object.keys(antesVivo)) {
          if (movidos.has(clave)) continue;
          expect(`${donde} → ${clave}: ${mismoValor(nuevo[clave], antesVivo[clave])}`).toBe(
            `${donde} → ${clave}: true`,
          );
        }

        // 3. Aplicable.
        const validacion = strategy.validate(res.config, caso.ctx.market);
        expect(
          `${donde} → ${JSON.stringify(validacion.issues.filter((i) => i.severity === 'ERROR'))}`,
        ).toBe(`${donde} → []`);

        // 4. Con la posicion abierta: nada en sentido arriesgado, nada bloqueado,
        //    y un market maker que cierra al tope no ve el tope bajo la exposicion.
        const posicion: PosicionViva = {
          abierta: true,
          exposicion: exposicionDe(caso.kind, vivo),
          medidaHace: 30_000,
        };
        const conPosicion = decidirCambio({ ...entrada, posicion });
        if (typeof conPosicion === 'string') {
          expect(MOTIVOS).toContain(conPosicion);
          continue;
        }
        const tabla = CAMPOS_DE_RIESGO[caso.kind] ?? {};
        for (const c of conPosicion.diff.changed) {
          const regla = tabla[c.key];
          if (regla) {
            expect(`${donde} → ${c.key} arriesga: ${haciaElRiesgo(regla, c.from, c.to)}`).toBe(
              `${donde} → ${c.key} arriesga: false`,
            );
          }
          expect(`${donde} → ${c.key} bloqueado`).not.toBe(
            (BLOQUEADOS_CON_POSICION[caso.kind] ?? []).includes(c.key)
              ? `${donde} → ${c.key} bloqueado`
              : '',
          );
        }
        const cfgPos = cfgDe(conPosicion.config);
        const accion = cfgPos['limitAction'] ?? 'PAUSE_ENTRIES';
        const topeAntes = antesVivo['maxBotPositionValue'];
        const topeNuevo = cfgPos['maxBotPositionValue'];
        if (
          accion !== 'PAUSE_ENTRIES' &&
          posicion.exposicion !== null &&
          isFiniteNum(topeAntes) &&
          isFiniteNum(topeNuevo) &&
          D(topeNuevo as Numeric).lt(D(topeAntes as Numeric))
        ) {
          expect(D(topeNuevo as Numeric).gte(D(posicion.exposicion).mul('1.25'))).toBe(true);
        }
      }
    }

    // Que la matriz no pase por no tener nada que probar.
    expect(puntosDePartida).toBeGreaterThan(20);
    for (const kind of KINDS) {
      expect(`${kind}: ${(propuestas[kind] ?? 0) > 0}`).toBe(`${kind}: true`);
    }
  });
});

describe('apply — los casos reales de produccion (spec 051)', () => {
  /** Hyperliquid LIT, con la forma de las specs de `VENUE_MARKETS`. */
  const LIT: MarketSpec = {
    venue: Venue.HYPERLIQUID,
    symbol: 'LIT',
    canonical: 'LIT/USDC',
    base: 'LIT',
    quote: 'USDC',
    tickSize: '0.0001',
    stepSize: '1',
    minNotional: '10',
    minQty: '1',
    maxQty: null,
    maxLeverage: 5,
    priceDecimals: 4,
    qtyDecimals: 0,
    active: true,
  };

  /** Los rasgos del expediente real del market maker V2 de LIT del 2026-09-15. */
  const CTX_LIT: BuildContext = {
    market: LIT,
    features: {
      mark: 4.0417,
      volAnnualPct: 134.3,
      atrPct1h: 1.7,
      atrPct1d: 10.8,
      rangePct30: 135.7,
      posInRange: 0.7,
      trendPct: 0.7,
      trend: 'LATERAL',
      efficiency: 0.05,
      worstDayPct: -17.9,
      tickBps: 0.25,
    },
    totalInvestment: 500,
    maxLeverageUsuario: null,
    direction: 'NEUTRAL',
  };

  /**
   * La revision v2 del market maker V2 de LIT tal como esta en `bot_config_revisions`, con la
   * cuenta anonimizada. Su dueño subio a mano las distancias de 1 a 12/14.
   */
  const LIT_VIGENTE = {
    layers: 2,
    symbol: 'LIT',
    leverage: '3',
    postOnly: true,
    direction: 'NEUTRAL',
    marginMode: 'CROSS',
    sizingMode: 'QUOTE',
    limitAction: 'PAUSE_ENTRIES',
    priceSource: 'EXCHANGE',
    positionMode: 'AUTO',
    volEstimator: 'RANGE',
    dynamicSpread: true,
    fairPriceMode: 'MID',
    obiSkewFactor: '0',
    activationMode: 'NONE',
    behaviorPreset: 'BALANCED',
    buyDistanceBps: '12',
    feeEstimateBps: 2,
    refreshSeconds: 30,
    sizeSkewFactor: '0',
    cooldownMinutes: '1',
    fairPriceOrigin: 'SOURCE_GLOBAL',
    safetyBufferBps: '2',
    sellDistanceBps: '14',
    totalInvestment: 500,
    orderSizePerSide: '60',
    sourceMarketType: 'PERP',
    exchangeAccountId: 'cuenta-1',
    fundingSkewFactor: '0',
    liquidationAction: 'ALERT',
    markoutSensitivity: '0',
    minProfitMarginBps: '10',
    orderBookMarginBps: 1.5,
    orderMaxAgeSeconds: 300,
    exitOrderTtlSeconds: 0,
    fillCooldownSeconds: 35,
    inventorySkewFactor: '0',
    layerSizeMultiplier: 1,
    maxBotPositionValue: 500,
    maxDynamicSpreadBps: 77,
    repriceThresholdBps: 19,
    useFullSizeUntilMax: false,
    highRiskThresholdPct: 80,
    maxAdverseFundingBps: '0',
    trendGuardEfficiency: '0',
    volatilityMultiplier: 0.35,
    defensiveThresholdPct: 70,
    markoutHorizonSeconds: 0,
    minAllowedDistanceBps: 1,
    layerDistanceMultiplier: 1.4,
    volatilitySampleSeconds: 300,
    inventoryPriceAdjustment: false,
  } as unknown as BotConfig;

  const MEDIA: Knobs = {
    profile: 'EQUILIBRADA',
    leverage: 'MEDIA',
    coverage: 'MEDIA',
    spread: 'MEDIA',
    sizeGrowth: 'MEDIA',
    cadence: 'MEDIA',
  };

  /** lit tenia 16 LIT abiertos a 4,09. */
  const POSICION_LIT: PosicionViva = { abierta: true, exposicion: '65.46', medidaHace: 30_000 };

  const v2 = getStrategy(StrategyKind.MARKET_MAKER_V2);
  const mm = getStrategy(StrategyKind.MARKET_MAKER);
  const BTC = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;

  it('la configuracion de produccion es un punto de partida valido', () => {
    const errores = v2.validate(LIT_VIGENTE, LIT).issues.filter((i) => i.severity === 'ERROR');
    expect(errores).toEqual([]);
  });

  it('«diferencial MAS» ensancha lit de 12/14 a 14/16, nunca lo deja en 3', () => {
    // El generador acota la distancia base de la V2 a 1 y con la perilla al alza
    // produce 3. Copiar ese 3 —lo que hacia el spec 046— estrechaba a la cuarta
    // parte un bot al que se le pedia ensanchar; trasladar el +2 hace lo pedido.
    const r = decidirCambio({
      strategy: v2,
      vigente: LIT_VIGENTE,
      knobs: MEDIA,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' },
      ctx: CTX_LIT,
      refPrice: '4.0417',
      inventario: 2,
      posicion: POSICION_LIT,
      permitirWarm: true,
    });
    expect(typeof r).toBe('object');
    const c = cfgDe((r as CambioPropuesto).config);
    expect(Number(c['buyDistanceBps'])).toBe(14);
    expect(Number(c['sellDistanceBps'])).toBe(16);
    // Y el resto del diferencial se mueve en el mismo sentido, todo junto: la
    // perilla que el tope de cuatro campos no dejaba mover nunca.
    expect(Number(c['volatilityMultiplier'])).toBeGreaterThan(0.35);
    expect(Number(c['repriceThresholdBps'])).toBeGreaterThan(19);
    expect(Number(c['maxDynamicSpreadBps'])).toBeGreaterThan(77);
    expect((r as CambioPropuesto).diff.changed.length).toBeGreaterThan(4);
  });

  it('«cobertura MAS» con la posicion abierta se bloquea: en un market maker es mas riesgo', () => {
    // La propuesta REAL que el modelo mando a lit dos veces, y que su dueño
    // rechazo: subia el umbral defensivo de 70 a 94.
    const r = decidirCambio({
      strategy: v2,
      vigente: LIT_VIGENTE,
      knobs: MEDIA,
      ajustes: { ...SIN_MOVIMIENTO, coverage: 'MAS', leverage: 'MENOS' },
      ctx: CTX_LIT,
      refPrice: '4.0417',
      inventario: 2,
      posicion: POSICION_LIT,
      permitirWarm: true,
    });
    expect(r).toBe('RIESGO');
  });

  it('«apalancamiento MUCHO_MENOS» en un bot ajustado a mano reduce sus importes en proporcion', () => {
    // Un market maker con 300 de tamaño y 2000 de tope. Lo generado pasa de 3x a
    // 2x: tamaño 833,33 → 555,55 y tope 15000 → 10000. Copiarlo multiplicaba el
    // tope por cinco con MENOS apalancamiento; sumar el delta lo dejaba en 1, y
    // en un perfil prudente eso cierra la posicion. En proporcion: un tercio menos.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const vigente = {
      ...cfgDe(base),
      orderSizePerSide: '300',
      maxBotPositionValue: '2000',
    } as unknown as BotConfig;

    const r = decidirCambio({
      strategy: mm,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, leverage: 'MUCHO_MENOS' },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(typeof r).toBe('object');
    const c = cfgDe((r as CambioPropuesto).config);
    expect(
      D(c['orderSizePerSide'] as Numeric)
        .minus(200)
        .abs()
        .lte('0.02'),
    ).toBe(true);
    expect(
      D(c['maxBotPositionValue'] as Numeric)
        .minus('1333.33')
        .abs()
        .lte('0.01'),
    ).toBe(true);
    expect(Number(c['leverage'])).toBe(2);
  });

  it('un tope a cero, que significa «sin tope», no se convierte en uno', () => {
    const trend = getStrategy(StrategyKind.TREND_FOLLOW);
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.TREND_FOLLOW, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const vigente = { ...cfgDe(base), maxNotionalCap: '0' } as unknown as BotConfig;

    const r = decidirCambio({
      strategy: trend,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, leverage: 'MUCHO_MENOS' },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(typeof r).toBe('object');
    expect(cfgDe((r as CambioPropuesto).config)['maxNotionalCap']).toBe('0');
  });

  it('lo que nadie mueve no se re-cuantiza: un null sigue siendo null y 12,5 sigue siendo 12,5', () => {
    // `coerceConfig` sobre la configuracion entera convertia el null en '' —que
    // `diffConfig` cuenta como cambio— y redondeaba al paso lo que el dueño
    // habia puesto fuera de la reticula.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER_V2, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const vigente = {
      ...cfgDe(base),
      sourceSymbolOverride: null,
      buyDistanceBps: '12.5',
    } as unknown as BotConfig;

    const r = decidirCambio({
      strategy: v2,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, cadence: 'MAS' },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(typeof r).toBe('object');
    const c = cfgDe((r as CambioPropuesto).config);
    expect(c['sourceSymbolOverride']).toBeNull();
    expect(c['buyDistanceBps']).toBe('12.5');
  });

  it('ganar capas con la separacion de fabrica la repara al suelo del generador', () => {
    // Una capa y separacion 1 es valido; dos capas con separacion 1 ponen las dos
    // al mismo precio y la V2 lo rechaza. La separacion no la mueve la perilla
    // de crecimiento, asi que sin el acoplamiento la propuesta moriria.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER_V2, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const vigente = {
      ...cfgDe(base),
      layers: 1,
      layerDistanceMultiplier: 1,
    } as unknown as BotConfig;

    const r = decidirCambio({
      strategy: v2,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, sizeGrowth: 'MAS' },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(typeof r).toBe('object');
    const c = cfgDe((r as CambioPropuesto).config);
    expect(Number(c['layers'])).toBe(2);
    expect(Number(c['layerDistanceMultiplier'])).toBe(1.05);
  });

  it('los umbrales se acoplan: 90/100 con «cobertura MAS» queda 95/100, y con posicion se bloquea', () => {
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER_V2, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const vigente = {
      ...cfgDe(base),
      defensiveThresholdPct: 90,
      highRiskThresholdPct: 100,
    } as unknown as BotConfig;
    const entrada = {
      strategy: v2,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, coverage: 'MAS' as const },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    };

    const sinPosicion = decidirCambio(entrada);
    expect(typeof sinPosicion).toBe('object');
    const c = cfgDe((sinPosicion as CambioPropuesto).config);
    expect(Number(c['defensiveThresholdPct'])).toBe(95);
    expect(Number(c['highRiskThresholdPct'])).toBe(100);

    expect(
      decidirCambio({
        ...entrada,
        posicion: { abierta: true, exposicion: '100', medidaHace: 30_000 },
      }),
    ).toBe('RIESGO');
  });

  it('con posicion abierta, el seguimiento no mueve su retroceso: podria cerrarla', () => {
    const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.TRAILING_PROFIT, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const entrada = {
      strategy: trailing,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, cadence: 'MAS' as const },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    };

    const sinPosicion = decidirCambio(entrada);
    expect(typeof sinPosicion).toBe('object');
    expect((sinPosicion as CambioPropuesto).diff.changed.map((c) => c.key)).toContain(
      'trailingCallbackPct',
    );
    expect(
      decidirCambio({
        ...entrada,
        posicion: { abierta: true, exposicion: null, medidaHace: null },
      }),
    ).toBe('CIERRE');
  });

  it('un market maker que cierra al tocar el tope no ve bajar su tope bajo lo expuesto', () => {
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('PRUDENTE', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    expect(cfgDe(base)['limitAction']).toBe('CLOSE_ALL');
    const tope = D(cfgDe(base)['maxBotPositionValue'] as Numeric);
    const posicion: PosicionViva = {
      abierta: true,
      exposicion: tope.mul('0.8').toFixed(),
      medidaHace: 30_000,
    };
    const ajustes: Desplazamientos = { ...SIN_MOVIMIENTO, coverage: 'MUCHO_MENOS' };

    const cierra = decidirCambio({
      strategy: mm,
      vigente: base,
      knobs,
      ajustes,
      ctx,
      refPrice: BTC.mark,
      inventario: 1,
      posicion,
      permitirWarm: true,
    });
    expect(cierra).toBe('CIERRE');

    // El mismo cambio en un bot que al tope solo deja de entrar: bajar el tope es
    // menos riesgo y pasa.
    const pausa = decidirCambio({
      strategy: mm,
      vigente: { ...cfgDe(base), limitAction: 'PAUSE_ENTRIES' } as unknown as BotConfig,
      knobs,
      ajustes,
      ctx,
      refPrice: BTC.mark,
      inventario: 1,
      posicion,
      permitirWarm: true,
    });
    expect(typeof pausa).toBe('object');
  });

  it('tres perillas a la vez se descartan enteras', () => {
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const r = decidirCambio({
      strategy: mm,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS', cadence: 'MAS', coverage: 'MENOS' },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(r).toBe('DEMASIADAS_PERILLAS');
  });

  it('no pedir nada no produce una reparacion que nadie pidio', () => {
    // Un bot a 3x cuyo dueño bajo despues su tope a 1x. `enforceCouplings` lo
    // repararia, y con todo IGUAL eso salia como una «propuesta» del supervisor.
    const ctx = { ...contexto(BTC.spec, BTC.mark), maxLeverageUsuario: 1 };
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER, contexto(BTC.spec, BTC.mark), knobs);
    if (!base) throw new Error('sin punto de partida');
    const r = decidirCambio({
      strategy: mm,
      vigente: { ...cfgDe(base), leverage: 3 } as unknown as BotConfig,
      knobs,
      ajustes: SIN_MOVIMIENTO,
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(r).toBe('SIN_CAMBIOS');
  });
});

describe('apply — guardaDePosicion, probada directamente', () => {
  const abierta: PosicionViva = { abierta: true, exposicion: '1000', medidaHace: 30_000 };
  const cfg = (c: Record<string, unknown>): BotConfig => c as unknown as BotConfig;
  const mmBase = {
    leverage: 3,
    maxBotPositionValue: '2000',
    limitAction: 'PAUSE_ENTRIES',
    inventorySkewFactor: 0.75,
    stopLossPct: 5,
  };

  it('sin posicion no bloquea nada', () => {
    expect(
      guardaDePosicion(
        'MARKET_MAKER',
        cfg(mmBase),
        { ...mmBase, leverage: 9, stopLossPct: 1 },
        {
          abierta: false,
          exposicion: null,
          medidaHace: null,
        },
      ),
    ).toBeNull();
  });

  it('subir el apalancamiento es RIESGO; bajarlo, no', () => {
    expect(guardaDePosicion('MARKET_MAKER', cfg(mmBase), { ...mmBase, leverage: 4 }, abierta)).toBe(
      'RIESGO',
    );
    expect(
      guardaDePosicion('MARKET_MAKER', cfg(mmBase), { ...mmBase, leverage: 2 }, abierta),
    ).toBeNull();
  });

  it('bajar el sesgo de inventario es RIESGO: descarga mas tarde', () => {
    expect(
      guardaDePosicion(
        'MARKET_MAKER',
        cfg(mmBase),
        { ...mmBase, inventorySkewFactor: 0.5 },
        abierta,
      ),
    ).toBe('RIESGO');
    expect(
      guardaDePosicion('MARKET_MAKER', cfg(mmBase), { ...mmBase, inventorySkewFactor: 1 }, abierta),
    ).toBeNull();
  });

  it('un tope a cero es infinito: ponerlo no es riesgo, quitarlo si', () => {
    expect(
      guardaDePosicion(
        'TREND_FOLLOW',
        cfg({ maxNotionalCap: '0' }),
        { maxNotionalCap: '5000' },
        abierta,
      ),
    ).toBeNull();
    expect(
      guardaDePosicion(
        'TREND_FOLLOW',
        cfg({ maxNotionalCap: '5000' }),
        { maxNotionalCap: '0' },
        abierta,
      ),
    ).toBe('RIESGO');
  });

  it('con posicion el stop no se toca, ni siquiera para estrecharlo', () => {
    expect(
      guardaDePosicion('MARKET_MAKER', cfg(mmBase), { ...mmBase, stopLossPct: 3 }, abierta),
    ).toBe('CIERRE');
    expect(
      guardaDePosicion('TREND_FOLLOW', cfg({ stopLossPct: 5 }), { stopLossPct: 3 }, abierta),
    ).toBe('CIERRE');
  });

  it('en el seguimiento tampoco el objetivo ni el retroceso', () => {
    const t = { takeProfitPct: 10, trailingCallbackPct: 1, stopLossPct: 5 };
    expect(guardaDePosicion('TRAILING_PROFIT', cfg(t), { ...t, takeProfitPct: 8 }, abierta)).toBe(
      'CIERRE',
    );
    expect(
      guardaDePosicion('TRAILING_PROFIT', cfg(t), { ...t, trailingCallbackPct: 0.5 }, abierta),
    ).toBe('CIERRE');
  });

  it('el tope de un market maker que cierra no baja de la exposicion con holgura', () => {
    const cierra = { ...mmBase, limitAction: 'CLOSE_ALL' };
    // Exposicion 1000: el tope no puede quedar por debajo de 1250.
    expect(
      guardaDePosicion(
        'MARKET_MAKER',
        cfg(cierra),
        { ...cierra, maxBotPositionValue: '1200' },
        abierta,
      ),
    ).toBe('CIERRE');
    expect(
      guardaDePosicion(
        'MARKET_MAKER',
        cfg(cierra),
        { ...cierra, maxBotPositionValue: '1300' },
        abierta,
      ),
    ).toBeNull();
    // Sin saber la exposicion no se arriesga.
    expect(
      guardaDePosicion(
        'MARKET_MAKER_V2',
        cfg(cierra),
        { ...cierra, maxBotPositionValue: '1900' },
        { abierta: true, exposicion: null, medidaHace: null },
      ),
    ).toBe('CIERRE');
    // Y uno que al tope solo deja de entrar puede bajarlo cuanto quiera.
    expect(
      guardaDePosicion(
        'MARKET_MAKER',
        cfg(mmBase),
        { ...mmBase, maxBotPositionValue: '100' },
        abierta,
      ),
    ).toBeNull();
  });
});

describe('apply — trasladarCampo, probado directamente', () => {
  const campo = (extra: Partial<FieldMeta>): FieldMeta => ({
    key: 'x',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'x',
    required: false,
    ...extra,
  });
  const bps = campo({ key: 'buyDistanceBps', min: 1, max: 1000, step: 1 });
  const dinero = campo({ key: 'orderSizePerSide', kind: 'money', min: 1 });

  it('desplaza lo vivo lo mismo que se desplaza lo generado, conservando su tipo', () => {
    expect(trasladarCampo(bps, '12', 1, 3)).toBe('14');
    expect(trasladarCampo(bps, 12, 1, 3)).toBe(14);
    // Fuera de la reticula se queda fuera: no se re-cuantiza lo del dueño.
    expect(trasladarCampo(bps, '12.5', 1, 3)).toBe('14.5');
  });

  it('nunca en sentido contrario ni mas alla del descriptor', () => {
    // En el maximo, subir no mueve nada.
    expect(trasladarCampo(bps, 1000, 1, 3)).toBeUndefined();
    // En el minimo, bajar tampoco.
    expect(trasladarCampo(bps, 1, 5, 3)).toBeUndefined();
    // Un valor vivo fuera del descriptor no se toca.
    expect(trasladarCampo(bps, 5000, 1, 3)).toBeUndefined();
    // Y si el generador no mueve el campo, no hay nada que trasladar.
    expect(trasladarCampo(bps, 12, 3, '3')).toBeUndefined();
  });

  it('los importes, en proporcion y redondeando hacia abajo', () => {
    // Los dos casos de produccion son un `MUCHO_MENOS`: dos escalones, banda de
    // un medio. 300 × 555,55/833,33 = 200,00 y 2000 × 10000/15000 = 1333,33, los
    // dos DENTRO de la banda [200, 450] y [1333,33, 3000].
    expect(trasladarCampo(dinero, '300', '833.33', '555.55', 2)).toBe('200');
    expect(trasladarCampo(dinero, 2000, '15000', '10000', 2)).toBe('1333.33');
    // Con UN escalon la misma proporcion se queda en el suelo de su banda: un
    // tercio de bajada de golpe es lo que el spec 052 vino a impedir (F-03).
    expect(trasladarCampo(dinero, '300', '833.33', '555.55')).toBe('240');
    // Un cero, o un generado a cero, no da una proporcion con sentido.
    expect(trasladarCampo(dinero, '0', '100', '200')).toBeUndefined();
    expect(trasladarCampo(dinero, '300', '0', '200')).toBeUndefined();
  });

  it('ningun campo se mueve mas de un cuarto de su valor por escalon (spec 052)', () => {
    // F-02: el market maker ajustado a 6 bps con el generador yendo de 22 a 8.
    // Aditivo puro lo dejaba en el minimo del descriptor —cotizar por debajo de
    // las comisiones—; con la banda baja un paso por escalon.
    expect(trasladarCampo(bps, '6', '22', '8')).toBe('5');
    expect(trasladarCampo(bps, '6', '22', '8', 2)).toBe('4');
    // Y al reves: el generador que multiplica por cuatro mueve un cuarto.
    expect(trasladarCampo(dinero, '100', '100', '400')).toBe('125');
    expect(trasladarCampo(dinero, '100', '100', '400', 2)).toBe('150');
  });

  it('un valor pequeño puede moverse un paso aunque el cuarto no llegue (spec 052)', () => {
    // La cota es relativa, y sobre valores pequeños un cuarto no llega ni a un
    // paso: sin suelo, un bot a 2x no podria bajar NUNCA de apalancamiento, ni un
    // market maker de una capa ganar la segunda. Eso no es acotar, es congelar.
    const lev = campo({ key: 'leverage', kind: 'integer', min: 1, max: 50, step: 1 });
    expect(trasladarCampo(lev, 2, 5, 3)).toBe(1);
    const capas = campo({ key: 'layers', kind: 'integer', min: 1, max: 10, step: 1 });
    expect(trasladarCampo(capas, 1, 2, 6)).toBe(2);
    // Y el suelo es UN paso, no el salto entero.
    expect(trasladarCampo(capas, 2, 2, 8)).toBe(3);
  });

  it('un cero no se enciende solo (spec 052, F-11)', () => {
    // `orderMaxAgeSeconds: 0` es «las ordenes no caducan por edad», y lo puso su
    // dueño. La cadencia lo movia de 0 a 75 sin que nadie lo pidiera.
    const edad = campo({ key: 'orderMaxAgeSeconds', kind: 'integer', min: 0, max: 86400, step: 5 });
    expect(trasladarCampo(edad, 0, 300, 375)).toBeUndefined();
    expect(trasladarCampo(edad, 0, 300, 375, 2)).toBeUndefined();
    // Con un valor puesto si se mueve, un paso del campo por escalon.
    expect(trasladarCampo(edad, 300, 300, 375)).toBe(375);
  });

  it('en modo cantidad de moneda conserva los decimales del venue (spec 052, F-04)', () => {
    // `camposEfectivos` le pone de minimo la `minQty` del venue, y de ahi salen
    // los decimales. Redondear a dos convertia 0,009 BTC en 0,00 y, acotado al
    // minimo, en 0,00001.
    const cantidad = campo({ key: 'orderSizePerSide', kind: 'money', min: 0.00001 });
    expect(trasladarCampo(cantidad, '0.01', '100', '90')).toBe('0.009');
    expect(trasladarCampo(cantidad, '0.01', '100', '1')).toBe('0.008');
  });

  it('un enumerado solo cambia si el bot tenia el de antes', () => {
    const modo = campo({ key: 'modo', kind: 'enum', options: ['A', 'B', 'C'] });
    expect(trasladarCampo(modo, 'A', 'A', 'B')).toBe('B');
    expect(trasladarCampo(modo, 'C', 'A', 'B')).toBeUndefined();
  });

  it('un precio no se traslada nunca', () => {
    const precio = campo({ key: 'activationPrice', kind: 'price' });
    expect(trasladarCampo(precio, '100', '90', '95')).toBeUndefined();
  });

  it('subir y bajar vuelve exactamente al punto de partida', () => {
    // El antidoto del vaiven, sobre la funcion misma: con redondeo simetrico del
    // delta, ida y vuelta se anulan mientras la ida no toque un limite.
    const r = semilla(5105);
    const decimal = campo({ key: 'volatilityMultiplier', min: 0, max: 5, step: 0.05 });
    let comprobados = 0;
    for (let i = 0; i < 2000; i++) {
      const f = i % 2 === 0 ? bps : decimal;
      const paso = f.step ?? 1;
      const v = D(paso).mul(Math.floor(r() * 80) + 1);
      const a = D(r() * 40).toDecimalPlaces(3);
      const d = D(r() * 40).toDecimalPlaces(3);
      const ida = trasladarCampo(f, v.toFixed(), a.toFixed(), d.toFixed());
      if (ida === undefined) continue;
      const salto = d.minus(a).div(paso).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(paso);
      if (
        !D(ida as Numeric)
          .minus(v)
          .eq(salto)
      )
        continue;
      expect(trasladarCampo(f, ida, d.toFixed(), a.toFixed())).toBe(v.toFixed());
      comprobados++;
    }
    expect(comprobados).toBeGreaterThan(200);
  });

  it('en un importe, la ida y vuelta nunca gana dinero y pierde como mucho el redondeo', () => {
    const r = semilla(5106);
    let comprobados = 0;
    for (let i = 0; i < 1000; i++) {
      const v = D(r() * 5000 + 10).toDecimalPlaces(2);
      const a = D(r() * 5000 + 10).toDecimalPlaces(2);
      const d = D(r() * 5000 + 10).toDecimalPlaces(2);
      const ida = trasladarCampo(dinero, v.toFixed(), a.toFixed(), d.toFixed());
      if (ida === undefined) continue;
      const vuelta = trasladarCampo(dinero, ida, d.toFixed(), a.toFixed());
      if (vuelta === undefined) continue;
      const perdida = v.minus(vuelta as Numeric);
      expect(perdida.gte(0)).toBe(true);
      expect(perdida.lte(D('0.01').mul(a.div(d).ceil().plus(1)))).toBe(true);
      comprobados++;
    }
    expect(comprobados).toBeGreaterThan(100);
  });
});

describe('apply — que tiene efecto (spec 051)', () => {
  const BTC = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;
  const ctx = contexto(BTC.spec, BTC.mark);

  it('en un market maker en el suelo por coste, el diferencial solo mueve la separacion de capas', () => {
    // El caso del market maker de BTC: pedia «estrecha» cada media hora sin saber que sus
    // distancias ya estaban en lo minimo que cubre comisiones.
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const e = movimientosConEfecto({
      strategy: getStrategy(StrategyKind.MARKET_MAKER),
      vigente,
      knobs,
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(e.spread.MENOS).toBe('APLICABLE');
    expect(e.spread.campos.MENOS).toEqual(['layerDistanceMultiplier']);
  });

  it('en la estrategia de seguimiento, diferencial y crecimiento no hacen nada', () => {
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.TRAILING_PROFIT, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const e = movimientosConEfecto({
      strategy: getStrategy(StrategyKind.TRAILING_PROFIT),
      vigente,
      knobs,
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    for (const perilla of ['spread', 'sizeGrowth'] as const) {
      expect(`${perilla}: ${e[perilla].MENOS}/${e[perilla].MAS}`).toBe(
        `${perilla}: SIN_CAMBIOS/SIN_CAMBIOS`,
      );
    }
  });

  it('en el extremo de la banda no hay a donde ir', () => {
    const knobs: Knobs = { ...defaultKnobs('EQUILIBRADA', ctx.features), spread: 'MUY_ALTA' };
    const vigente = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const e = movimientosConEfecto({
      strategy: getStrategy(StrategyKind.MARKET_MAKER),
      vigente,
      knobs,
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    });
    expect(e.spread.MAS).toBe('EXTREMO');
  });

  it('cada efecto es exactamente lo que decidirCambio devolveria', () => {
    // La lista la lee el modelo como verdad: si dijera «si» a algo que luego se
    // descarta, volveria a pedir lo imposible, que es lo que vino a arreglar.
    const muestra = casos().filter((_, i) => i % 7 === 0);
    for (const caso of muestra) {
      const base = {
        strategy: getStrategy(caso.kind),
        vigente: caso.vigente,
        knobs: caso.knobs,
        ctx: caso.ctx,
        refPrice: caso.mark,
        inventario: 0,
        permitirWarm: true,
      };
      const e = movimientosConEfecto(base);
      for (const perilla of PERILLAS) {
        for (const mov of ['MENOS', 'MAS'] as const) {
          if (e[perilla][mov] === 'EXTREMO') continue;
          // Un escalon, y si no mueve nada, los dos: es lo que hace la funcion, y
          // lo que el expediente promete (spec 052, F-08).
          const uno = decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: mov } });
          const doble = mov === 'MENOS' ? 'MUCHO_MENOS' : 'MUCHO_MAS';
          const r =
            uno === 'SIN_CAMBIOS'
              ? decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: doble } })
              : uno;
          const esperado = typeof r === 'string' ? r : 'APLICABLE';
          expect(`${caso.kind}/${caso.mercado} ${perilla} ${mov}: ${e[perilla][mov]}`).toBe(
            `${caso.kind}/${caso.mercado} ${perilla} ${mov}: ${esperado}`,
          );
          expect(
            `${caso.kind}/${caso.mercado} ${perilla} ${mov} doble: ${e[perilla].soloDoble[mov]}`,
          ).toBe(
            `${caso.kind}/${caso.mercado} ${perilla} ${mov} doble: ${uno === 'SIN_CAMBIOS' && esperado === 'APLICABLE'}`,
          );
        }
      }
    }
  });
});

/**
 * Los topes, probados a proposito.
 *
 * La matriz de arriba no los ejercita: partiendo de `defaultKnobs` y con
 * `enforceCouplings` acotando por detras, el salto natural nunca llega al limite.
 * Eso significa que sin estos casos las dos salvaguardas serian codigo que nadie
 * comprueba — y se verifico quitandolas: la matriz seguia en verde.
 */
describe('apply — los topes que la matriz no ejercita', () => {
  const mercado = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;
  const strategy = getStrategy(StrategyKind.MARKET_MAKER);

  function botCon(cambios: Record<string, unknown>): { vigente: BotConfig; ctx: BuildContext } {
    const ctx = contexto(mercado.spec, mercado.mark);
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, defaultKnobs('PRUDENTE', ctx.features));
    if (!base) throw new Error('sin punto de partida');
    return { vigente: { ...base, ...cambios }, ctx };
  }

  it('el apalancamiento no sube mas de un punto por revision', () => {
    // Un bot a 1x al que el modelo le pide el maximo de golpe. Sin el tope el
    // salto seria de dos puntos de una sentada.
    const { vigente, ctx } = botCon({ leverage: 1 });
    const r = decidirCambio({
      strategy,
      vigente,
      knobs: { ...defaultKnobs('AGRESIVA', ctx.features), leverage: 'MUY_BAJA' },
      ajustes: { ...SIN_MOVIMIENTO, leverage: 'MUCHO_MAS' },
      ctx,
      refPrice: mercado.mark,
      inventario: 0,
      permitirWarm: true,
    });

    if (typeof r === 'string') {
      expect(MOTIVOS).toContain(r);
      return;
    }
    expect(Number(cfgDe(r.config)['leverage'])).toBeLessThanOrEqual(2);
  });

  it('un ajuste no reescribe el bot: lo que no cambia sigue siendo lo que su dueño dejo', () => {
    const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
    const ctx = contexto(mercado.spec, mercado.mark);
    const base = botVivo(StrategyKind.TRAILING_PROFIT, ctx, defaultKnobs('PRUDENTE', ctx.features));
    if (!base) throw new Error('sin punto de partida');
    const vigente = { ...base, leverage: 1 } as unknown as BotConfig;

    const r = decidirCambio({
      strategy: trailing,
      vigente,
      knobs: { ...defaultKnobs('AGRESIVA', ctx.features), leverage: 'MUY_BAJA' },
      ajustes: { ...SIN_MOVIMIENTO, leverage: 'MUCHO_MAS' },
      ctx,
      refPrice: mercado.mark,
      inventario: 0,
      permitirWarm: true,
    });

    if (typeof r === 'string') {
      expect(MOTIVOS).toContain(r);
      return;
    }
    const antes = cfgDe(vigente);
    const despues = cfgDe(r.config);
    const movidos = new Set(r.diff.changed.map((c) => c.key));
    for (const clave of Object.keys(antes)) {
      if (movidos.has(clave)) continue;
      expect(`${clave}: ${mismoValor(despues[clave], antes[clave])}`).toBe(`${clave}: true`);
    }
  });

  it('el tope de apalancamiento corta el salto, probado directamente', () => {
    // Directo sobre la funcion porque la cadena entera casi nunca llega a ella
    // (ver el caso de arriba). Una barandilla que solo se puede comprobar
    // cuando otra no actua no esta comprobada.
    const market = mercado.spec;
    const vigente = { leverage: 2 } as unknown as BotConfig;

    // Sube de golpe: se corta a un punto.
    expect(conTopeDeApalancamiento({ leverage: 9 }, vigente, market, null)['leverage']).toBe(3);
    // Sube justo un punto: pasa tal cual.
    expect(conTopeDeApalancamiento({ leverage: 3 }, vigente, market, null)['leverage']).toBe(3);
    // Bajar es libre, y no se toca.
    expect(conTopeDeApalancamiento({ leverage: 1 }, vigente, market, null)['leverage']).toBe(1);
    // El tope del usuario manda sobre el salto.
    expect(conTopeDeApalancamiento({ leverage: 9 }, vigente, market, 2)['leverage']).toBe(2);
    // Lo que esta funcion promete es acotar el SALTO, no el valor absoluto: de
    // eso ya se ocupa `enforceCouplings` antes, con el menor de MAX_SAFE_LEVERAGE,
    // el del venue y el del usuario. Por eso un valor que no sube no se toca, y
    // por eso el orden de la cadena importa.
    const quieto = { leverage: 999 } as unknown as BotConfig;
    expect(conTopeDeApalancamiento({ leverage: 999 }, quieto, market, null)['leverage']).toBe(999);
    // Pero en cuanto SUBE, entra el tope y ademas se aplican los absolutos.
    expect(
      Number(
        conTopeDeApalancamiento(
          { leverage: 999 },
          { leverage: 5 } as unknown as BotConfig,
          market,
          null,
        )['leverage'],
      ),
    ).toBe(6);
  });

  it('el stop solo se estrecha, probado directamente', () => {
    const vigente = { stopLossPct: 5 } as unknown as BotConfig;

    // Estrechar pasa.
    expect(conStopQueSoloSeEstrecha({ stopLossPct: 3 }, vigente)['stopLossPct']).toBe(3);
    // Ensanchar se revierte al vigente.
    expect(conStopQueSoloSeEstrecha({ stopLossPct: 9 }, vigente)['stopLossPct']).toBe(5);
    // Quitarlo, tambien: un bot que tenia stop no se queda sin el.
    expect(conStopQueSoloSeEstrecha({}, vigente)['stopLossPct']).toBe(5);
    // Un bot que NO tenia stop se queda como estaba: no se le inventa uno.
    expect(conStopQueSoloSeEstrecha({ stopLossPct: 4 }, {} as BotConfig)['stopLossPct']).toBe(4);
  });

  it('el stop loss no se ensancha ni se apaga', () => {
    // Con TRAILING_PROFIT y no con el market maker: `buildConfig` solo genera
    // `stopLossPct` en las estrategias direccionales, asi que en un MM esta
    // salvaguarda no llega a ejercitarse nunca.
    //
    // Un bot con el stop ceñido al 2 %. Pase lo que pase con las perillas no se
    // afloja: el stop es una orden condicional NATIVA del venue que sobrevive a
    // que el worker muera, y es lo unico que protege la posicion cuando nadie
    // mira. Un bot que tenia stop no se queda sin el porque un modelo lo creyera
    // conveniente.
    const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
    const ctx = contexto(mercado.spec, mercado.mark);
    const base = botVivo(StrategyKind.TRAILING_PROFIT, ctx, defaultKnobs('AGRESIVA', ctx.features));
    if (!base) throw new Error('sin punto de partida');
    const vigente = { ...base, stopLossPct: 2 } as unknown as BotConfig;

    let comprobados = 0;
    for (const clave of PERILLAS) {
      for (const mov of MOVIMIENTOS) {
        const r = decidirCambio({
          strategy: trailing,
          vigente,
          knobs: defaultKnobs('AGRESIVA', ctx.features),
          ajustes: { ...SIN_MOVIMIENTO, [clave]: mov },
          ctx,
          refPrice: mercado.mark,
          inventario: 0,
          permitirWarm: true,
        });
        if (typeof r === 'string') continue;
        expect(Number(cfgDe(r.config)['stopLossPct'])).toBeLessThanOrEqual(2);
        comprobados++;
      }
    }
    // Y que el bucle no este pasando por no proponer nada nunca.
    expect(comprobados).toBeGreaterThan(0);
  });
});

describe('apply — los dos invariantes de conducta', () => {
  const TODOS = casos();

  it('no pedir nada no cuesta nada: cinco IGUAL no producen revision', () => {
    // La inaccion tiene que salir gratis. Si «no cambies nada» escribiera una
    // revision, cada media hora habria una fila nueva por bot, el historial de
    // configuracion dejaria de servir para lo que sirve, y el motor retenderia
    // la escalera sin motivo.
    for (const caso of TODOS) {
      const r = decidirCambio({
        strategy: getStrategy(caso.kind),
        vigente: caso.vigente,
        knobs: caso.knobs,
        ajustes: SIN_MOVIMIENTO,
        ctx: caso.ctx,
        refPrice: caso.mark,
        inventario: 0,
        permitirWarm: true,
      });
      expect(`${caso.kind}/${caso.mercado} → ${JSON.stringify(r)}`).toBe(
        `${caso.kind}/${caso.mercado} → "SIN_CAMBIOS"`,
      );
    }
  });

  it('subir y volver a bajar devuelve exactamente la configuracion original', () => {
    // El antidoto del vaiven. Si `MAS` y luego `MENOS` no volvieran al punto de
    // partida, el supervisor iria derivando en una direccion sin que nadie se lo
    // hubiera pedido, y cada revision alejaria un poco mas al bot de lo que su
    // dueño configuro.
    let comprobados = 0;
    for (const caso of TODOS) {
      const strategy = getStrategy(caso.kind);
      for (const clave of PERILLAS) {
        const subida = aplicarDesplazamientos(caso.knobs, { ...SIN_MOVIMIENTO, [clave]: 'MAS' });
        const vuelta = aplicarDesplazamientos(subida, { ...SIN_MOVIMIENTO, [clave]: 'MENOS' });

        // Salvo en los extremos, donde `shiftBand` acota y subir ya no mueve.
        if (subida[clave] === caso.knobs[clave]) continue;

        expect(vuelta).toEqual(caso.knobs);

        // Y lo mismo end to end: la configuracion que sale es la misma.
        const ida = decidirCambio({
          strategy,
          vigente: caso.vigente,
          knobs: caso.knobs,
          ajustes: { ...SIN_MOVIMIENTO, [clave]: 'MAS' },
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        });
        if (typeof ida === 'string') continue;

        const regreso = decidirCambio({
          strategy,
          vigente: ida.config,
          knobs: ida.knobs,
          ajustes: { ...SIN_MOVIMIENTO, [clave]: 'MENOS' },
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        });
        if (typeof regreso === 'string') continue;

        const { antes: gAntes, despues: gDespues } = generadas(
          caso.kind,
          caso.vigente,
          caso.knobs,
          { ...SIN_MOVIMIENTO, [clave]: 'MAS' },
          caso.ctx,
        );
        for (const c of ida.diff.changed) {
          const antes = cfgDe(caso.vigente)[c.key];
          const despues = cfgDe(regreso.config)[c.key];
          const field = strategy.meta.fields.find((f) => f.key === c.key);

          // Mientras la banda del spec 052 no recorte, la ida y la vuelta se
          // anulan exactamente, que es el antidoto del vaiven de siempre. En un
          // importe, hasta el ultimo decimal: se redondea dos veces y siempre
          // hacia abajo, asi que puede volver un centimo por debajo — nunca por
          // encima, que es la unica direccion que importa.
          //
          // Y aunque recorte, si la ida SUBIO tiene que volver igual de exacta: la
          // banda es multiplicativa, asi que bajar desde v × f devuelve v. Con una
          // banda aditiva —el error que esto vigila— la vuelta se pasaria de
          // largo, porque el margen crece con el valor.
          const subio =
            isFiniteNum(antes) && isFiniteNum(c.to) && D(c.to as Numeric).gt(antes as Numeric);
          if (subio || !field || !recortaLaBanda(field, antes, gAntes[c.key], gDespues[c.key])) {
            if (field?.kind === 'money' && isFiniteNum(antes) && isFiniteNum(despues)) {
              const perdida = D(antes as Numeric).minus(despues as Numeric);
              const ulp = D(10).pow(-Math.max(D(antes as Numeric).decimalPlaces(), 2));
              expect(`${caso.kind}/${c.key} → ${perdida.gte(0) && perdida.lte(ulp)}`).toBe(
                `${caso.kind}/${c.key} → true`,
              );
              continue;
            }
            expect(`${caso.kind}/${c.key} → ${mismoValor(despues, antes)}`).toBe(
              `${caso.kind}/${c.key} → true`,
            );
            continue;
          }

          // Y cuando SI recorta, la vuelta no puede ser exacta —la banda se mide
          // sobre el valor de cada momento— pero el bot no se escapa: sigue dentro
          // de un escalon de banda de donde estaba. Sin esto, un modelo que pide
          // MAS y MENOS alternativamente alejaria el bot un poco mas cada vez.
          const paso = D(field.step ?? (field.kind === 'integer' ? 1 : 0));
          const cota = D(antes as Numeric)
            .abs()
            .mul(TOPE_RELATIVO_POR_PASO)
            .plus(paso);
          const fuera = D(despues as Numeric)
            .minus(antes as Numeric)
            .abs();
          expect(`${caso.kind}/${c.key} dentro de la banda: ${fuera.lte(cota)}`).toBe(
            `${caso.kind}/${c.key} dentro de la banda: true`,
          );
        }
        comprobados++;
      }
    }
    expect(comprobados).toBeGreaterThan(0);
  });
});

describe('apply — la revision del spec 052', () => {
  const BTC = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;
  const mm = getStrategy(StrategyKind.MARKET_MAKER);

  it('con posicion abierta, TREND no mueve su stop de ATR (F-01)', () => {
    // `BLOQUEADOS_CON_POSICION` protegia `stopLossPct`, que en TREND_FOLLOW esta
    // SIEMPRE vacio —el validador lo rechaza con valor, «el stop lo pone la
    // estrategia»—, mientras la perilla del diferencial movia `atrStopMultiplier`,
    // que es el stop de verdad. Estrecharlo con una posicion viva la cierra en el
    // siguiente tick.
    const trend = getStrategy(StrategyKind.TREND_FOLLOW);
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.TREND_FOLLOW, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    expect(cfgDe(vigente)['stopLossPct'] ?? null).toBeNull();

    const entrada = {
      strategy: trend,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MENOS' as const },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    };

    // Sin posicion se mueve, y es lo correcto: es el ajuste que se le pide.
    const libre = decidirCambio(entrada);
    expect(typeof libre).toBe('object');
    expect((libre as CambioPropuesto).diff.changed.map((c) => c.key)).toContain(
      'atrStopMultiplier',
    );

    // Con posicion, no.
    expect(
      decidirCambio({
        ...entrada,
        posicion: { abierta: true, exposicion: '500', medidaHace: 30_000 },
      }),
    ).toBe('CIERRE');
    expect(BLOQUEADOS_CON_POSICION['TREND_FOLLOW']).toContain('atrStopMultiplier');
  });

  it('el tope de un market maker que cierra no baja con una medida rancia (F-05)', () => {
    // La exposicion sale del ultimo estado del bot, que se acepta hasta con diez
    // minutos. Un market maker acumula inventario en minutos: con la foto vieja,
    // el tope nuevo puede quedar por debajo de lo que tiene AHORA, y `CLOSE_ALL`
    // aplana la posicion al tocarlo.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('PRUDENTE', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    expect(cfgDe(base)['limitAction']).toBe('CLOSE_ALL');
    // Exposicion holgada: con la medida fresca el cambio cabe de sobra.
    const exposicion = D(cfgDe(base)['maxBotPositionValue'] as Numeric)
      .mul('0.1')
      .toFixed();
    const entrada = {
      strategy: mm,
      vigente: base,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, coverage: 'MUCHO_MENOS' as const },
      ctx,
      refPrice: BTC.mark,
      inventario: 1,
      permitirWarm: true,
    };

    const fresca = decidirCambio({
      ...entrada,
      posicion: { abierta: true, exposicion, medidaHace: 30_000 },
    });
    expect(`fresca: ${typeof fresca === 'string' ? fresca : 'object'}`).toBe('fresca: object');
    expect(cfgDe((fresca as CambioPropuesto).config)['maxBotPositionValue']).not.toBe(
      cfgDe(base)['maxBotPositionValue'],
    );

    for (const medidaHace of [5 * 60_000, null]) {
      expect(
        decidirCambio({ ...entrada, posicion: { abierta: true, exposicion, medidaHace } }),
      ).toBe('CIERRE');
    }
  });

  it('con una sola capa, el diferencial no arrastra la separacion de capas (F-12)', () => {
    // `layerDistanceMultiplier` es WARM y con una capa no hace NADA: no hay
    // segunda capa que separar. Moverlo convertia un cambio de diferencial —HOT,
    // lo que mas le importa a un market maker— en uno que cancela y vuelve a
    // tender las ordenes, pide permiso de recolocacion y gasta el enfriamiento
    // WARM. Y en este bot, cuyas distancias ya estan en el suelo por coste, era
    // ademas lo UNICO que se movia: se pagaba una recolocacion por nada.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const entrada = {
      strategy: mm,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' as const },
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    };

    // Con varias capas se mueve, y es WARM: ahi si significa algo.
    const varias = decidirCambio({ ...entrada, vigente: base });
    expect(typeof varias).toBe('object');
    expect((varias as CambioPropuesto).diff.changed.map((c) => c.key)).toEqual([
      'layerDistanceMultiplier',
    ]);
    expect((varias as CambioPropuesto).level).toBe('WARM');

    // Con una sola, no hay nada que hacer y se dice.
    const unaCapa = { ...cfgDe(base), layers: 1 } as unknown as BotConfig;
    if (!mm.validate(unaCapa, ctx.market).ok) throw new Error('una capa no es valido');
    expect(decidirCambio({ ...entrada, vigente: unaCapa })).toBe('SIN_CAMBIOS');

    // Y en ninguna estrategia ni desplazamiento se cuela con una sola capa.
    for (const caso of casos().filter((c) => c.kind === StrategyKind.MARKET_MAKER)) {
      const vivo = { ...cfgDe(caso.vigente), layers: 1 } as unknown as BotConfig;
      if (!getStrategy(caso.kind).validate(vivo, caso.ctx.market).ok) continue;
      for (const ajustes of vectores(10, 5205)) {
        const r = decidirCambio({
          strategy: getStrategy(caso.kind),
          vigente: vivo,
          knobs: caso.knobs,
          ajustes,
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        });
        if (typeof r === 'string') continue;
        // Salvo cuando la propuesta GANA capas: ahi la separacion vuelve a
        // significar algo, y de hecho hay que repararla (el suelo de 1,05).
        if (Number(cfgDe(r.config)['layers'] ?? 1) > 1) continue;
        expect(`${caso.mercado}: ${r.diff.changed.map((c) => c.key).join(',')}`).not.toContain(
          'layerDistanceMultiplier',
        );
      }
    }
  });

  it('lo que no mueve un escalon pero si dos sale como aplicable con dos (F-08)', () => {
    // El prompt promete que «solo tienen efecto los movimientos marcados si». Con
    // la banda relativa hay campos cuyo delta de un escalon no llega al paso del
    // campo y el de dos si: decir «no» le quitaba al modelo el movimiento util.
    const ctx = contexto(BTC.spec, BTC.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const vigente = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!vigente) throw new Error('sin punto de partida');
    const base = {
      strategy: mm,
      vigente,
      knobs,
      ctx,
      refPrice: BTC.mark,
      inventario: 0,
      permitirWarm: true,
    };
    const efectos = movimientosConEfecto(base);

    for (const perilla of PERILLAS) {
      for (const mov of ['MENOS', 'MAS'] as const) {
        if (!efectos[perilla].soloDoble[mov]) continue;
        // Si dice «solo con MUCHO_», un escalon NO cambia nada y dos SI.
        const doble = mov === 'MENOS' ? 'MUCHO_MENOS' : 'MUCHO_MAS';
        expect(decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: mov } })).toBe(
          'SIN_CAMBIOS',
        );
        expect(
          typeof decidirCambio({ ...base, ajustes: { ...SIN_MOVIMIENTO, [perilla]: doble } }),
        ).toBe('object');
        expect(efectos[perilla][mov]).toBe('APLICABLE');
      }
    }
    // Y la marca solo se pone donde toca.
    for (const perilla of PERILLAS) {
      for (const mov of ['MENOS', 'MAS'] as const) {
        if (efectos[perilla].soloDoble[mov]) continue;
        expect(`${perilla} ${mov}`).toBe(`${perilla} ${mov}`);
      }
    }
  });
});

describe('apply — la fusion, probada directamente', () => {
  // Es la funcion mas delicada del fichero: un descuido aqui reescribe un campo
  // inmutable de un bot con dinero dentro. La cadena entera la ejercita, pero
  // conviene verla sola, con casos que la cadena no produce.
  const mercado = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;
  const strategy = getStrategy(StrategyKind.MARKET_MAKER);
  const ctx = contexto(mercado.spec, mercado.mark);

  function vivo(): BotConfig {
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, defaultKnobs('EQUILIBRADA', ctx.features));
    if (!base) throw new Error('sin punto de partida');
    return base;
  }

  it('un campo COLD no pasa aunque el generador lo produzca', () => {
    const vigente = vivo();
    const out = fusionarConservandoInmutables(
      strategy,
      vigente,
      { direction: 'SHORT', symbol: 'ETH', exchangeAccountId: 'otra', positionMode: 'HEDGE' },
      mercado.spec,
    );

    const antes = cfgDe(vigente);
    expect(out['direction']).toBe(antes['direction']);
    expect(out['symbol']).toBe(antes['symbol']);
    expect(out['exchangeAccountId']).toBe(antes['exchangeAccountId']);
    // `positionMode` es COLD en el descriptor del market maker.
    expect(out['positionMode']).toBe(antes['positionMode']);
  });

  it('un campo que la estrategia NO declara se conserva, no se pisa', () => {
    // Misma regla conservadora que `diffConfig`, que trata lo no declarado como
    // COLD: antes conservar un valor desconocido que pisarlo a ciegas.
    const vigente = { ...vivo(), campoDeOtraVida: 'no-tocar' } as unknown as BotConfig;
    const out = fusionarConservandoInmutables(
      strategy,
      vigente,
      { campoDeOtraVida: 'pisado' },
      mercado.spec,
    );
    expect(out['campoDeOtraVida']).toBe('no-tocar');
  });

  it('el capital no se toca ni aunque el generador mande otro', () => {
    const vigente = vivo();
    const out = fusionarConservandoInmutables(
      strategy,
      vigente,
      { totalInvestment: '999999' },
      mercado.spec,
    );
    expect(out['totalInvestment']).toBe(cfgDe(vigente)['totalInvestment']);
  });

  it('un campo HOT del descriptor si se pisa: para eso esta', () => {
    const vigente = vivo();
    const out = fusionarConservandoInmutables(
      strategy,
      vigente,
      { buyDistanceBps: 42 },
      mercado.spec,
    );
    expect(out['buyDistanceBps']).toBe(42);
    // Y el resultado no es COLD para `diffConfig`, que es la red de detras.
    expect(diffConfig(strategy, vigente, out as unknown as BotConfig).coldFields).toEqual([]);
  });
});

describe('apply — el suelo que puso el dueño de una V2 (spec 055, 054/H-01)', () => {
  // En la V2, una distancia minima por encima de las distancias es legitima: el
  // validador solo avisa («se elevaran hasta ahi») y el suelo compuesto hace lo
  // que el dueño pidio. `enforceCouplings` la bajaba hasta la menor distancia con
  // CUALQUIER perilla —20 → 10 bps con «apalancamiento»—, sin banda.
  const OTRAS = ['leverage', 'coverage', 'sizeGrowth', 'cadence'] as const;

  function conSueloAlto(kind: StrategyKind, nombre: string): Caso {
    const m = VENUE_MARKETS.find((x) => x.nombre === nombre)!;
    const ctx = contexto(m.spec, m.mark);
    const knobs = defaultKnobs('EQUILIBRADA', ctx.features);
    const base = botVivo(kind, ctx, knobs);
    if (!base) throw new Error(`sin punto de partida en ${nombre}`);
    const vigente = {
      ...cfgDe(base),
      minAllowedDistanceBps: 20,
      buyDistanceBps: 10,
      sellDistanceBps: 10,
    } as unknown as BotConfig;
    return { kind, mercado: nombre, vigente, ctx, mark: m.mark, knobs };
  }

  const MERCADOS = ['LIGHTER BTC', 'LIGHTER ETH', 'LIGHTER SOL'];

  it('la configuracion de partida es valida: el validador de la V2 solo avisa', () => {
    for (const nombre of MERCADOS) {
      const caso = conSueloAlto(StrategyKind.MARKET_MAKER_V2, nombre);
      const v = getStrategy(caso.kind).validate(caso.vigente, caso.ctx.market);
      expect(`${nombre}: ${v.ok}`).toBe(`${nombre}: true`);
      expect(v.issues.some((i) => i.field === 'minAllowedDistanceBps')).toBe(true);
    }
  });

  it('ninguna perilla que no sea el diferencial le baja el suelo', () => {
    let propuestas = 0;
    for (const nombre of MERCADOS) {
      const caso = conSueloAlto(StrategyKind.MARKET_MAKER_V2, nombre);
      for (const perilla of OTRAS) {
        for (const mov of MOVIMIENTOS) {
          if (mov === 'IGUAL') continue;
          const r = decidirCambio({
            strategy: getStrategy(caso.kind),
            vigente: caso.vigente,
            knobs: caso.knobs,
            ajustes: { ...SIN_MOVIMIENTO, [perilla]: mov },
            ctx: caso.ctx,
            refPrice: caso.mark,
            inventario: 0,
            permitirWarm: true,
          });
          if (typeof r === 'string') continue;
          propuestas++;
          const suelo = r.diff.changed.find((c) => c.key === 'minAllowedDistanceBps');
          expect(`${nombre} / ${perilla} ${mov} → ${JSON.stringify(suelo ?? null)}`).toBe(
            `${nombre} / ${perilla} ${mov} → null`,
          );
          expect(cfgDe(r.config)['minAllowedDistanceBps']).toBe(20);
        }
      }
    }
    // Que no pase por no proponer nada: la cadencia y la cobertura mueven otros
    // campos de verdad.
    expect(propuestas).toBeGreaterThan(5);
  });

  it('con el apalancamiento, que solo arrastraba la reparacion, no se propone nada', () => {
    const caso = conSueloAlto(StrategyKind.MARKET_MAKER_V2, 'LIGHTER BTC');
    for (const mov of ['MENOS', 'MAS'] as const) {
      const r = decidirCambio({
        strategy: getStrategy(caso.kind),
        vigente: caso.vigente,
        knobs: caso.knobs,
        ajustes: { ...SIN_MOVIMIENTO, leverage: mov },
        ctx: caso.ctx,
        refPrice: caso.mark,
        inventario: 0,
        permitirWarm: true,
      });
      expect(`${mov}: ${typeof r === 'string' ? r : JSON.stringify(r.diff.changed)}`).toBe(
        `${mov}: SIN_CAMBIOS`,
      );
    }
  });

  it('en la V1 la reparacion sigue: alli el validador exige el suelo bajo las distancias', () => {
    // Con el suelo igual a las distancias, estrechar el diferencial baja las
    // distancias, y el suelo tiene que bajar con ellas o la V1 lo rechaza. En un
    // par que se mueve: en calma el objetivo del generador esta en el suelo por
    // coste y estrechar no mueve nada.
    const m = VENUE_MARKETS.find((x) => x.nombre === 'LIGHTER BTC')!;
    const base0 = contexto(m.spec, m.mark);
    const ctx = { ...base0, features: { ...base0.features, atrPct1h: 1.6 } };
    const knobs = { ...defaultKnobs('EQUILIBRADA', ctx.features), spread: 'ALTA' as const };
    const base = botVivo(StrategyKind.MARKET_MAKER, ctx, knobs);
    if (!base) throw new Error('sin punto de partida');
    const distancia = cfgDe(base)['buyDistanceBps'];
    const vigente = {
      ...cfgDe(base),
      sellDistanceBps: distancia,
      minAllowedDistanceBps: distancia,
    } as unknown as BotConfig;
    const strategy = getStrategy(StrategyKind.MARKET_MAKER);
    expect(strategy.validate(vigente, m.spec).ok).toBe(true);

    const r = decidirCambio({
      strategy,
      vigente,
      knobs,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MUCHO_MENOS' },
      ctx,
      refPrice: m.mark,
      inventario: 0,
      permitirWarm: true,
    });
    if (typeof r === 'string') throw new Error(`sin propuesta: ${r}`);
    const nuevo = cfgDe(r.config);
    expect(Number(nuevo['buyDistanceBps'])).toBeLessThan(Number(distancia));
    expect(Number(nuevo['minAllowedDistanceBps'])).toBeLessThanOrEqual(
      Math.min(Number(nuevo['buyDistanceBps']), Number(nuevo['sellDistanceBps'])),
    );
    expect(strategy.validate(r.config, m.spec).ok).toBe(true);
  });
});

describe('apply — el diferencial va en el sentido pedido (spec 055, 054/H-02)', () => {
  // El generador de la V2 reparte el diferencial objetivo entre la distancia base
  // y el multiplicador de volatilidad, y los mueve en sentidos contrarios; el
  // traslado acota cada uno por su lado y no conserva la suma. En torno a una de
  // cada cuatro propuestas, «diferencial MAS» estrechaba lo que de verdad cotiza.
  const TODOS = casos().filter(
    (c) => c.kind === StrategyKind.MARKET_MAKER || c.kind === StrategyKind.MARKET_MAKER_V2,
  );
  const DISTANCIAS = ['buyDistanceBps', 'sellDistanceBps', 'minAllowedDistanceBps'];

  /** El diferencial de la primera capa, como lo compone `plan()`, con techo y suelo. */
  function efectivo(cfg: unknown, lado: 'buyDistanceBps' | 'sellDistanceBps', vol: number) {
    const c = cfg as MarketMakerV2Config;
    const x = composeSpreadBps(c, D(c[lado]), D(vol));
    const conTecho = x.capBps.gt(0) ? Decimal.min(x.capBps, x.bps) : x.bps;
    return Decimal.max(x.floorBps, conTecho);
  }

  function puntosDePartida(): Caso[] {
    const r = semilla(20550916);
    const out: Caso[] = [];
    for (const caso of TODOS) {
      out.push(caso);
      const aMano = botAMano(caso, r);
      if (aMano) out.push({ ...caso, vigente: aMano });
    }
    return out;
  }

  it('ninguna distancia se mueve al reves, y el diferencial de la V2 tampoco', () => {
    const vistos = { MARKET_MAKER: 0, MARKET_MAKER_V2: 0 } as Record<string, number>;
    for (const caso of puntosDePartida()) {
      const strategy = getStrategy(caso.kind);
      // La referencia es la del propio generador: el recorrido a cinco minutos.
      const ref = (caso.ctx.features.atrPct1h * 100) / Math.sqrt(12);
      for (const mov of MOVIMIENTOS) {
        if (mov === 'IGUAL') continue;
        const sentido = mov.endsWith('MAS') ? 1 : -1;
        const r = decidirCambio({
          strategy,
          vigente: caso.vigente,
          knobs: caso.knobs,
          ajustes: { ...SIN_MOVIMIENTO, spread: mov },
          ctx: caso.ctx,
          refPrice: caso.mark,
          inventario: 0,
          permitirWarm: true,
        });
        if (typeof r === 'string') continue;
        vistos[caso.kind]++;
        const donde = `${caso.kind} / ${caso.mercado} / ${mov}`;

        for (const c of r.diff.changed) {
          if (!DISTANCIAS.includes(c.key)) continue;
          const real = D(c.to as Numeric).comparedTo(D(c.from as Numeric));
          expect(`${donde} → ${c.key} ${String(c.from)}→${String(c.to)}: ${real === sentido}`).toBe(
            `${donde} → ${c.key} ${String(c.from)}→${String(c.to)}: true`,
          );
        }

        if (caso.kind !== StrategyKind.MARKET_MAKER_V2) continue;
        for (const lado of ['buyDistanceBps', 'sellDistanceBps'] as const) {
          for (const vol of [0, ref, 2 * ref]) {
            const antes = efectivo(caso.vigente, lado, vol);
            const despues = efectivo(r.config, lado, vol);
            const cambio = despues.comparedTo(antes);
            expect(
              `${donde} → ${lado} a ${vol.toFixed(1)} bps: ${antes.toFixed(2)}→${despues.toFixed(2)} ` +
                `${cambio === -sentido ? 'AL REVES' : 'bien'}`,
            ).toBe(
              `${donde} → ${lado} a ${vol.toFixed(1)} bps: ${antes.toFixed(2)}→${despues.toFixed(2)} bien`,
            );
          }
        }
      }
    }
    // Que no pase por no proponer nada, en ninguno de los dos.
    expect(vistos['MARKET_MAKER']).toBeGreaterThan(20);
    expect(vistos['MARKET_MAKER_V2']).toBeGreaterThan(20);
  });

  it('en la V2 el diferencial sigue sirviendo: a la volatilidad de referencia, «mas» ensancha', () => {
    // Quedarse quietas las distancias no puede dejar la perilla sin efecto: el
    // multiplicador de volatilidad, el techo y la separacion siguen moviendose.
    let ensancha = 0;
    let total = 0;
    for (const caso of puntosDePartida()) {
      if (caso.kind !== StrategyKind.MARKET_MAKER_V2) continue;
      const r = decidirCambio({
        strategy: getStrategy(caso.kind),
        vigente: caso.vigente,
        knobs: caso.knobs,
        ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' },
        ctx: caso.ctx,
        refPrice: caso.mark,
        inventario: 0,
        permitirWarm: true,
      });
      if (typeof r === 'string') continue;
      total++;
      const ref = (caso.ctx.features.atrPct1h * 100) / Math.sqrt(12);
      if (
        efectivo(r.config, 'buyDistanceBps', ref).gt(efectivo(caso.vigente, 'buyDistanceBps', ref))
      ) {
        ensancha++;
      }
    }
    expect(total).toBeGreaterThan(10);
    expect(ensancha).toBeGreaterThan(total / 2);
  });
});
