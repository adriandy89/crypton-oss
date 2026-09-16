import { resumenDeCiclos, type MarketFeatures } from '@crypton/shared';
import { defaultKnobs } from '../advisor/build';
import type { Efectos } from './apply';
import { PROMPT_VERSION_REVISION } from './decision';
import {
  construirExpediente,
  expedienteAPrompt,
  expedienteBucket,
  incidencias,
  type EntradaExpediente,
  type GrupoDeEventos,
} from './dossier';

/**
 * El expediente, probado por lo que NO tiene que llevar.
 *
 * Es la doctrina de `market-features.ts` («los rasgos se calculan aqui y nunca
 * los calcula el modelo») convertida en estructura, mas dos reglas propias: el
 * modelo no ve dinero ni texto que haya escrito una persona, y desde el spec 051
 * tampoco se ve a si mismo.
 */

const MERCADO: MarketFeatures = {
  mark: 78910.1,
  volAnnualPct: 68,
  atrPct1h: 0.45,
  atrPct1d: 3.2,
  rangePct30: 28,
  posInRange: 0.5,
  trendPct: 1.1,
  trend: 'LATERAL',
  efficiency: 0.22,
  worstDayPct: -7.5,
  tickBps: 1.2,
};

const CICLOS = resumenDeCiclos([
  {
    seq: 1,
    opened_at: '2026-09-10T00:00:00Z',
    closed_at: '2026-09-10T04:00:00Z',
    realized_pnl: '12.5',
    fees: '1.2',
  },
  {
    seq: 2,
    opened_at: '2026-09-10T05:00:00Z',
    closed_at: '2026-09-10T09:00:00Z',
    realized_pnl: '-4',
    fees: '1.1',
  },
  {
    seq: 3,
    opened_at: '2026-09-10T10:00:00Z',
    closed_at: '2026-09-10T15:00:00Z',
    realized_pnl: '8',
    fees: '0.9',
  },
]);

const EFECTOS: Efectos = {
  leverage: {
    soloDoble: { MENOS: false, MAS: false },
    MENOS: 'APLICABLE',
    MAS: 'RIESGO',
    campos: { MENOS: ['leverage', 'orderSizePerSide'], MAS: [] },
  },
  coverage: {
    soloDoble: { MENOS: false, MAS: false },
    MENOS: 'APLICABLE',
    MAS: 'RIESGO',
    campos: { MENOS: ['defensiveThresholdPct', 'highRiskThresholdPct'], MAS: [] },
  },
  spread: {
    soloDoble: { MENOS: false, MAS: false },
    MENOS: 'EXTREMO',
    MAS: 'APLICABLE',
    campos: {
      MENOS: [],
      MAS: [
        'buyDistanceBps',
        'sellDistanceBps',
        'minAllowedDistanceBps',
        'repriceThresholdBps',
        'maxDynamicSpreadBps',
      ],
    },
  },
  sizeGrowth: {
    soloDoble: { MENOS: false, MAS: false },
    MENOS: 'SIN_CAMBIOS',
    MAS: 'VALIDACION',
    campos: { MENOS: [], MAS: [] },
  },
  cadence: {
    soloDoble: { MENOS: false, MAS: false },
    MENOS: 'APLICABLE',
    MAS: 'APLICABLE',
    campos: { MENOS: ['refreshSeconds'], MAS: ['refreshSeconds'] },
  },
};

function entrada(cambios: Partial<EntradaExpediente> = {}): EntradaExpediente {
  return {
    estrategia: 'MARKET_MAKER',
    direccion: 'LONG',
    simulado: false,
    estado: 'RUNNING',
    horasEnMarcha: 96,
    knobs: defaultKnobs('EQUILIBRADA', MERCADO),
    mercado: MERCADO,
    mercadoAlConfigurar: { ...MERCADO, atrPct1d: 1.1 },
    ciclos: CICLOS,
    capital: '5000.000000000000000000',
    expuesto: '4200.5',
    noRealizado: '-38.25',
    posicionAbierta: true,
    estadoFresco: true,
    distanciaLiquidacionPct: 12.4,
    ordenesVivas: 6,
    horasSinEjecutar: 2,
    grupos24h: [
      { tipo: 'FILL', severidad: 'INFO', n: 48 },
      { tipo: 'ORDER_REJECTED', severidad: 'WARN', n: 3 },
      { tipo: 'CYCLE_CLOSED', severidad: 'INFO', n: 3 },
    ],
    mm: {
      fills: 311,
      compras: 160,
      ventas: 151,
      maker: 290,
      taker: 21,
      pares: 140,
      margenBruto: '61.77',
      comisiones: '23.41',
    },
    realizadoAcumulado: '38.36',
    realizado24h: '-7.13',
    historial: [
      { accion: 'AJUSTAR', estado: 'APLICADA', movimientos: { spread: 'MAS' }, hace: '3 hora(s)' },
    ],
    ultimoAviso: null,
    efectos: EFECTOS,
    ...cambios,
  };
}

