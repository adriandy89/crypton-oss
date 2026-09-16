import {
  D,
  Decimal,
  isFiniteNum,
  Mutability,
  StrategyKind,
  type BotConfig,
  type Numeric,
} from '@crypton/shared';
import { camposEfectivos, getStrategy, VENUE_MARKETS } from '@crypton/strategy-core';
import {
  BANDS,
  buildConfig,
  defaultKnobs,
  type BuildContext,
  type Knobs,
  type Profile,
} from '../advisor/build';
import { coerceConfig, enforceCouplings } from '../advisor/sanitize';
import {
  aplicarDesplazamientos,
  decidirCambio,
  MOVIMIENTOS,
  PERILLAS,
  SIN_MOVIMIENTO,
  type CambioPropuesto,
  type Desplazamientos,
} from './apply';
import { ETIQUETAS } from './mensajes';

/**
 * Lo que la IA puede modificar, medido sobre mercados reales (spec 054).
 *
 * `apply.spec.ts` prueba que lo que el supervisor aplica es APLICABLE y va en el
 * sentido pedido. Esto prueba otra cosa: QUE campos puede tocar. La pregunta la
 * hizo el usuario —«revisa lo que puede modificar la IA»— y la respuesta tiene
 * que ser una tabla que no envejezca: si un dia el generador empieza a mover un
 * campo nuevo, este test cae y obliga a decidirlo y a escribirlo en la guia.
 *
 * La tabla esta escrita A MANO, y es a proposito: derivarla del codigo le daria
 * la razon al codigo por construccion. Es la misma que `docs/administracion.md`.
 * Se sacó de una exploracion de 374 640 decisiones (spec 054), y aqui se repite
 * reducida para que la suite no tarde.
 */

type Perilla = keyof Desplazamientos;

const KINDS = [
  StrategyKind.MARKET_MAKER,
  StrategyKind.MARKET_MAKER_V2,
  StrategyKind.TREND_FOLLOW,
  StrategyKind.TRAILING_PROFIT,
] as const;

/** Que campos puede mover cada perilla, por estrategia. */
const ALCANCE: Readonly<Record<string, Readonly<Record<Perilla, readonly string[]>>>> = {
  MARKET_MAKER: {
    // Con poco capital las capas que caben dependen del apalancamiento, y con
    // ellas la separacion minima entre capas (1 con una, 1,05 con varias).
    leverage: [
      'leverage',
      'orderSizePerSide',
      'maxBotPositionValue',
      'layers',
      'layerDistanceMultiplier',
    ],
    coverage: ['defensiveThresholdPct', 'highRiskThresholdPct', 'maxBotPositionValue'],
    spread: [
      'buyDistanceBps',
      'sellDistanceBps',
      'minAllowedDistanceBps',
      'layerDistanceMultiplier',
    ],
    sizeGrowth: [
      'layers',
      'orderSizePerSide',
      'layerSizeMultiplier',
      'inventorySkewFactor',
      'layerDistanceMultiplier',
    ],
    cadence: ['refreshSeconds'],
  },
  MARKET_MAKER_V2: {
    leverage: [
      'leverage',
      'orderSizePerSide',
      'maxBotPositionValue',
      'layers',
      'layerDistanceMultiplier',
    ],
    coverage: ['defensiveThresholdPct', 'highRiskThresholdPct', 'maxBotPositionValue'],
    spread: [
      'buyDistanceBps',
      'sellDistanceBps',
      'minAllowedDistanceBps',
      'volatilityMultiplier',
      'layerDistanceMultiplier',
      'repriceThresholdBps',
      'maxDynamicSpreadBps',
    ],
    sizeGrowth: ['layers', 'orderSizePerSide', 'layerSizeMultiplier', 'layerDistanceMultiplier'],
    cadence: ['refreshSeconds', 'orderMaxAgeSeconds', 'fillCooldownSeconds'],
  },
  TREND_FOLLOW: {
    leverage: ['leverage', 'maxNotionalCap'],
    coverage: ['breakoutPeriod', 'entryEfficiency'],
    spread: ['atrStopMultiplier'],
    sizeGrowth: ['riskPerTradePct'],
    // Las velas mas cortas tambien son de la cadencia, pero `candleInterval` es
    // COLD: un cambio que lo tocara se descartaria entero.
    cadence: ['stopRepriceBps'],
  },
  TRAILING_PROFIT: {
    leverage: ['leverage', 'maxNotionalCap'],
    coverage: ['takeProfitPct'],
    // Dos perillas muertas: el generador de esta estrategia no las lee.
    spread: [],
    sizeGrowth: [],
    cadence: ['trailingCallbackPct', 'trailingRepriceBps'],
  },
};

