import { resumenDeCiclos, type MarketFeatures } from '@crypton/shared';
import { defaultKnobs } from '../advisor/build';
import {
  construirExpediente,
  expedienteAPrompt,
  expedienteBucket,
  type EntradaExpediente,
} from './dossier';

/**
 * El expediente, probado por lo que NO tiene que llevar.
 *
 * Es la doctrina de `market-features.ts` («los rasgos se calculan aqui y nunca
 * los calcula el modelo») convertida en estructura, mas una regla propia: el
 * modelo no ve dinero ni texto que haya escrito una persona.
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
    distanciaLiquidacionPct: 12.4,
    ordenesVivas: 6,
    makerPct: '91.5',
    horasSinEjecutar: 2,
    eventos24h: { FILL: 48, ORDER_REJECTED: 3, CYCLE_CLOSED: 3 },
    historial: [{ accion: 'MANTENER', hace: '30 minutos' }],
    ...cambios,
  };
}

describe('dossier — el modelo no ve dinero ni texto de nadie', () => {
  it('no aparece ni un importe ni un precio absoluto', () => {
    // El capital, la exposicion, el resultado y el precio entran en la entrada y
    // NO pueden salir: se convierten en porcentajes y tramos. Un numero absoluto
    // ademas no significa nada sin el resto del contexto — «posicion de 4.200» no
    // dice si es mucho o poco; «casi todo el capital» se interpreta solo.
    const texto = expedienteAPrompt(construirExpediente(entrada()));
    for (const importe of ['5000', '4200', '38.25', '78910', '12.5', '4200.5']) {
      expect(`${importe} en el prompt: ${texto.includes(importe)}`).toBe(
        `${importe} en el prompt: false`,
      );
    }
  });

  it('no aparece nada que parezca una credencial o un identificador', () => {
    const json = JSON.stringify(construirExpediente(entrada()));
    expect(json).not.toMatch(/key|secret|token|privad|address|accountId|userId|botId/i);
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

describe('dossier — un bot recién nacido no produce basura', () => {
  const vacio = entrada({
    horasEnMarcha: 0,
    ciclos: resumenDeCiclos([]),
    expuesto: '0',
    noRealizado: '0',
    distanciaLiquidacionPct: null,
    ordenesVivas: 0,
    makerPct: null,
    horasSinEjecutar: null,
    eventos24h: {},
    historial: [],
    mercadoAlConfigurar: null,
  });

  it('no imprime null, NaN ni undefined en ninguna linea', () => {
    // Un bot sin un solo ciclo cerrado es el caso NORMAL en la primera revision,
    // y un prompt con «Acierto: null %» le enseña al modelo a inventarse el
    // resto.
    const texto = expedienteAPrompt(construirExpediente(vacio));
    for (const linea of texto.split('\n')) {
      expect(`${linea} → ${/null|NaN|undefined/.test(linea)}`).toBe(`${linea} → false`);
    }
  });

  it('dice explicitamente que no hay datos, en vez de callarse', () => {
    const e = construirExpediente(vacio);
    expect(e.rendimiento.acierto).toBe('sin ciclos cerrados');
    expect(e.posicion.distanciaLiquidacion).toBe('sin posición abierta');
    expect(e.rendimiento.sinEjecutar).toBe('no ha ejecutado nunca');
    expect(e.mercado.cambioDeVolatilidad).toBeNull();
  });

  it('un capital de cero no revienta la division', () => {
    const e = construirExpediente(entrada({ capital: '0' }));
    expect(expedienteAPrompt(e)).not.toMatch(/NaN|Infinity/);
  });
});

describe('dossier — la huella aguanta el ruido y detecta el cambio', () => {
  it('un movimiento pequeño del precio no cambia la huella', () => {
    // Si cambiara, cada revision generaria una clave nueva y el cache no
    // ahorraria una sola llamada.
    const a = expedienteBucket(construirExpediente(entrada()));
    const b = expedienteBucket(
      construirExpediente(
        entrada({
          mercado: { ...MERCADO, mark: MERCADO.mark * 1.003, atrPct1d: 3.21 },
          expuesto: '4203.1',
          noRealizado: '-38.9',
        }),
      ),
    );
    expect(b).toBe(a);
  });

  it('un cambio de regimen SI cambia la huella', () => {
    const a = expedienteBucket(construirExpediente(entrada()));
    const b = expedienteBucket(
      construirExpediente(entrada({ mercado: { ...MERCADO, atrPct1d: 9.5, volAnnualPct: 180 } })),
    );
    expect(b).not.toBe(a);
  });

  it('que el reloj avance no cambia la huella', () => {
    // La antiguedad y el historial cambian solos sin que haya pasado nada, asi
    // que no entran: si entraran, el cache caducaria por mirar la hora.
    const a = expedienteBucket(construirExpediente(entrada()));
    const b = expedienteBucket(
      construirExpediente(
        entrada({ horasEnMarcha: 500, historial: [{ accion: 'AJUSTAR', hace: '2 horas' }] }),
      ),
    );
    expect(b).toBe(a);
  });

  it('cabe en la columna que la guarda', () => {
    // `bot_ai_settings.last_bucket` es VARCHAR(64).
    expect(expedienteBucket(construirExpediente(entrada())).length).toBeLessThanOrEqual(64);
  });
});

describe('dossier — el prompt cabe en el presupuesto', () => {
  it('no se va de tamaño', () => {
    // Objetivo del spec: menos de 1200 tokens de mensaje de usuario. Cuatro
    // caracteres por token es la regla gruesa de siempre; se deja margen.
    const texto = expedienteAPrompt(construirExpediente(entrada()));
    expect(texto.length).toBeLessThan(4000);
  });

  it('lleva lo que de verdad decide', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada()));
    expect(texto).toContain('CAMBIO DE RÉGIMEN');
    expect(texto).toContain('Tus decisiones anteriores');
    expect(texto).toContain('Perillas actuales');
  });

  it('avisa de que es simulado cuando lo es', () => {
    const texto = expedienteAPrompt(construirExpediente(entrada({ simulado: true })));
    expect(texto).toContain('SIMULADO');
  });
});
