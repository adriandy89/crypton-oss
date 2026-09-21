import { Evidencia, type Candle } from '@crypton/shared';
import { COSTES_VENUE } from '../canal/costes';
import { serieNumerica } from '../canal/numeros';
import { historiaConRango, recta, senoidal } from '../canal/testing-canal';
import { senalTrader, type ParametrosSenal } from './senal';

const PARAMS: ParametrosSenal = {
  periodoBanda: 20,
  sigmaBanda: 2,
  ventanaBanda: 96,
  toquePorcentajeB: 0.1,
  costes: COSTES_VENUE.LIGHTER,
};

/** Un histórico de 1 h suficiente para que el régimen se pronuncie. */
const H1 = serieNumerica(historiaConRango(7, 120, 200));

function medir(velas15: Candle[], p: Partial<ParametrosSenal> = {}, bid = 99.99, ask = 100.01) {
  return senalTrader({
    s5: serieNumerica(velas15),
    s15: serieNumerica(velas15),
    h1: H1,
    bid,
    ask,
    p: { ...PARAMS, ...p },
  });
}

describe('senalTrader — los rasgos de la vela (spec 068)', () => {
  it('sin velas suficientes no opina, y eso no es un error', () => {
    expect(medir(senoidal({ n: 10, periodo: 12 }))).toBeNull();
  });

  it('mide la banda de Bollinger y coloca el precio dentro de ella', () => {
    const r = medir(senoidal({ n: 200, periodo: 12 }));

    expect(r).not.toBeNull();
    expect(r!.banda.superior).toBeGreaterThan(r!.banda.media);
    expect(r!.banda.media).toBeGreaterThan(r!.banda.inferior);
    expect(r!.banda.atr15).toBeGreaterThan(0);
    expect(r!.senal.porcentajeB).toBeGreaterThanOrEqual(0);
    expect(r!.senal.porcentajeB).toBeLessThanOrEqual(1);
    // Un seno de amplitud 1 tiene sigma 0,71, así que dos sigmas son 1,41 a cada
    // lado: la banda es más ancha que el propio recorrido.
    expect(r!.senal.anchuraAtr).toBeGreaterThan(0);
  });

  it('el borde tocado fija la dirección, y en medio no hay ninguna', () => {
    // Con la mecha por defecto el seno no llega al décimo exterior en ninguna
    // vela concreta, así que se fuerza el caso pidiendo un borde muy ancho.
    const abajo = medir(senoidal({ n: 200, periodo: 12 }), { toquePorcentajeB: 0.5 });
    expect(abajo!.senal.lado).not.toBeNull();

    // Y con un borde imposible de tocar, no hay lado: no hay operación.
    expect(
      medir(senoidal({ n: 200, periodo: 12 }), { toquePorcentajeB: 0 })!.senal.lado,
    ).toBeNull();
  });

  it('una tendencia limpia deja la deriva de la media lejos de cero', () => {
    const r = medir(recta(200, 0.05));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.senal.derivaMediaAtr)).toBeGreaterThan(0.1);
  });

  it('un rango deja la contención alta y los cruces abundantes', () => {
    const r = medir(senoidal({ n: 200, periodo: 12 }));
    expect(r!.senal.contencion).toBeGreaterThan(0.9);
    expect(r!.senal.cruces).toBeGreaterThan(5);
    expect(r!.senal.mediaVidaVelas).not.toBeNull();
  });

  it('el coste de ida y vuelta lleva dentro el spread del libro', () => {
    const estrecho = medir(senoidal({ n: 200, periodo: 12 }), {}, 99.99, 100.01);
    const ancho = medir(senoidal({ n: 200, periodo: 12 }), {}, 99.8, 100.2);

    expect(ancho!.senal.spreadBps).toBeGreaterThan(estrecho!.senal.spreadBps);
    expect(ancho!.senal.idaVueltaPrecio).toBeGreaterThan(estrecho!.senal.idaVueltaPrecio);
  });

  it('la evidencia cuenta toques comparables, no aciertos', () => {
    // Con el borde muy ancho, casi todas las velas cuentan como toque; con el
    // borde en cero, ninguna. La evidencia tiene que moverse con eso.
    const muchos = medir(senoidal({ n: 200, periodo: 12 }), { toquePorcentajeB: 0.5 });
    const ninguno = medir(senoidal({ n: 200, periodo: 12 }), { toquePorcentajeB: 0 });

    expect(muchos!.senal.evidencia).toBe(Evidencia.MODERADA);
    expect(ninguno!.senal.evidencia).toBe(Evidencia.INSUFICIENTE);
  });

  it('trae el régimen, que es la pieza que más descarta', () => {
    const r = medir(senoidal({ n: 200, periodo: 12 }));
    expect(r!.regimen.regimen).toBeDefined();
    expect(Number.isFinite(r!.senal.adx1h) || Number.isNaN(r!.senal.adx1h)).toBe(true);
  });
});
