import { Venue, type LimitesAgente } from '@crypton/shared';
import {
  DEFAULTS_AGENTE,
  RANGOS_AGENTE,
  dimensionadoDeAgente,
  leerLimites,
  peorDia,
  validarLimites,
} from './limites';

const validos = (o: Partial<LimitesAgente> = {}): LimitesAgente => ({
  ...DEFAULTS_AGENTE,
  capital: '1000',
  ...o,
});

const campos = (l: LimitesAgente) => validarLimites(l).map((e) => e.campo);

describe('los valores de fábrica (R-10)', () => {
  it('son los que decidió el usuario, y validan en cuanto hay capital', () => {
    expect(DEFAULTS_AGENTE).toMatchObject({
      riesgoPct: '0.5',
      perdidaDiariaPct: '2',
      maxVivas: 2,
      maxOperacionesDia: 4,
      apalancamientoMax: 10,
      margenPct: '25',
      maxStopPct: '3',
      maxCosteR: '0.2',
      minObjetivoCoste: 15,
      minObjetivoPct: '0.5',
      minRR: '1.5',
      esperaStopMin: 60,
      maxPerdidasSeguidas: 3,
      esperaRachaMin: 240,
      consultasDia: 120,
    });
    expect(validarLimites(validos())).toEqual([]);
  });

  it('sin capital no hay agente', () => {
    expect(campos(validos({ capital: '0' }))).toEqual(['capital']);
    expect(campos(validos({ capital: 'mucho' }))).toEqual(['capital']);
  });

  it('cada valor de fábrica cae dentro de su rango', () => {
    for (const [campo, [min, max]] of Object.entries(RANGOS_AGENTE)) {
      const v = Number(DEFAULTS_AGENTE[campo as keyof typeof RANGOS_AGENTE]);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
    }
  });
});

describe('validarLimites', () => {
  it('rechaza lo que se sale del rango, con el campo', () => {
    expect(campos(validos({ riesgoPct: '6' }))).toEqual(['riesgoPct']);
    expect(campos(validos({ apalancamientoMax: 0 }))).toEqual(['apalancamientoMax']);
    expect(campos(validos({ maxStopPct: 'NaN' }))).toEqual(['maxStopPct']);
  });

  it('una cuenta de operaciones no tiene decimales', () => {
    expect(campos(validos({ maxVivas: 1.5 }))).toEqual(['maxVivas']);
  });

  it('los extremos del rango entran', () => {
    expect(validarLimites(validos({ riesgoPct: '0.05', apalancamientoMax: 1 }))).toEqual([]);
  });

  it('la pérdida diaria no puede ser menor que el riesgo de una operación', () => {
    expect(campos(validos({ riesgoPct: '2', perdidaDiariaPct: '1' }))).toEqual([
      'perdidaDiariaPct',
    ]);
  });

  it('no más operaciones a la vez que al día', () => {
    expect(campos(validos({ maxVivas: 5, maxOperacionesDia: 4, margenPct: '20' }))).toEqual([
      'maxVivas',
    ]);
  });

  it('el margen de todas las vivas a la vez cabe en el capital', () => {
    expect(campos(validos({ maxVivas: 4, margenPct: '30' }))).toEqual(['margenPct']);
    expect(validarLimites(validos({ maxVivas: 4, margenPct: '25' }))).toEqual([]);
  });
});

describe('leerLimites', () => {
  it('lo guardado, tal cual', () => {
    const l = validos({ riesgoPct: '0.8', maxVivas: 3, breakevenTrasTp1: false });
    expect(leerLimites(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it('lo que falta o no se entiende cae a lo de fábrica, y el capital a cero', () => {
    const l = leerLimites({ riesgoPct: 'x', maxVivas: 2.5, breakevenTrasTp1: 'si' });
    expect(l).toEqual({ ...DEFAULTS_AGENTE, capital: '0' });
    expect(leerLimites(null)).toEqual({ ...DEFAULTS_AGENTE, capital: '0' });
  });

  it('un número donde va un decimal se acepta y se escribe como texto', () => {
    expect(leerLimites({ capital: 1500.5 }).capital).toBe('1500.5');
  });
});

describe('dimensionadoDeAgente', () => {
  it('lleva los límites al dimensionado del canal, con los costes del venue', () => {
    const d = dimensionadoDeAgente(validos(), Venue.HYPERLIQUID);
    expect(d.capital.toFixed()).toBe('1000');
    expect(d.riesgoPct.toFixed()).toBe('0.5');
    expect(d.topeDiarioPct.toFixed()).toBe('2');
    expect(d.maxMargenPct.toFixed()).toBe('25');
    expect(d.apalancamientoTope).toBe(10);
    expect(d.minRR).toBe(1.5);
    expect(d.colchonStops).toBe(3);
    expect(d.costes).toEqual({ makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 });
    expect(d.esquemas).toHaveLength(3);
  });
});

describe('peorDia', () => {
  it('es la pérdida diaria sobre el capital', () => {
    expect(peorDia({ capital: '1000', perdidaDiariaPct: '2' })).toBe('20.00');
  });
});