/** Los importes de `entrada()`: ninguno puede llegar al prompt. */
const IMPORTES = [
  '5000',
  '4200',
  '38.25',
  '78910',
  '12.5',
  '4200.5',
  '61.77',
  '23.41',
  '38.36',
  '7.13',
];

/**
 * El expediente del market maker V2 de LIT el 2026-09-15, con importes cambiados para que
 * ninguno coincida con un porcentaje. Es el que produjo veinte avisos en un dia:
 * un market maker V2 simulado, rentable en apariencia —mil ejecuciones, todo
 * como maker— que perdia en cada par, con sus propios avisos y los rechazos
 * post-only de su conducta normal presentados como incidencias.
 */
const LIT = entrada({
  estrategia: 'MARKET_MAKER_V2',
  direccion: 'NEUTRAL',
  simulado: true,
  horasEnMarcha: 72,
  capital: '512.34',
  expuesto: '65.46',
  noRealizado: '-0.79',
  posicionAbierta: true,
  distanciaLiquidacionPct: null,
  ordenesVivas: 4,
  horasSinEjecutar: 0.2,
  grupos24h: [
    { tipo: 'FILL', severidad: 'INFO', n: 520 },
    { tipo: 'ORDER_REJECTED', severidad: 'INFO', n: 19 },
    { tipo: 'ORDER_REJECTED', severidad: 'WARN', n: 2 },
    { tipo: 'AI_ADVICE', severidad: 'INFO', n: 20 },
    { tipo: 'AI_FAILED', severidad: 'WARN', n: 1 },
    { tipo: 'AI_APPLIED', severidad: 'WARN', n: 1 },
    { tipo: 'CONFIG_UPDATED', severidad: 'INFO', n: 1 },
    { tipo: 'BOT_STARTED', severidad: 'INFO', n: 1 },
    { tipo: 'BOT_RESUMED', severidad: 'INFO', n: 2 },
    { tipo: 'COMMAND_REPAIR', severidad: 'INFO', n: 2 },
    { tipo: 'BOT_REPAIRED', severidad: 'WARN', n: 1 },
    { tipo: 'VENUE_UNAVAILABLE', severidad: 'WARN', n: 3 },
    { tipo: 'RISK_GUARD_TRIPPED', severidad: 'CRITICAL', n: 1 },
  ],
  mm: {
    fills: 1451,
    compras: 726,
    ventas: 725,
    maker: 1451,
    taker: 0,
    pares: 758,
    margenBruto: '-16.61',
    comisiones: '16.83',
  },
  realizadoAcumulado: '-33.44',
  realizado24h: '-9.87',
  historial: [
    {
      accion: 'AJUSTAR',
      estado: 'RECHAZADA',
      movimientos: { coverage: 'MAS', leverage: 'MENOS' },
      hace: '2 día(s)',
    },
  ],
  ultimoAviso: '2 hora(s)',
});

const IMPORTES_LIT = ['512.34', '65.46', '0.79', '16.61', '16.83', '33.44', '9.87'];

describe('dossier — el modelo no ve dinero ni texto de nadie', () => {
  it('no aparece ni un importe ni un precio absoluto', () => {
    // El capital, la exposicion, el resultado y el precio entran en la entrada y
    // NO pueden salir: se convierten en porcentajes y tramos. Un numero absoluto
    // ademas no significa nada sin el resto del contexto — «posicion de 4.200» no
    // dice si es mucho o poco; «casi todo el capital» se interpreta solo.
    for (const [caso, importes] of [
      [entrada(), IMPORTES],
      [LIT, IMPORTES_LIT],
    ] as const) {
      const texto = expedienteAPrompt(construirExpediente(caso));
      for (const importe of importes) {
        expect(`${importe} en el prompt: ${texto.includes(importe)}`).toBe(
          `${importe} en el prompt: false`,
        );
      }
    }
  });

  it('no aparece nada que parezca una credencial o un identificador', () => {
    for (const caso of [entrada(), LIT]) {
      const json = JSON.stringify(construirExpediente(caso));
      expect(json).not.toMatch(/key|secret|token|privad|address|accountId|userId|botId/i);
    }
  });

  it('no aparece el nombre ni la nota del bot, porque no entran siquiera', () => {
    // Los escribe el usuario: son la via natural de inyeccion de prompt, y no
    // aportan nada a la decision. Ni siquiera estan en el tipo de entrada, asi
    // que no hay forma de colarlos sin cambiar el contrato.
    const claves = Object.keys(entrada());
    expect(claves).not.toContain('nombre');
    expect(claves).not.toContain('name');
    expect(claves).not.toContain('note');
    expect(claves).not.toContain('nota');
  });
});

