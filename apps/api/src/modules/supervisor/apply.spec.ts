import { StrategyKind, type BotConfig, type MarketSpec } from '@crypton/shared';
import { getStrategy, VENUE_MARKETS, diffConfig } from '@crypton/strategy-core';
import { buildConfig, defaultKnobs, type BuildContext, type Knobs } from '../advisor/build';
import { coerceConfig, enforceCouplings } from '../advisor/sanitize';
import {
  aplicarDesplazamientos,
  decidirCambio,
  fusionarConservandoInmutables,
  MAX_CAMPOS_POR_CAMBIO,
  MOVIMIENTOS,
  recortarConInventario,
  SIN_MOVIMIENTO,
  conStopQueSoloSeEstrecha,
  conTopeDeApalancamiento,
  type Desplazamientos,
  type MotivoDescarte,
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

const CLAVES: (keyof Desplazamientos)[] = [
  'leverage',
  'coverage',
  'spread',
  'sizeGrowth',
  'cadence',
];

function vectores(cuantos: number, seed = 20460912): Desplazamientos[] {
  const r = semilla(seed);
  const out: Desplazamientos[] = [];
  // Los cinco extremos de cada perilla por separado, que son los que rompen.
  for (const clave of CLAVES) {
    for (const mov of MOVIMIENTOS) {
      out.push({ ...SIN_MOVIMIENTO, [clave]: mov });
    }
  }
  // Y combinaciones al azar, con semilla fija.
  for (let i = 0; i < cuantos; i++) {
    const v = { ...SIN_MOVIMIENTO };
    for (const clave of CLAVES) {
      v[clave] = MOVIMIENTOS[Math.floor(r() * MOVIMIENTOS.length)];
    }
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
  'DEMASIADOS_CAMPOS',
];

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
      const vigenteBruto = caso.vigente as unknown as Record<string, unknown>;

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

        const nuevo = r.config as unknown as Record<string, unknown>;

        // 1. Nada COLD, y el nivel jamas es COLD. Si esto falla, la fusion
        //    goteo: es un fallo NUESTRO, no del modelo.
        expect(r.diff.coldFields).toEqual([]);
        expect(r.level === 'HOT' || r.level === 'WARM').toBe(true);

        // 2. Los cuatro intocables, identicos.
        for (const clave of ['exchangeAccountId', 'symbol', 'direction', 'totalInvestment']) {
          expect(`${donde} → ${clave}=${String(nuevo[clave])}`).toBe(
            `${donde} → ${clave}=${String(vigenteBruto[clave])}`,
          );
        }

        // 3. Ningun campo de caracter cambia. Es la garantia que da congelar el
        //    perfil: `limitAction` pasaria de «deja de entrar» a «cierra la
        //    posicion» solo con que el perfil se moviera, y es HOT.
        for (const clave of CAMPOS_DE_CARACTER) {
          if (!(clave in vigenteBruto)) continue;
          expect(`${donde} → ${clave}=${String(nuevo[clave])}`).toBe(
            `${donde} → ${clave}=${String(vigenteBruto[clave])}`,
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

        // 6. Como mucho cuatro campos.
        expect(r.diff.changed.length).toBeLessThanOrEqual(MAX_CAMPOS_POR_CAMBIO);

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
    // Un bot a 1x al que el modelo le pide el maximo de golpe. El generador
    // produce 3x con la banda al tope para este par y estos rasgos, asi que sin
    // el tope el salto seria de dos puntos de una sentada.
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

    // Al aplicar solo el DELTA del desplazamiento —y no la configuracion
    // regenerada— el cambio cabe de sobra en el tope de campos, y el tope de
    // salto es el que decide: de 1x no se pasa de 2x aunque el generador pida 3x.
    if (typeof r === 'string') {
      expect(MOTIVOS).toContain(r);
      return;
    }
    expect(
      Number((r.config as unknown as Record<string, unknown>)['leverage']),
    ).toBeLessThanOrEqual(2);
  });

  it('un ajuste toca pocos campos, no reescribe el bot', () => {
    // La propiedad que hace util todo esto. Antes se regeneraba la configuracion
    // entera desde las perillas, asi que un bot que su dueño habia ajustado a
    // mano —lo normal en uno que lleva semanas— producia un diff de veinte
    // campos y MORIA siempre en `DEMASIADOS_CAMPOS`. Ahora se aplica el delta:
    // lo que el desplazamiento significa, y nada mas.
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
    expect(r.diff.changed.length).toBeLessThanOrEqual(MAX_CAMPOS_POR_CAMBIO);
    // Y lo que NO cambia sigue siendo lo que su dueño dejo.
    const antes = vigente as unknown as Record<string, unknown>;
    const despues = r.config as unknown as Record<string, unknown>;
    const movidos = new Set(r.diff.changed.map((c) => c.key));
    for (const clave of Object.keys(antes)) {
      if (movidos.has(clave)) continue;
      expect(`${clave}=${String(despues[clave])}`).toBe(`${clave}=${String(antes[clave])}`);
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
    for (const clave of CLAVES) {
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
        const stop = (r.config as unknown as Record<string, unknown>)['stopLossPct'];
        expect(Number(stop)).toBeLessThanOrEqual(2);
        comprobados++;
      }
    }
    // Y que el bucle no este pasando por no proponer nada nunca.
    expect(comprobados).toBeGreaterThan(0);
  });

  it('con inventario abierto no se sube el riesgo', () => {
    const { vigente, ctx } = botCon({});
    const subirTodo: Desplazamientos = {
      leverage: 'MUCHO_MAS',
      coverage: 'MUCHO_MENOS',
      spread: 'MAS',
      sizeGrowth: 'MUCHO_MAS',
      cadence: 'MAS',
    };

    const recortado = recortarConInventario(subirTodo);

    expect(recortado.leverage).toBe('IGUAL');
    expect(recortado.sizeGrowth).toBe('IGUAL');
    // Bajar la cobertura ES subir el riesgo: se queda igual.
    expect(recortado.coverage).toBe('IGUAL');
    // El diferencial y la cadencia no tocan riesgo de ruina.
    expect(recortado.spread).toBe('MAS');
    expect(recortado.cadence).toBe('MAS');

    // Y al reves: bajar el apalancamiento con inventario SI se honra.
    expect(recortarConInventario({ ...SIN_MOVIMIENTO, leverage: 'MENOS' }).leverage).toBe('MENOS');
    // Y cubrir mas recorrido tambien, porque es bajar el riesgo.
    expect(recortarConInventario({ ...SIN_MOVIMIENTO, coverage: 'MAS' }).coverage).toBe('MAS');

    const r = decidirCambio({
      strategy,
      vigente,
      knobs: defaultKnobs('EQUILIBRADA', ctx.features),
      ajustes: subirTodo,
      ctx,
      refPrice: mercado.mark,
      inventario: 3,
      permitirWarm: true,
    });
    if (typeof r !== 'string') {
      const lev = Number((r.config as unknown as Record<string, unknown>)['leverage']);
      expect(lev).toBeLessThanOrEqual(
        Number((vigente as unknown as Record<string, unknown>)['leverage']),
      );
    }
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
      expect(`${caso.kind}/${caso.mercado} → ${String(r)}`).toBe(
        `${caso.kind}/${caso.mercado} → SIN_CAMBIOS`,
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
      for (const clave of CLAVES) {
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

        for (const c of ida.diff.changed) {
          const antes = (caso.vigente as unknown as Record<string, unknown>)[c.key];
          const despues = (regreso.config as unknown as Record<string, unknown>)[c.key];
          expect(`${caso.kind}/${c.key} → ${String(despues)}`).toBe(
            `${caso.kind}/${c.key} → ${String(antes)}`,
          );
        }
        comprobados++;
      }
    }
    expect(comprobados).toBeGreaterThan(0);
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

    const antes = vigente as unknown as Record<string, unknown>;
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
    expect(out['totalInvestment']).toBe(
      (vigente as unknown as Record<string, unknown>)['totalInvestment'],
    );
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
