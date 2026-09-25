import { FamiliaAgente, RegimenMercado, TipoStop } from '@crypton/shared';
import { prefijoSerie, serieNumerica } from '../canal/numeros';
import { detectarFamilias } from './familias';
import {
  PERIODO_DONCHIAN,
  atrLiquidacion,
  atrLiquidacionDe,
  contextoPar,
  indicadoresAgente,
  regimenAgente,
} from './mercado';
import { etiquetasAgente, tasasAgente } from './tasas';
import {
  SEMILLA_REVERSION,
  ahoraTras,
  cortarEnSenal,
  serieRango,
  serieRuptura,
  serieTendencia,
  tickerDe,
  velasDePrecios,
} from './testing-agentes';

/**
 * El análisis del agente (spec 074): indicadores, régimen, familias y tasas.
 * La propiedad que lo sostiene todo es la causalidad: lo que se calcula en la
 * vela `j` no cambia cuando llegan velas después. Sin ella, las tasas base
 * mirarían al futuro y la detección en vivo no sería la del histórico.
 */

const LADOS = ['LONG', 'SHORT'] as const;
const TODAS = [FamiliaAgente.TENDENCIA, FamiliaAgente.RUPTURA, FamiliaAgente.REVERSION];

const SERIES = {
  tendenciaLarga: serieTendencia('LONG'),
  tendenciaCorta: serieTendencia('SHORT'),
  rango: serieRango(3),
  ruptura: serieRuptura('LONG'),
};

describe('indicadoresAgente', () => {
  it('es causal: el valor en cada vela no cambia al añadir las siguientes', () => {
    for (const velas of Object.values(SERIES)) {
      const s = serieNumerica(velas);
      const completo = indicadoresAgente(s);
      for (const k of [60, 150, 201, s.n - 2]) {
        const parcial = indicadoresAgente(prefijoSerie(s, k + 1));
        for (const clave of Object.keys(completo) as (keyof typeof completo)[]) {
          const a = completo[clave][k];
          const b = parcial[clave][k];
          if (Number.isNaN(a)) expect(b).toBeNaN();
          else expect(b).toBeCloseTo(a, 9);
        }
      }
    }
  });

  it('el Donchian de una vela son las 20 ANTERIORES, sin ella', () => {
    const ps = Array.from({ length: 40 }, (_, i) => 100 + i);
    const s = serieNumerica(velasDePrecios(ps, 0));
    const ind = indicadoresAgente(s);
    // En una subida recta, el máximo de las 20 anteriores es el cierre de la anterior.
    expect(ind.donchianAlto[30]).toBe(s.h[29]);
    expect(ind.donchianBajo[30]).toBe(s.l[30 - PERIODO_DONCHIAN]);
    expect(ind.donchianAlto[PERIODO_DONCHIAN - 1]).toBeNaN();
  });

  it('el percentil del ancho va de 0 a 100', () => {
    const ind = indicadoresAgente(serieNumerica(SERIES.rango));
    const validos = Array.from(ind.percentilAncho).filter((x) => Number.isFinite(x));
    expect(validos.length).toBeGreaterThan(200);
    expect(Math.min(...validos)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...validos)).toBeLessThanOrEqual(100);
  });
});

describe('regimenAgente', () => {
  it('una tendencia limpia es TENDENCIA con su sentido', () => {
    const arriba = regimenAgente(
      serieNumerica(velasDePrecios(Array.from({ length: 200 }, (_, i) => 100 + i * 0.5))),
    );
    expect(arriba).toEqual({ regimen: RegimenMercado.TENDENCIA, sentido: 'ALCISTA' });
    const abajo = regimenAgente(
      serieNumerica(velasDePrecios(Array.from({ length: 200 }, (_, i) => 200 - i * 0.5))),
    );
    expect(abajo).toEqual({ regimen: RegimenMercado.TENDENCIA, sentido: 'BAJISTA' });
  });

  it('con menos de 100 velas no se sabe', () => {
    const corta = velasDePrecios(Array.from({ length: 90 }, (_, i) => 100 + i));
    expect(regimenAgente(serieNumerica(corta)).regimen).toBe(RegimenMercado.INDEFINIDO);
  });
});