describe('dossier — el modelo no se lee a si mismo (spec 051)', () => {
  it('las incidencias son solo avisos y errores reales', () => {
    // Lo que tenia lit en el expediente: 520 fills, 19 rechazos post-only, 20
    // avisos del propio supervisor, las reanudaciones de su dueño tras la caida
    // de Hyperliquid... y todo salia bajo «Incidencias».
    expect(incidencias(LIT.grupos24h)).toEqual({ ORDER_REJECTED: 2, RISK_GUARD_TRIPPED: 1 });
  });

  it('un evento del supervisor no es una incidencia ni siquiera como WARN', () => {
    const grupos: GrupoDeEventos[] = [
      { tipo: 'AI_FAILED', severidad: 'WARN', n: 5 },
      { tipo: 'AI_APPLIED', severidad: 'WARN', n: 1 },
      { tipo: 'COMMAND_STOP_AND_CLOSE', severidad: 'WARN', n: 1 },
      { tipo: 'BOT_STOPPED', severidad: 'WARN', n: 1 },
      { tipo: 'STREAM_ERROR', severidad: 'WARN', n: 2 },
      { tipo: 'PANIC', severidad: 'WARN', n: 1 },
    ];
    expect(incidencias(grupos)).toEqual({});
  });

  it('lo que ninguna perilla arregla tampoco es una incidencia (spec 052, F-18)', () => {
    // El tick lento es el cupo de peticiones del venue haciendo esperar al motor,
    // y los dos «SKIPPED» son ajustes que el exchange no acepta con posicion
    // abierta. Presentarlos como averia solo lleva al modelo a avisar de algo que
    // no puede tocar. `FAIR_PRICE_*` si se queda: ahi tiene que actuar una
    // persona, y para eso esta AVISAR.
    const grupos: GrupoDeEventos[] = [
      { tipo: 'TICK_SLOW', severidad: 'WARN', n: 4 },
      { tipo: 'LEVERAGE_SKIPPED', severidad: 'WARN', n: 1 },
      { tipo: 'POSITION_MODE_SKIPPED', severidad: 'WARN', n: 1 },
      { tipo: 'FAIR_PRICE_STALE', severidad: 'WARN', n: 2 },
      { tipo: 'TICK_ERROR', severidad: 'WARN', n: 3 },
    ];
    expect(incidencias(grupos)).toEqual({ FAIR_PRICE_STALE: 2, TICK_ERROR: 3 });
  });

  it('una propuesta que caduco sin respuesta se cuenta como tal (spec 052, F-17)', () => {
    // Sin ella el modelo no sabia que ya la habia hecho y la repetia en cuanto la
    // huella cambiaba, con otro mensaje de Telegram cada vez.
    const texto = expedienteAPrompt(
      construirExpediente(
        entrada({
          historial: [
            {
              accion: 'AJUSTAR',
              estado: 'CADUCADA',
              movimientos: { spread: 'MAS' },
              hace: '5 hora(s)',
            },
          ],
        }),
      ),
    );
    expect(texto).toContain('CADUCADO sin que nadie lo aprobara');
    expect(texto).toContain('no lo repitas sin un motivo nuevo');
  });

  it('suma las severidades de un mismo tipo', () => {
    const grupos: GrupoDeEventos[] = [
      { tipo: 'ORDER_REJECTED', severidad: 'WARN', n: 3 },
      { tipo: 'ORDER_REJECTED', severidad: 'ERROR', n: 2 },
      { tipo: 'ORDER_REJECTED', severidad: 'INFO', n: 40 },
      { tipo: 'TICK_ERROR', severidad: 'WARN', n: 1 },
    ];
    expect(incidencias(grupos)).toEqual({ ORDER_REJECTED: 5, TICK_ERROR: 1 });
  });

  it('el prompt de lit no trae ni sus avisos, ni sus fills, ni la operacion normal', () => {
    const texto = expedienteAPrompt(construirExpediente(LIT));
    for (const ruido of [
      'AI_',
      'FILL',
      'CONFIG_UPDATED',
      'BOT_STARTED',
      'BOT_RESUMED',
      'BOT_REPAIRED',
      'COMMAND_REPAIR',
      'VENUE_UNAVAILABLE',
    ]) {
      expect(`${ruido}: ${texto.includes(ruido)}`).toBe(`${ruido}: false`);
    }
    expect(texto).toContain('- ORDER_REJECTED: alguno (1-3)');
    expect(texto).toContain('- RISK_GUARD_TRIPPED: alguno (1-3)');
  });

  it('el historial son cambios con sus movimientos, nunca la prosa del modelo', () => {
    const e = construirExpediente(LIT);
    expect(e.historial).toEqual([
      'hace 2 día(s): AJUSTAR leverage MENOS, coverage MAS → RECHAZADO por una persona: no lo repitas sin un motivo nuevo',
    ]);
    // Ni siquiera hay donde meterla.
    for (const h of LIT.historial) {
      expect(Object.keys(h)).not.toContain('motivo');
      expect(Object.keys(h)).not.toContain('rationale');
    }
  });

  it('un aviso ya dado se dice una vez, como aviso dado y no como problema', () => {
    const texto = expedienteAPrompt(construirExpediente(LIT));
    expect(texto.split('Ya se avisó a una persona').length - 1).toBe(1);
    expect(texto).toContain('no repitas el aviso salvo que haya algo NUEVO');
    expect(expedienteAPrompt(construirExpediente(entrada()))).not.toContain('Ya se avisó');
  });
});

