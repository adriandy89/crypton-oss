import { planDePrueba } from './agentes.fixture-spec';
import { textoPropuesta } from './textos';

/**
 * El aviso de una propuesta (spec 074, R-26): lo lee una persona antes de
 * pulsar «Ejecutar», así que lleva precios, riesgo en dinero y si es dinero
 * de verdad.
 */
describe('textoPropuesta', () => {
  it('una propuesta con dinero real, con todo lo que hace falta para decidir', () => {
    expect(
      textoPropuesta(planDePrueba(), {
        quote: 'USDC',
        real: true,
        confianza: 'ALTA',
        texto: 'Retroceso ordenado.',
        vidaMin: 15,
      }),
    ).toBe(
      [
        'DINERO REAL · BTC largo (TENDENCIA), confianza ALTA',
        'Entrada hasta 100.1 · stop 97 (-3.10 %)',
        'Objetivos 105 / 110 · R neto 1.60',
        'Riesgo 5.00 USDC (0.50 % del capital) · 3x aislado',
        '«Retroceso ordenado.»',
        'Caduca en 15 min.',
      ].join('\n'),
    );
  });

  it('en simulación no lo dice; en el automático, lo dice y no caduca', () => {
    const t = textoPropuesta(planDePrueba({ objetivos: [{ precio: '105', cantidad: '1' }] }), {
      quote: 'USDC',
      real: false,
      confianza: 'MEDIA',
      texto: null,
      vidaMin: null,
    });
    expect(t.split('\n')[0]).toBe('Automático: abre BTC largo (TENDENCIA), confianza MEDIA');
    expect(t).toContain('Objetivo 105 · R neto');
    expect(t).not.toContain('DINERO REAL');
    expect(t).not.toContain('Caduca');
    expect(t).not.toContain('«');
  });
});
