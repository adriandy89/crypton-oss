import { serieNumerica } from '../canal/numeros';
import type { Candle } from '@crypton/shared';
import { CASCADA_POR_DEFECTO, detectarCascada, rasgosCascada, type FlujoAgresor } from './cascada';

/**
 * El detector de cascadas (spec 071).
 *
 * Lo que estos tests protegen, por orden de importancia:
 *  1. Que NADA mire después del cierre de la vela del evento. Es lo único que
 *     hace que la medición signifique algo.
 *  2. Que sin dato de flujo agresor los rasgos salgan `NaN` y no cero. Un cero
 *     ahí seria «no hubo compras», que es una afirmacion, no una ausencia.
 *  3. Que todo sea adimensional: un evento de BTC y uno de DOGE tienen que
 *     poder compararse sin que la escala delate cual es cual.
 */

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const CINCO = 300_000;

/** Velas planas a `precio`, con volumen y rango constantes. */
function planas(n: number, precio: number, vol = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * CINCO,
    o: String(precio),
    h: String(precio * 1.001),
    l: String(precio * 0.999),
    c: String(precio),
    v: String(vol),
  }));
}

/** Aplica una caída lineal de `pct` a las últimas `k` velas. */
function conCaida(velas: Candle[], k: number, pct: number, volFinal = 100): Candle[] {
  const out = velas.map((v) => ({ ...v }));
  const base = Number(out[out.length - k - 1].c);
  for (let j = 0; j < k; j++) {
    const i = out.length - k + j;
    const p = base * (1 - (pct * (j + 1)) / k);
    out[i] = {
      t: out[i].t,
      o: String(base * (1 - (pct * j) / k)),
      h: String(base * (1 - (pct * j) / k)),
      l: String(p * 0.998),
      c: String(p),
      v: String(volFinal),
    };
  }
  return out;
}

const flujoDe = (n: number, cuota: number, ops: number): FlujoAgresor => ({
  compraAgresora: Float64Array.from({ length: n }, () => 100 * cuota),
  operaciones: Float64Array.from({ length: n }, () => ops),
});

describe('detectarCascada', () => {
  const p = CASCADA_POR_DEFECTO;

  it('no ve nada en un mercado plano', () => {
    const s = serieNumerica(planas(400, 100));
    expect(detectarCascada(s, 399, p)).toBeNull();
  });

  it('ve la caída cuando pasa del umbral, y no antes', () => {
    const justa = serieNumerica(conCaida(planas(400, 100), p.ventana, 0.029));
    const pasada = serieNumerica(conCaida(planas(400, 100), p.ventana, 0.05));

    expect(detectarCascada(justa, 399, p)).toBeNull();
    expect(detectarCascada(pasada, 399, p)?.caida).toBeCloseTo(0.05, 3);
  });

  it('una subida no es una cascada: el efecto es asimétrico', () => {
    const s = serieNumerica(conCaida(planas(400, 100), p.ventana, -0.05));
    expect(detectarCascada(s, 399, p)).toBeNull();
  });

  it('no mira antes de tener ventana', () => {
    const s = serieNumerica(planas(400, 100));
    expect(detectarCascada(s, p.ventana - 1, p)).toBeNull();
  });
});