describe('dossier — un market maker se mide por sus pares (spec 051)', () => {
  it('lit: margen NEGATIVO, sin «sin ciclos cerrados»', () => {
    const texto = expedienteAPrompt(construirExpediente(LIT));
    expect(texto).toContain('no cierra ciclos');
    expect(texto).toContain('- Pares casados: cientos');
    expect(texto).toContain('NEGATIVO');
    expect(texto).toContain('- Compras y ventas: equilibradas');
    expect(texto).toContain('- Resultado realizado: -6.5 % del capital desde que opera');
    expect(texto).toContain('- Resultado realizado en las últimas 24 h: -1.9 % del capital');
    expect(texto).toContain('100.0 % como maker');
    expect(texto).not.toContain('sin ciclos cerrados');
  });

  it('un margen positivo dice que parte se llevan las comisiones', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada()));
    // 23,41 de comisiones sobre 61,77 de margen bruto.
    expect(texto).toContain('positivo: las comisiones se llevan el 38 % de lo capturado');
  });

  it('un margen que no cubre las comisiones pierde tras comisiones', () => {
    const e = construirExpediente(
      entrada({
        mm: { ...entrada().mm!, margenBruto: '10.1', comisiones: '14.2' },
      }),
    );
    expect(e.rendimiento.marketMaker?.margen).toContain('pierde tras comisiones');
  });

  it('un market maker que solo compra lo dice', () => {
    const e = construirExpediente(entrada({ mm: { ...entrada().mm!, compras: 9, ventas: 0 } }));
    expect(e.rendimiento.marketMaker?.compraventa).toBe('solo compras, ninguna venta');
  });

  it('fuera de un market maker se sigue midiendo por ciclos', () => {
    const texto = expedienteAPrompt(
      construirExpediente(entrada({ estrategia: 'TREND_FOLLOW', mm: null })),
    );
    expect(texto).toContain('- Ciclos cerrados: 3');
    expect(texto).not.toContain('pares casados');
  });
});

describe('dossier — la liquidacion no contradice a la posicion (spec 051)', () => {
  it('con posicion y sin precio de liquidacion, lo dice asi', () => {
    // El simulado no da precio de liquidacion, y el expediente decia «sin posicion
    // abierta» a un bot con la posicion abierta.
    const e = construirExpediente(LIT);
    expect(e.posicion.distanciaLiquidacion).toContain('sin precio de liquidación');
    expect(e.posicion.resultadoLatente).not.toBe('sin posición abierta');
  });

  it('sin posicion, sin posicion', () => {
    const e = construirExpediente(
      entrada({ posicionAbierta: false, distanciaLiquidacionPct: null }),
    );
    expect(e.posicion.distanciaLiquidacion).toBe('sin posición abierta');
    expect(e.posicion.resultadoLatente).toBe('sin posición abierta');
  });
});