/**
 * Lo que puede cambiar con CUALQUIER perilla: las reparaciones que el supervisor
 * aplica despues del traslado (`enforceCouplings` y sus acoplamientos propios).
 *
 *   - `leverage` baja al menor de los topes (el del usuario, el del venue, 18x).
 *   - `minAllowedDistanceBps` baja hasta la menor de las distancias. En la V2 eso
 *     pisa una distancia minima que su dueño puso a proposito por encima: es el
 *     hallazgo H-01 del spec 054, reportado y sin corregir.
 *   - `layerDistanceMultiplier` sube a 1,05 cuando hay varias capas.
 */
const ACOPLAMIENTOS: Readonly<Record<string, readonly string[]>> = {
  MARKET_MAKER: ['leverage', 'minAllowedDistanceBps', 'layerDistanceMultiplier'],
  MARKET_MAKER_V2: ['leverage', 'minAllowedDistanceBps', 'layerDistanceMultiplier'],
  TREND_FOLLOW: ['leverage'],
  TRAILING_PROFIT: ['leverage'],
};

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

/** Un mercado que va en linea recta y se mueve mucho: el generador ensancha. */
const RASGOS_VIOLENTOS = {
  ...RASGOS,
  volAnnualPct: 140,
  atrPct1h: 1.6,
  atrPct1d: 7.5,
  trendPct: 12,
  trend: 'ALCISTA' as const,
  efficiency: 0.65,
  worstDayPct: -18,
};

interface Escenario {
  capital: number;
  /** El tope de apalancamiento del usuario HOY. El bot nacio sin el. */
  tope: number | null;
  rasgos: typeof RASGOS;
  perfiles: readonly Profile[];
  /** Perillas de partida distintas de las del perfil. */
  perillas?: Partial<Knobs>;
}

const TODOS_LOS_PERFILES: readonly Profile[] = ['PRUDENTE', 'EQUILIBRADA', 'AGRESIVA'];

const ESCENARIOS: readonly Escenario[] = [
  { capital: 5000, tope: null, rasgos: RASGOS, perfiles: TODOS_LOS_PERFILES },
  // Un tope puesto DESPUES de crear el bot, por debajo de su apalancamiento: toda
  // decision llega con la reparacion.
  { capital: 300, tope: 2, rasgos: RASGOS, perfiles: TODOS_LOS_PERFILES },
  // Tan poco capital que las capas que caben dependen del apalancamiento. Con el
  // diferencial en su banda mas baja, ademas, la separacion entre capas depende
  // de si hay una o varias.
  { capital: 60, tope: null, rasgos: RASGOS, perfiles: ['EQUILIBRADA'] },
  {
    capital: 60,
    tope: null,
    rasgos: RASGOS,
    perfiles: ['EQUILIBRADA'],
    perillas: { spread: 'MUY_BAJA' },
  },
  // Otro regimen: en un mercado que va recto el generador ensancha.
  { capital: 5000, tope: null, rasgos: RASGOS_VIOLENTOS, perfiles: ['EQUILIBRADA'] },
];