describe('detectarFamilias', () => {
  it('cada familia dispara en los dos lados con su serie', () => {
    for (const lado of LADOS) {
      expect(() =>
        cortarEnSenal(serieTendencia(lado), FamiliaAgente.TENDENCIA, lado),
      ).not.toThrow();
      expect(() => cortarEnSenal(serieRuptura(lado), FamiliaAgente.RUPTURA, lado)).not.toThrow();
      expect(() =>
        cortarEnSenal(serieRango(SEMILLA_REVERSION[lado]), FamiliaAgente.REVERSION, lado),
      ).not.toThrow();
    }
  });

  it('es causal: lo que se detecta en j es lo mismo con o sin las velas de después', () => {
    for (const velas of Object.values(SERIES)) {
      const s = serieNumerica(velas);
      const ind = indicadoresAgente(s);
      for (let j = 150; j < s.n; j += 7) {
        const pre = prefijoSerie(s, j + 1);
        const antes = detectarFamilias(pre, indicadoresAgente(pre), j, TODAS, LADOS);
        expect(detectarFamilias(s, ind, j, TODAS, LADOS)).toEqual(antes);
      }
    }
  });

  it('la geometría de cada detección: stop detrás, objetivos delante y en orden', () => {
    for (const velas of Object.values(SERIES)) {
      const s = serieNumerica(velas);
      const ind = indicadoresAgente(s);
      for (let j = 150; j < s.n; j++) {
        for (const d of detectarFamilias(s, ind, j, TODAS, LADOS)) {
          const largo = d.lado === 'LONG';
          const c = s.c[j];
          const stop = largo
            ? d.extremo - d.stopsAtr[TipoStop.NORMAL] * ind.atr[j]
            : d.extremo + d.stopsAtr[TipoStop.NORMAL] * ind.atr[j];
          expect(largo ? stop < c : stop > c).toBe(true);
          expect(largo ? d.tp1 > c : d.tp1 < c).toBe(true);
          expect(largo ? d.tp2 >= d.tp1 : d.tp2 <= d.tp1).toBe(true);
          expect(d.stopsAtr[TipoStop.AJUSTADO]).toBeLessThan(d.stopsAtr[TipoStop.NORMAL]);
          expect(d.stopsAtr[TipoStop.NORMAL]).toBeLessThan(d.stopsAtr[TipoStop.AMPLIO]);
          if (d.familia === FamiliaAgente.RUPTURA) expect(d.nivel).toBe(d.extremo);
          else expect(d.nivel).toBeNull();
        }
      }
    }
  });

  it('solo las familias y lados pedidos', () => {
    const velas = cortarEnSenal(serieTendencia('LONG'), FamiliaAgente.TENDENCIA, 'LONG');
    const s = serieNumerica(velas);
    const ind = indicadoresAgente(s);
    const j = s.n - 1;
    expect(detectarFamilias(s, ind, j, TODAS, LADOS).map((d) => d.familia)).toContain(
      FamiliaAgente.TENDENCIA,
    );
    expect(detectarFamilias(s, ind, j, [FamiliaAgente.REVERSION], LADOS)).toEqual([]);
    expect(detectarFamilias(s, ind, j, TODAS, ['SHORT']).map((d) => d.familia)).not.toContain(
      FamiliaAgente.TENDENCIA,
    );
  });

  it('tendencia y reversión no disparan a la vez: la frontera del ADX las separa', () => {
    for (const velas of Object.values(SERIES)) {
      const s = serieNumerica(velas);
      const ind = indicadoresAgente(s);
      for (let j = 150; j < s.n; j++) {
        const fs = detectarFamilias(s, ind, j, TODAS, LADOS).map((d) => d.familia);
        expect(fs.includes(FamiliaAgente.TENDENCIA) && fs.includes(FamiliaAgente.REVERSION)).toBe(
          false,
        );
      }
    }
  });
});

describe('tasas del agente', () => {
  const costes = { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 };

  it('las etiquetas de una familia y lado no se solapan', () => {
    for (const velas of Object.values(SERIES)) {
      const s = serieNumerica(velas);
      const etiquetas = etiquetasAgente(s, indicadoresAgente(s), {
        familias: TODAS,
        lados: LADOS,
        costes,
        maxVelas: 24,
      });
      const porClave = new Map<string, number>();
      for (const e of etiquetas) {
        const clave = `${e.familia}|${e.lado}`;
        expect(e.indice).toBeGreaterThanOrEqual(porClave.get(clave) ?? 0);
        expect(e.salida).toBeGreaterThan(e.indice);
        porClave.set(clave, e.salida + 1);
      }
    }
  });

  it('resumen por familia y lado: n, aciertos y R medio de sus etiquetas', () => {
    const s = serieNumerica(SERIES.rango);
    const ind = indicadoresAgente(s);
    const p = { familias: TODAS, lados: LADOS, costes, maxVelas: 24 };
    const etiquetas = etiquetasAgente(s, ind, p);
    const tasas = tasasAgente(s, ind, p);
    expect(tasas.size).toBeGreaterThan(0);
    for (const [clave, t] of tasas) {
      const grupo = etiquetas.filter((e) => `${e.familia}|${e.lado}` === clave);
      expect(t.n).toBe(grupo.length);
      expect(t.aciertos).toBe(grupo.filter((e) => e.r > 0).length);
      expect(t.rMedio).toBeCloseTo(grupo.reduce((a, e) => a + e.r, 0) / grupo.length, 12);
    }
  });
});

describe('contexto y ATR de liquidación', () => {
  it('el contexto va en unidades relativas', () => {
    const velas = SERIES.rango;
    const s = serieNumerica(velas);
    const ind = indicadoresAgente(s);
    const ticker = tickerDe(velas);
    const c = contextoPar(s, ind, regimenAgente(s), ticker, 1.5, true);
    expect(c.precio).toBe(ticker.mark);
    expect(c.atrPct).toBeGreaterThan(0);
    expect(c.percentilAncho).toBeGreaterThanOrEqual(0);
    expect(c.fundingBps).toBe(1.5);
    expect(c.frescas).toBe(true);
  });

  it('por debajo de 1 h, la liquidación se mide con el ATR de la hora si es mayor', () => {
    // Velas de 15 min construidas a partir de las de 1 h: cuatro por hora.
    const cuarto = serieRango(7, 600).map((v, i) => ({ ...v, t: v.t - i * 2_700_000 }));
    const atr15 = 0.5;
    expect(atrLiquidacion(cuarto, '15m', atr15)).toBeGreaterThanOrEqual(atr15);
    // En 1 h o más, el del intervalo tal cual.
    expect(atrLiquidacion(SERIES.rango, '1h', 0.7)).toBe(0.7);
  });

  it('atrLiquidacionDe solo mira velas cerradas', () => {
    const velas = SERIES.rango;
    const ahora = ahoraTras(velas);
    const con = atrLiquidacionDe(velas, '1h', ahora);
    // Una vela que aún no ha cerrado no cambia nada.
    const formandose = {
      ...velas[velas.length - 1],
      t: velas[velas.length - 1].t + 3_600_000,
      h: '999',
    };
    expect(atrLiquidacionDe([...velas, formandose], '1h', ahora)).toBe(con);
    expect(atrLiquidacionDe(velas.slice(0, 5), '1h', ahora)).toBeNull();
  });
});
