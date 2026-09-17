import { RegimenMercado, SentidoTendencia, type Candle } from '@crypton/shared';
import { serieNumerica } from './numeros';
import { regimen, regimenCrudo, type MedidasRegimen } from './regimen';
import { HORA, historiaConRango, QUINCE_MIN, senoidal } from './testing-canal';

/**
 * El régimen del spec 058. La lógica se prueba con medidas explícitas; las
 * series sintéticas prueban que el cálculo llega a ellas bien alineado.
 */

const rango: MedidasRegimen = {
  adx: 15,
  adxHace3: 16,
  masDi: 20,
  menosDi: 22,
  chop1h: 60,
  chop15m: 55,
  percentilEficiencia: 20,
  percentilAncho: 40,
  ratioAtr: 1,
};

describe('regimenCrudo', () => {
  it('con los cuatro criterios y CHOP(15m) > 50, rango', () => {
    expect(regimenCrudo(rango)).toEqual({ regimen: RegimenMercado.RANGO, sentido: null });
  });

  it('basta con tres de cuatro', () => {
    expect(regimenCrudo({ ...rango, chop1h: 40 }).regimen).toBe(RegimenMercado.RANGO);
    expect(regimenCrudo({ ...rango, chop1h: 40, percentilEficiencia: 50 }).regimen).toBe(
      RegimenMercado.INDEFINIDO,
    );
  });

  it('sin la confirmación de 15 min, no es rango', () => {
    expect(regimenCrudo({ ...rango, chop15m: 45 }).regimen).toBe(RegimenMercado.INDEFINIDO);
  });

  it('el ADX puede oscilar dos puntos sin dejar de contar como «sin subir»', () => {
    expect(regimenCrudo({ ...rango, chop1h: 40, adx: 17, adxHace3: 15 }).regimen).toBe(
      RegimenMercado.RANGO,
    );
    expect(regimenCrudo({ ...rango, chop1h: 40, adx: 18, adxHace3: 15 }).regimen).toBe(
      RegimenMercado.INDEFINIDO,
    );
  });

  it('tendencia: ADX ≥ 25 que no baja, ADX ≥ 40, o eficiencia en el percentil ≥ 70', () => {
    expect(regimenCrudo({ ...rango, adx: 26, adxHace3: 24 })).toEqual({
      regimen: RegimenMercado.TENDENCIA,
      sentido: SentidoTendencia.BAJISTA,
    });
    expect(regimenCrudo({ ...rango, adx: 26, adxHace3: 30 }).regimen).not.toBe(
      RegimenMercado.TENDENCIA,
    );
    expect(regimenCrudo({ ...rango, adx: 45, adxHace3: 60 }).regimen).toBe(
      RegimenMercado.TENDENCIA,
    );
    expect(regimenCrudo({ ...rango, percentilEficiencia: 70, masDi: 30, menosDi: 10 })).toEqual({
      regimen: RegimenMercado.TENDENCIA,
      sentido: SentidoTendencia.ALCISTA,
    });
  });

  it('la tendencia manda sobre todo; la compresión, sobre el rango', () => {
    expect(regimenCrudo({ ...rango, percentilAncho: 10, ratioAtr: 0.7 }).regimen).toBe(
      RegimenMercado.COMPRESION,
    );
    expect(regimenCrudo({ ...rango, percentilAncho: 10, ratioAtr: 0.7, adx: 50 }).regimen).toBe(
      RegimenMercado.TENDENCIA,
    );
  });
});

/** La serie de 15 min que acaba donde acaba la de 1 h. */
const quinceHasta = (h1: Candle[]): Candle[] => {
  const fin = h1[h1.length - 1].t + HORA;
  return senoidal({
    n: 200,
    periodo: 8,
    amplitud: 0.8,
    centro: Number(h1[h1.length - 1].c),
    desde: fin - 200 * QUINCE_MIN,
  });
};

describe('regimen con histéresis', () => {
  it('una tendencia de verdad es tendencia en las tres evaluaciones', () => {
    const h1 = historiaConRango(7919, 480, 0, 1);
    const r = regimen(serieNumerica(h1), serieNumerica(quinceHasta(h1)));
    expect(r.regimen).toBe(RegimenMercado.TENDENCIA);
    expect(r.crudos).toEqual([
      RegimenMercado.TENDENCIA,
      RegimenMercado.TENDENCIA,
      RegimenMercado.TENDENCIA,
    ]);
  });

  it('un rango tras las tendencias es rango', () => {
    const h1 = historiaConRango(5 * 7919, 300, 180);
    const r = regimen(serieNumerica(h1), serieNumerica(quinceHasta(h1)));
    expect(r.regimen).toBe(RegimenMercado.RANGO);
    expect(r.sentido).toBeNull();
  });

  it('si las tres evaluaciones no coinciden, INDEFINIDO', () => {
    // Con esta semilla el rango acaba de formarse: solo la última lectura lo es.
    const h1 = historiaConRango(2 * 7919, 300, 180);
    const r = regimen(serieNumerica(h1), serieNumerica(quinceHasta(h1)));
    expect(r.crudos).toEqual([
      RegimenMercado.INDEFINIDO,
      RegimenMercado.INDEFINIDO,
      RegimenMercado.RANGO,
    ]);
    expect(r.regimen).toBe(RegimenMercado.INDEFINIDO);
  });

  it('sin 100 velas de 1 h no hay régimen', () => {
    const h1 = historiaConRango(7919, 90, 0);
    const r = regimen(serieNumerica(h1), serieNumerica(quinceHasta(h1)));
    expect(r).toEqual({
      regimen: RegimenMercado.INDEFINIDO,
      sentido: null,
      medidas: null,
      crudos: [],
    });
  });

  it('solo usa las velas de 1 h cerradas al final de cada vela de 15 min', () => {
    // Una vela de 1 h que empieza DESPUÉS del final de la de 15 min no cuenta:
    // añadirla, con un valor absurdo, no puede cambiar nada.
    const h1 = historiaConRango(5 * 7919, 300, 180);
    const m15 = quinceHasta(h1);
    const base = regimen(serieNumerica(h1), serieNumerica(m15));
    const ultima = h1[h1.length - 1];
    const futura: Candle = { ...ultima, t: ultima.t + HORA, o: '1', h: '1000', l: '1', c: '1000' };
    const conFutura = regimen(serieNumerica([...h1, futura]), serieNumerica(m15));
    expect(conFutura).toEqual(base);
  });
});