describe('dossier — los efectos de cada perilla (spec 051)', () => {
  it('dice que se mueve y que no, por perilla y sentido', () => {
    const e = construirExpediente(entrada());
    expect(e.efectos).toContain(
      'spread (diferencial): MENOS no (ya está en el extremo de su escala); MAS sí (mueve buyDistanceBps, sellDistanceBps, minAllowedDistanceBps y 2 más)',
    );
    expect(e.efectos).toContain(
      'leverage (apalancamiento): MENOS sí (mueve leverage, orderSizePerSide); MAS no (bloqueado: subiría el riesgo con la posición abierta)',
    );
    expect(expedienteAPrompt(e)).toContain('Qué cambiaría ahora mover cada perilla un paso');
  });

  it('sin efectos calculados, no se inventa la seccion', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada({ efectos: null })));
    expect(texto).not.toContain('Qué cambiaría ahora');
  });
});

describe('dossier — un bot recién nacido no produce basura', () => {
  const vacio = entrada({
    horasEnMarcha: 0,
    ciclos: resumenDeCiclos([]),
    expuesto: '0',
    noRealizado: '0',
    posicionAbierta: false,
    distanciaLiquidacionPct: null,
    ordenesVivas: 0,
    horasSinEjecutar: null,
    grupos24h: [],
    mm: null,
    realizadoAcumulado: null,
    realizado24h: null,
    historial: [],
    ultimoAviso: null,
    efectos: null,
    mercadoAlConfigurar: null,
  });

  it('no imprime null, NaN ni undefined en ninguna linea', () => {
    // Un bot sin un solo ciclo cerrado es el caso NORMAL en la primera revision,
    // y un prompt con «Acierto: null %» le enseña al modelo a inventarse el
    // resto.
    for (const estrategia of ['MARKET_MAKER', 'TREND_FOLLOW']) {
      const texto = expedienteAPrompt(construirExpediente({ ...vacio, estrategia }));
      for (const linea of texto.split('\n')) {
        expect(`${linea} → ${/null|NaN|undefined/.test(linea)}`).toBe(`${linea} → false`);
      }
    }
  });

  it('dice explicitamente que no hay datos, en vez de callarse', () => {
    const e = construirExpediente(vacio);
    expect(e.rendimiento.acierto).toBe('sin ciclos cerrados');
    expect(e.posicion.distanciaLiquidacion).toBe('sin posición abierta');
    expect(e.rendimiento.sinEjecutar).toBe('no ha ejecutado nunca');
    expect(e.rendimiento.marketMaker?.margen).toBe('sin pares casados todavía');
    expect(e.mercado.cambioDeVolatilidad).toBeNull();
  });

  it('un capital de cero no revienta la division', () => {
    const e = construirExpediente(entrada({ capital: '0' }));
    expect(expedienteAPrompt(e)).not.toMatch(/NaN|Infinity/);
  });
});