/** Generador con semilla fija: el mismo fallo se reproduce siempre. */
function semilla(n: number): () => number {
  let s = n >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function botNacido(kind: StrategyKind, ctx: BuildContext, knobs: Knobs): BotConfig | null {
  const strategy = getStrategy(kind);
  let cfg = coerceConfig(strategy.meta.fields, strategy.defaults(), buildConfig(kind, knobs, ctx));
  cfg = enforceCouplings(kind, cfg, ctx.market, ctx.maxLeverageUsuario);
  const vivo = {
    ...cfg,
    symbol: ctx.market.symbol,
    exchangeAccountId: 'cuenta-1',
    // Con el formato con el que sale de la base (`Decimal(38,18)`).
    totalInvestment: Number(cfg['totalInvestment'] ?? ctx.totalInvestment).toFixed(18),
  } as unknown as BotConfig;
  return strategy.validate(vivo, ctx.market).ok ? vivo : null;
}

/** El mismo bot con parte de sus campos movidos a mano, dentro del descriptor. */
function botAMano(
  kind: StrategyKind,
  base: BotConfig,
  ctx: BuildContext,
  mark: string,
  r: () => number,
): BotConfig | null {
  const strategy = getStrategy(kind);
  const cfg: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const f of camposEfectivos(strategy.meta.fields, cfg, ctx.market)) {
    if (f.mutability === Mutability.COLD || f.key === 'totalInvestment') continue;
    const v = cfg[f.key];
    if (!isFiniteNum(v) || r() < 0.5) continue;
    if (f.kind === 'money') {
      if (D(v as Numeric).lte(0)) continue;
      cfg[f.key] = D(v as Numeric)
        .mul(0.4 + r() * 2)
        .toDecimalPlaces(2, Decimal.ROUND_DOWN)
        .toFixed();
    } else if (f.kind === 'number' || f.kind === 'percent' || f.kind === 'integer') {
      const paso = f.step ?? (f.kind === 'integer' ? 1 : undefined);
      if (paso === undefined) continue;
      let n = D(v as Numeric).plus(D(paso).mul(Math.floor(r() * 11) - 5));
      if (f.min !== undefined) n = Decimal.max(n, f.min);
      if (f.max !== undefined) n = Decimal.min(n, f.max);
      cfg[f.key] = typeof v === 'string' ? n.toFixed() : n.toNumber();
    }
  }
  const vivo = cfg as unknown as BotConfig;
  if (!strategy.validate(vivo, ctx.market).ok) return null;
  try {
    const p = strategy.preview(vivo, ctx.market, mark);
    if (!p.valid || p.levels.some((l) => l.violations.length > 0)) return null;
  } catch {
    return null;
  }
  return vivo;
}

interface Caso {
  kind: StrategyKind;
  donde: string;
  vigente: BotConfig;
  knobs: Knobs;
  ctx: BuildContext;
  mark: string;
}

/** Todos los puntos de partida: estrategias x mercados x escenarios x perfiles. */
function casos(): Caso[] {
  const r = semilla(20540916);
  const out: Caso[] = [];
  for (const kind of KINDS) {
    for (const m of VENUE_MARKETS) {
      for (const e of ESCENARIOS) {
        for (const perfil of e.perfiles) {
          const ctx: BuildContext = {
            market: m.spec,
            features: { ...e.rasgos, mark: Number(m.mark) },
            totalInvestment: e.capital,
            maxLeverageUsuario: e.tope,
            direction: 'LONG',
          };
          // Las perillas del perfil y otras al azar: tras unas cuantas revisiones,
          // las guardadas pueden estar en cualquier banda.
          const deFabrica = { ...defaultKnobs(perfil, ctx.features), ...e.perillas };
          const alAzar = { ...deFabrica };
          for (const p of PERILLAS) alAzar[p] = BANDS[Math.floor(r() * BANDS.length)];
          for (const knobs of [deFabrica, alAzar]) {
            const nacido = botNacido(kind, { ...ctx, maxLeverageUsuario: null }, knobs);
            if (!nacido) continue;
            const donde = `${kind} / ${m.nombre} / ${e.capital} / ${perfil}`;
            out.push({ kind, donde, vigente: nacido, knobs, ctx, mark: m.mark });
            const aMano = botAMano(kind, nacido, ctx, m.mark, r);
            if (aMano)
              out.push({
                kind,
                donde: `${donde} / a mano`,
                vigente: aMano,
                knobs,
                ctx,
                mark: m.mark,
              });
          }
        }
      }
    }
  }
  return out;
}