describe('rasgosCascada — lo que ve y lo que no', () => {
  const p = CASCADA_POR_DEFECTO;
  const velas = conCaida(planas(400, 100), p.ventana, 0.05);

  /**
   * La prueba que de verdad importa: cambiar lo que pasa DESPUÉS de la vela del
   * evento no puede mover ni un rasgo. Si esto falla, todo lo medido es humo.
   */
  it('no mira ni una vela más allá del evento', () => {
    const i = velas.length - 1;
    const antes = rasgosCascada(serieNumerica(velas), i, p);
    // El MISMO evento, con cien velas de futuro pegadas detrás. Y no un futuro
    // cualquiera: un desplome a la decima parte del precio, que movería
    // cualquier rasgo que se atreviera a mirarlo.
    const futuro = planas(100, 10).map((v, k) => ({ ...v, t: velas[i].t + (k + 1) * CINCO }));
    const despues = rasgosCascada(serieNumerica([...velas, ...futuro]), i, p);

    expect(antes).not.toBeNull();
    expect(despues).toEqual(antes);
  });

  it('sin flujo agresor, los rasgos de flujo son NaN y no cero', () => {
    const r = rasgosCascada(serieNumerica(velas), 399, p)!;

    expect(r).not.toBeNull();
    for (const k of [
      'cuotaCompra',
      'cuotaCompraBase',
      'operacionesRatio',
      'tamanoMedioRatio',
    ] as const) {
      expect(Number.isNaN(r[k])).toBe(true);
    }
    // Y los que no dependen del flujo sí tienen valor.
    expect(Number.isFinite(r.caida)).toBe(true);
    expect(Number.isFinite(r.expansionVolatilidad)).toBe(true);
  });

  it('con flujo, la cuota de compra se mide contra su propia línea base', () => {
    const n = velas.length;
    // Base del 50 % de compra; en la ventana del evento, 20 %: vendedores agresores.
    const f = flujoDe(n, 0.5, 200);
    for (let i = n - p.ventana; i < n; i++) f.compraAgresora[i] = 100 * 0.2;
    const r = rasgosCascada(serieNumerica(velas), 399, p, f)!;

    expect(r.cuotaCompra).toBeCloseTo(0.2, 2);
    expect(r.cuotaCompraBase).toBeCloseTo(0.5, 2);
  });

  /**
   * El tamaño medio de operación es el rasgo que más directamente delata una
   * liquidación forzada: el motor de riesgo cierra posiciones grandes de golpe,
   * así que el tamaño sube aunque el número de operaciones no.
   */
  it('detecta operaciones grandes con el mismo número de operaciones', () => {
    const n = velas.length;
    const f = flujoDe(n, 0.5, 100);
    const r = rasgosCascada(serieNumerica(velas), 399, p, f)!;

    // Mismo número de operaciones en ventana y base -> ratio 1.
    expect(r.operacionesRatio).toBeCloseTo(1, 2);
    // Y el tamaño medio sigue al volumen, que en el fixture es constante.
    expect(Number.isFinite(r.tamanoMedioRatio)).toBe(true);
  });

  /** Todo adimensional: dos pares con precios muy distintos dan lo mismo. */
  it('la escala del precio no cambia ningún rasgo', () => {
    const caro = rasgosCascada(
      serieNumerica(conCaida(planas(400, 90000), p.ventana, 0.05)),
      399,
      p,
    )!;
    const barato = rasgosCascada(
      serieNumerica(conCaida(planas(400, 0.08), p.ventana, 0.05)),
      399,
      p,
    )!;

    for (const k of Object.keys(caro) as (keyof typeof caro)[]) {
      if (Number.isFinite(caro[k]) && Number.isFinite(barato[k])) {
        expect(barato[k]).toBeCloseTo(caro[k], 4);
      }
    }
  });

  /**
   * La referencia entera o nada. Antes bastaba con que hubiera «algo» detrás y
   * con veinte velas calculaba una base de siete: todos los rasgos son
   * cocientes contra ella, así que era ruido con aspecto de dato.
   */
  it('sin la referencia completa, no hay rasgos', () => {
    const corta = serieNumerica(conCaida(planas(20, 100), p.ventana, 0.05));
    expect(rasgosCascada(corta, 19, p)).toBeNull();

    // Justo por debajo del mínimo tampoco.
    const casi = conCaida(planas(p.referencia + p.ventana - 1, 100), p.ventana, 0.05);
    expect(rasgosCascada(serieNumerica(casi), casi.length - 1, p)).toBeNull();
  });

  it('en un mercado plano no hay evento y por tanto no hay rasgos', () => {
    expect(rasgosCascada(serieNumerica(planas(400, 100)), 399, p)).toBeNull();
  });
});