describe('dossier — la huella aguanta el ruido y detecta el cambio', () => {
  const huella = (e: EntradaExpediente): string => expedienteBucket(construirExpediente(e));

  it('es un hash de 40 caracteres: no se corta nada', () => {
    // Antes era la cadena formateada cortada a 64, y el corte dejaba fuera la
    // posicion, las incidencias y todo lo que no fuera mercado (spec 051, H-07).
    expect(huella(entrada())).toMatch(/^[0-9a-f]{40}$/);
    expect(construirExpediente(entrada()).huella[0]).toBe(`v${PROMPT_VERSION_REVISION}`);
  });

  it('un movimiento pequeño del precio o de la volatilidad no la cambia', () => {
    // Si cambiara, cada revision generaria una clave nueva y la barrera no
    // ahorraria una sola llamada: es lo que pasaba con la volatilidad a un decimal.
    const b = entrada({
      mercado: { ...MERCADO, mark: MERCADO.mark * 1.003, atrPct1d: 3.21, volAnnualPct: 68.1 },
      expuesto: '4203.1',
      noRealizado: '-38.9',
    });
    expect(huella(b)).toBe(huella(entrada()));
  });

  it('un cambio de regimen SI la cambia', () => {
    const b = entrada({ mercado: { ...MERCADO, atrPct1d: 9.5, volAnnualPct: 180 } });
    expect(huella(b)).not.toBe(huella(entrada()));
  });

  it('que el reloj avance no la cambia', () => {
    // La antiguedad y el historial cambian solos sin que haya pasado nada, asi
    // que no entran: si entraran, el cache caducaria por mirar la hora.
    const b = entrada({
      horasEnMarcha: 500,
      historial: [
        {
          accion: 'AJUSTAR',
          estado: 'APLICADA',
          movimientos: { cadence: 'MENOS' },
          hace: '9 hora(s)',
        },
      ],
    });
    expect(huella(b)).toBe(huella(entrada()));
  });

  it('una incidencia nueva la cambia, y un aviso del supervisor no', () => {
    const base = entrada();
    const conIncidencia = entrada({
      grupos24h: [...base.grupos24h, { tipo: 'TICK_ERROR', severidad: 'WARN', n: 2 }],
    });
    const conAvisosPropios = entrada({
      grupos24h: [
        ...base.grupos24h,
        { tipo: 'AI_ADVICE', severidad: 'INFO', n: 20 },
        { tipo: 'AI_FAILED', severidad: 'WARN', n: 1 },
      ],
    });
    expect(huella(conIncidencia)).not.toBe(huella(base));
    expect(huella(conAvisosPropios)).toBe(huella(base));
  });

  it('abrir o cerrar la posicion la cambia', () => {
    expect(huella(entrada({ posicionAbierta: false }))).not.toBe(huella(entrada()));
  });

  it('que un movimiento deje de tener efecto la cambia', () => {
    const efectos: Efectos = {
      ...EFECTOS,
      spread: { ...EFECTOS.spread, MAS: 'VALIDACION', campos: { MENOS: [], MAS: [] } },
    };
    expect(huella(entrada({ efectos }))).not.toBe(huella(entrada()));
  });

  it('haber avisado NO la cambia: el supervisor no reacciona a su propio rastro', () => {
    // Al reves de lo que hacia el spec 051. El aviso lo escribe el supervisor, asi
    // que ponerlo en la huella significaba pagar una llamada por haber avisado, y
    // otra al caducar el aviso: dos al dia por bot, provocadas por el mismo
    // (spec 052, F-15). La linea sigue en el prompt, que es donde sirve.
    expect(huella(entrada({ ultimoAviso: '1 hora(s)' }))).toBe(huella(entrada()));
    expect(huella(entrada({ ultimoAviso: '5 hora(s)' }))).toBe(huella(entrada()));
    expect(expedienteAPrompt(construirExpediente(entrada({ ultimoAviso: '1 hora(s)' })))).toContain(
      'Ya se avisó',
    );
  });

  it('el latente que cruza el cero no la cambia (spec 052, F-14)', () => {
    // El latente de un market maker oscila alrededor de cero todo el rato: con un
    // corte justo ahi, +0,1 % y −0,1 % daban huellas distintas y cada cruce era
    // una llamada pagada sin informacion nueva.
    const capital = Number(entrada().capital);
    const conLatente = (pct: number): string =>
      huella(entrada({ noRealizado: ((capital * pct) / 100).toFixed(6) }));
    expect(conLatente(0.1)).toBe(conLatente(-0.1));
    expect(conLatente(1.5)).toBe(conLatente(-1.5));
    // Y un latente de verdad malo sigue cambiandola.
    expect(conLatente(-6)).not.toBe(conLatente(-0.1));
  });

  it('quedarse sin estado reciente la cambia, y se dice en el prompt (spec 052, F-16)', () => {
    expect(huella(entrada({ estadoFresco: false }))).not.toBe(huella(entrada()));
    const texto = expedienteAPrompt(construirExpediente(entrada({ estadoFresco: false })));
    expect(texto).toContain('No hay estado reciente del bot');
    expect(texto).toContain('Se decide como si la hubiera');
  });
});

describe('dossier — el prompt cabe en el presupuesto', () => {
  it('no se va de tamaño, ni con el expediente mas cargado', () => {
    // Objetivo del spec: menos de 1200 tokens de mensaje de usuario. Cuatro
    // caracteres por token es la regla gruesa de siempre; se deja margen.
    for (const caso of [entrada(), LIT]) {
      expect(expedienteAPrompt(construirExpediente(caso)).length).toBeLessThan(4000);
    }
  });

  it('lleva lo que de verdad decide', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada()));
    expect(texto).toContain('CAMBIO DE RÉGIMEN');
    expect(texto).toContain('Tus cambios anteriores');
    expect(texto).toContain('Perillas actuales');
  });

  it('avisa de que es simulado cuando lo es', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada({ simulado: true })));
    expect(texto).toContain('SIMULADO');
  });
});