/** Igualdad laxa, la de `diffConfig`: '20' y 20 son el mismo valor. */
function mismo(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Los campos que el GENERADOR mueve con estos desplazamientos, con el capital del
 * bot, como hace `decidirCambio`. Lo que cambia sin estar aqui es una reparacion.
 */
function movidosPorElGenerador(caso: Caso, ajustes: Desplazamientos): Set<string> {
  const ctx = {
    ...caso.ctx,
    totalInvestment: Number(
      (caso.vigente as unknown as Record<string, unknown>)['totalInvestment'],
    ),
  };
  const antes = buildConfig(caso.kind, caso.knobs, ctx);
  const despues = buildConfig(caso.kind, aplicarDesplazamientos(caso.knobs, ajustes), ctx);
  return new Set(Object.keys(despues).filter((k) => !mismo(antes[k], despues[k])));
}

function decidir(caso: Caso, ajustes: Desplazamientos): CambioPropuesto | string {
  return decidirCambio({
    strategy: getStrategy(caso.kind),
    vigente: caso.vigente,
    knobs: caso.knobs,
    ajustes,
    ctx: caso.ctx,
    refPrice: caso.mark,
    inventario: 0,
    permitirWarm: true,
  });
}

describe('alcance — lo que puede modificar la IA (spec 054)', () => {
  const TODOS = casos();
  /** Lo que se ha visto mover a cada perilla, fuera de los acoplamientos. */
  const vistos = new Map<string, Set<string>>();
  const propuestas = new Map<string, number>();

  it('hay puntos de partida de las cuatro estrategias, con y sin ajustes a mano', () => {
    for (const kind of KINDS) {
      const suyos = TODOS.filter((c) => c.kind === kind);
      expect(`${kind}: ${suyos.length > 10}`).toBe(`${kind}: true`);
      expect(`${kind}: ${suyos.some((c) => c.donde.endsWith('a mano'))}`).toBe(`${kind}: true`);
    }
  });

  it('una perilla solo mueve los campos de su fila, mas los acoplamientos', () => {
    for (const caso of TODOS) {
      const tabla = ALCANCE[caso.kind];
      const acoplados = new Set(ACOPLAMIENTOS[caso.kind]);
      for (const perilla of PERILLAS) {
        for (const mov of MOVIMIENTOS) {
          if (mov === 'IGUAL') continue;
          const r = decidir(caso, { ...SIN_MOVIMIENTO, [perilla]: mov });
          if (typeof r === 'string') continue;
          propuestas.set(caso.kind, (propuestas.get(caso.kind) ?? 0) + 1);
          const suya = new Set(tabla[perilla]);
          const clave = `${caso.kind}.${perilla}`;
          const ajustes = { ...SIN_MOVIMIENTO, [perilla]: mov };
          const generados = movidosPorElGenerador(caso, ajustes);
          for (const c of r.diff.changed) {
            if (suya.has(c.key)) {
              if (!vistos.has(clave)) vistos.set(clave, new Set());
              vistos.get(clave)!.add(c.key);
              continue;
            }
            // Fuera de su fila solo cabe una REPARACION: un acoplamiento que la
            // perilla no pidio. Si el generador lo movio, es de la perilla, y la
            // tabla tiene que decirlo aunque el campo tambien se repare.
            const reparacion = acoplados.has(c.key) && !generados.has(c.key);
            expect(`${caso.donde} / ${perilla} ${mov} → ${c.key}: ${reparacion}`).toBe(
              `${caso.donde} / ${perilla} ${mov} → ${c.key}: true`,
            );
          }
        }
      }
    }
    // Que no pase por no proponer nada.
    for (const kind of KINDS) {
      expect(`${kind}: ${(propuestas.get(kind) ?? 0) > 100}`).toBe(`${kind}: true`);
    }
  });

  it('cada campo de la tabla se alcanza de verdad: la tabla no promete de mas', () => {
    // Depende del recorrido anterior, que es el que llena `vistos`. Si un campo
    // deja de moverse, la guia estaria describiendo algo que ya no pasa.
    for (const kind of KINDS) {
      for (const perilla of PERILLAS) {
        const esperados = [...ALCANCE[kind][perilla]].sort();
        const alcanzados = [...(vistos.get(`${kind}.${perilla}`) ?? [])].sort();
        expect(`${kind}.${perilla}: ${alcanzados.join(', ')}`).toBe(
          `${kind}.${perilla}: ${esperados.join(', ')}`,
        );
      }
    }
  });

  it('dos perillas a la vez no mueven nada que no moveria cada una', () => {
    const r = semilla(20540917);
    const conMovimiento = MOVIMIENTOS.filter((m) => m !== 'IGUAL');
    let vistas = 0;
    for (const caso of TODOS) {
      const tabla = ALCANCE[caso.kind];
      const acoplados = new Set(ACOPLAMIENTOS[caso.kind]);
      for (let i = 0; i < 3; i++) {
        const a = PERILLAS[Math.floor(r() * PERILLAS.length)];
        const b = PERILLAS[Math.floor(r() * PERILLAS.length)];
        if (a === b) continue;
        const ajustes = {
          ...SIN_MOVIMIENTO,
          [a]: conMovimiento[Math.floor(r() * conMovimiento.length)],
          [b]: conMovimiento[Math.floor(r() * conMovimiento.length)],
        };
        const res = decidir(caso, ajustes);
        if (typeof res === 'string') continue;
        vistas++;
        const permitidos = new Set([...tabla[a], ...tabla[b], ...acoplados]);
        for (const c of res.diff.changed) {
          expect(`${caso.donde} / ${a}+${b} → ${c.key}: ${permitidos.has(c.key)}`).toBe(
            `${caso.donde} / ${a}+${b} → ${c.key}: true`,
          );
        }
      }
    }
    expect(vistas).toBeGreaterThan(100);
  });

  it('cada campo que la IA puede mover tiene nombre en los avisos', () => {
    // Un campo sin nombre saldria en Telegram con su clave interna.
    for (const kind of KINDS) {
      const porClave = new Map(getStrategy(kind).meta.fields.map((f) => [f.key, f]));
      const todos = new Set([...Object.values(ALCANCE[kind]).flat(), ...ACOPLAMIENTOS[kind]]);
      for (const clave of todos) {
        const campo = porClave.get(clave);
        expect(`${kind}.${clave}: ${campo ? 'declarado' : 'no declarado'}`).toBe(
          `${kind}.${clave}: declarado`,
        );
        expect(`${kind}.${clave}: ${ETIQUETAS[campo!.labelKey] ?? 'sin nombre'}`).not.toBe(
          `${kind}.${clave}: sin nombre`,
        );
      }
    }
  });

  it('nada de la tabla es COLD: un cambio COLD se descartaria entero', () => {
    for (const kind of KINDS) {
      const porClave = new Map(getStrategy(kind).meta.fields.map((f) => [f.key, f]));
      for (const clave of Object.values(ALCANCE[kind]).flat()) {
        expect(`${kind}.${clave}: ${porClave.get(clave)?.mutability}`).not.toBe(
          `${kind}.${clave}: ${Mutability.COLD}`,
        );
      }
    }
  });
});
