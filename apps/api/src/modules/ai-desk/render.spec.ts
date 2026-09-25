import { DEFAULTS_AGENTE, ofertaAgente } from '@crypton/strategy-core';
import { renderOferta } from './render';
import { candidatoDePrueba, salidaDePrueba } from './agentes.fixture-spec';

/**
 * Lo que ve el modelo en una ronda (spec 074, R-15, CA-5). Ni símbolos, ni
 * exchange, ni precios, ni importes, ni ids, ni nombres: unidades relativas y
 * pares anónimos. Y con lo que hace falta para decidir.
 */

const LIMITES = { capital: '1000', ...DEFAULTS_AGENTE };
const salida = salidaDePrueba();
const oferta = ofertaAgente(salida);
const texto = renderOferta(salida, oferta, LIMITES, ['LONG', 'SHORT']);

describe('renderOferta: privacidad', () => {
  it('ni el par, ni el exchange, ni la moneda', () => {
    expect(texto).not.toMatch(/\b(BTC|ETH|SOL|USDC?|USDT)\b/);
    expect(texto).not.toMatch(/hyperliquid|lighter|\baster\b/i);
  });

  it('ni un precio, ni un importe, ni el capital', () => {
    for (const absoluto of [
      '65000',
      '65010',
      '64230',
      '63900',
      '66400',
      '67800',
      '3000',
      '2999',
      '2167',
      '1300',
      '812',
      '546',
      '1000',
      '6501',
    ]) {
      expect(texto).not.toContain(absoluto);
    }
  });

  it('ni ids de candidatos, ni horas, ni huellas', () => {
    expect(texto).not.toContain(candidatoDePrueba().id);
    expect(texto).not.toContain(String(salida.barT));
    expect(texto).not.toContain('|');
    expect(texto).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('el par que no se ofrece no aparece, y es determinista', () => {
    expect(texto).not.toContain('par 3');
    expect(renderOferta(salida, oferta, LIMITES, ['LONG', 'SHORT'])).toBe(texto);
  });
});

describe('renderOferta: contenido', () => {
  it('los límites del dueño y el día', () => {
    expect(texto).toContain(
      'Riesgo por operación: 0.50 % del capital. Pérdida diaria máxima: 2.00 %.',
    );
    expect(texto).toContain('Lados permitidos: largos y cortos.');
    expect(texto).toContain('Velas de 1 h.');
    expect(texto).toContain('Operaciones: 1 de 4. Abiertas: 1 de 2. Pérdidas seguidas: 0.');
  });

  it('cada opción con su letra, su familia, su lado y su par anónimo', () => {
    expect(texto).toContain('OPCIONES (responde con una letra: A, B; o NINGUNA)');
    expect(texto).toContain('Opción A: TENDENCIA, largo, en el par 1');
    expect(texto).toContain('Opción B: RUPTURA, corto, en el par 2');
    expect(texto).toContain('Mercado del par 1: régimen TENDENCIA ALCISTA; ADX 27.3; RSI 55.1');
    expect(texto).toContain('funding +1.00 bps por periodo (lo pagan los largos)');
  });

  it('los objetivos y los stops en % y en ATR, con R, coste, equilibrio y bandas', () => {
    // 66400 sobre 65010.5 es un 2.14 %; en ATR de 546, 2.54.
    expect(texto).toContain('CERCANO a 2.14 % (2.54 ATR) de la entrada');
    expect(texto).toContain('· AJUSTADO: no disponible, no llega al mínimo del exchange.');
    expect(texto).toContain('R neto: 1.62 con el CERCANO, 3.40 con el LEJANO. Coste: 0.08 R.');
    expect(texto).toContain(
      'Objetivos disponibles: CERCANO, ESCALONADO, LEJANO. Tamaño MEDIO: disponible.',
    );
    // El margen en % del capital y la liquidación en stops: nunca el importe.
    expect(texto).toMatch(/BAJA 3x \(margen [\d.]+ % del capital, liquidación a [\d.]+ stops\)/);
  });

  it('el histórico con su evidencia', () => {
    expect(texto).toContain(
      '45 casos, acierto 58 %, límite inferior de Wilson 43 %, R medio +0.21, evidencia DEBIL.',
    );
  });

  it('solo largos se dice así', () => {
    expect(renderOferta(salida, oferta, LIMITES, ['LONG'])).toContain(
      'Lados permitidos: solo largos.',
    );
  });
});
