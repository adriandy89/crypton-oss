import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mutability, StrategyKind, type FieldMeta } from '@crypton/shared';
import {
  camposEfectivos,
  getStrategy,
  VENUE_MARKETS,
  type ChangedField,
} from '@crypton/strategy-core';
import { SIN_MOVIMIENTO } from './apply';
import { ETIQUETAS, lineaDeCambio, MAX_LINEAS, textoDeCambio, valorLegible } from './mensajes';

/**
 * Los avisos del Modo IA, tal como los lee una persona (spec 054).
 *
 * Lo que se prueba aqui es que un aviso se pueda leer sin abrir la app: el nombre
 * que ve el dueño en la pantalla, los dos valores y su unidad. Hasta el 054 decian
 * «ha cambiado buyDistanceBps, sellDistanceBps» y ni un numero.
 */

const MM = getStrategy(StrategyKind.MARKET_MAKER).meta.fields;
const V2 = getStrategy(StrategyKind.MARKET_MAKER_V2).meta.fields;
const TREND = getStrategy(StrategyKind.TREND_FOLLOW).meta.fields;
const TRAILING = getStrategy(StrategyKind.TRAILING_PROFIT).meta.fields;
const BTC = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!.spec;

/** Un cambio tal como lo produce `diffConfig`, con el `labelKey` del descriptor. */
function cambio(
  campos: readonly FieldMeta[],
  key: string,
  from: unknown,
  to: unknown,
): ChangedField {
  const campo = campos.find((f) => f.key === key);
  if (!campo) throw new Error(`${key} no esta en el descriptor`);
  return { key, from, to, mutability: campo.mutability, labelKey: campo.labelKey };
}

const linea = (campos: readonly FieldMeta[], key: string, from: unknown, to: unknown): string =>
  lineaDeCambio(
    cambio(campos, key, from, to),
    campos.find((f) => f.key === key),
  );

describe('mensajes — cada linea', () => {
  it('lleva el nombre de la pantalla, los dos valores y la unidad', () => {
    expect(linea(MM, 'buyDistanceBps', '12', '14')).toBe('• Distancia de compra: 12 → 14 bps');
    expect(linea(V2, 'maxBotPositionValue', '15000', '12000')).toBe(
      '• Inversión / posición máxima: 15000 → 12000 USDC',
    );
    expect(linea(V2, 'defensiveThresholdPct', 70, 87)).toBe('• Umbral defensivo: 70 → 87 %');
  });

  it('el apalancamiento va pegado, y en los dos lados', () => {
    expect(linea(MM, 'leverage', 3, 2)).toBe('• Apalancamiento: 3x → 2x');
  });

  it('los segundos se escriben «s»', () => {
    expect(linea(V2, 'fillCooldownSeconds', 35, 30)).toBe('• Espera tras un fill: 35 → 30 s');
  });

  it('en «cantidad de moneda» el tamaño va en la moneda base, no en USDC', () => {
    // Es el descriptor EFECTIVO el que lo sabe: `camposEfectivos` cambia la
    // unidad del tamaño por orden. Con el descriptor en crudo el aviso diria
    // «0.009 → 0.0072 USDC», mil veces menos de lo que es.
    const efectivos = camposEfectivos(MM, { sizingMode: 'BASE' }, BTC);
    const c = cambio(efectivos, 'orderSizePerSide', '0.009', '0.0072');
    expect(
      lineaDeCambio(
        c,
        efectivos.find((f) => f.key === 'orderSizePerSide'),
      ),
    ).toBe('• Tamaño por compra/venta: 0.009 → 0.0072 BTC');
  });

  it('la unidad que el nombre lleva entre parentesis no se repite', () => {
    expect(linea(TRAILING, 'takeProfitPct', '4.8', '6')).toBe(
      '• Beneficio al que empieza a seguir: 4.8 → 6 %',
    );
    expect(linea(TRAILING, 'trailingCallbackPct', '1.2', '1')).toBe(
      '• Retroceso para salir: 1.2 → 1 %',
    );
    expect(linea(TRAILING, 'trailingRepriceBps', 20, 25)).toBe(
      '• Umbral para mover el disparador: 20 → 25 bps',
    );
  });

  it('un porcentaje sin unidad declarada lleva «%»', () => {
    // `riskPerTradePct` es `percent` y ni su descriptor ni su nombre dicen la
    // unidad: «Riesgo por operación: 1 → 1.2» se leeria como un importe.
    expect(linea(TREND, 'riskPerTradePct', '1', '1.2')).toBe('• Riesgo por operación: 1 → 1.2 %');
  });

  it('un campo sin unidad sale sin ella', () => {
    expect(linea(TREND, 'atrStopMultiplier', '2.5', '3')).toBe('• Stop, en ATR: 2.5 → 3');
    expect(linea(V2, 'layers', 2, 3)).toBe('• Niveles de cotización: 2 → 3');
  });

  it('una clave sin nombre sale tal cual, sin inventar', () => {
    const rara: ChangedField = {
      key: 'campoRaro',
      from: 1,
      to: 2,
      mutability: Mutability.HOT,
      labelKey: 'strategy.nada.campoRaro',
    };
    expect(lineaDeCambio(rara, undefined)).toBe('• campoRaro: 1 → 2');
  });

  it('un vaciado conserva la unidad del valor que se va', () => {
    expect(linea(MM, 'maxBotPositionValue', '500', '')).toBe(
      '• Valor máximo de la posición: 500 USDC → —',
    );
    expect(linea(MM, 'maxBotPositionValue', null, '500')).toBe(
      '• Valor máximo de la posición: — → 500 USDC',
    );
    expect(linea(MM, 'leverage', null, 2)).toBe('• Apalancamiento: — → 2x');
  });
});

describe('mensajes — los valores', () => {
  it('sin ceros de relleno y sin notacion exponencial', () => {
    expect(valorLegible('5000.000000000000000000')).toBe('5000');
    expect(valorLegible('1250.00')).toBe('1250');
    expect(valorLegible(0.45)).toBe('0.45');
    expect(valorLegible('0.00000010')).toBe('0.0000001');
    expect(valorLegible(1e-7)).toBe('0.0000001');
    expect(valorLegible(-3)).toBe('-3');
  });

  it('booleanos, vacios y texto', () => {
    expect(valorLegible(true)).toBe('sí');
    expect(valorLegible(false)).toBe('no');
    expect(valorLegible(null)).toBe('—');
    expect(valorLegible(undefined)).toBe('—');
    expect(valorLegible('')).toBe('—');
    expect(valorLegible('PAUSE_ENTRIES')).toBe('PAUSE_ENTRIES');
  });
});

describe('mensajes — el aviso entero', () => {
  const dos = [cambio(MM, 'buyDistanceBps', '12', '14'), cambio(MM, 'sellDistanceBps', '12', '14')];

  it('una sugerencia: cabecera, perilla, lineas y motivo', () => {
    const texto = textoDeCambio({
      momento: 'PROPUESTO',
      cambios: dos,
      campos: MM,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' },
      motivo: 'La volatilidad ha subido.',
    });
    expect(texto).toBe(
      [
        'El supervisor propone cambiar 2 parámetros (diferencial: más):',
        '• Distancia de compra: 12 → 14 bps',
        '• Distancia de venta: 12 → 14 bps',
        'Motivo: La volatilidad ha subido.',
      ].join('\n'),
    );
  });

  it('un cambio aplicado', () => {
    const texto = textoDeCambio({
      momento: 'APLICADO',
      cambios: dos.slice(0, 1),
      campos: MM,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MUCHO_MAS' },
      motivo: 'x',
    });
    expect(texto.split('\n')[0]).toBe(
      'El supervisor ha cambiado 1 parámetro (diferencial: mucho más):',
    );
  });

  it('una aprobacion dice que fue tuya y que los valores se recalcularon', () => {
    // Al aprobar se RECALCULA con el mercado de ese momento (spec 047, F-04):
    // lo aplicado puede no ser lo que decia la sugerencia.
    const texto = textoDeCambio({
      momento: 'APROBADO',
      cambios: dos,
      campos: MM,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' },
      motivo: 'La volatilidad ha subido.',
    });
    const lineas = texto.split('\n');
    expect(lineas[0]).toBe(
      'El supervisor ha cambiado 2 parámetros con tu aprobación (diferencial: más):',
    );
    expect(lineas).toContain('Valores recalculados al aprobar, con el mercado de ese momento.');
    expect(lineas.at(-1)).toBe('Motivo: La volatilidad ha subido.');
  });

  it('dos perillas, en el orden del contrato', () => {
    const texto = textoDeCambio({
      momento: 'PROPUESTO',
      cambios: dos,
      campos: MM,
      ajustes: { ...SIN_MOVIMIENTO, cadence: 'MUCHO_MENOS', leverage: 'MENOS' },
      motivo: '',
    });
    expect(texto.split('\n')[0]).toBe(
      'El supervisor propone cambiar 2 parámetros (apalancamiento: menos; cadencia: mucho menos):',
    );
  });

  it('unos desplazamientos corruptos no se inventan', () => {
    // Los de una aprobacion salen de la columna `raw`, que es JSON.
    const texto = textoDeCambio({
      momento: 'APROBADO',
      cambios: dos,
      campos: MM,
      ajustes: { spread: 5, cadence: 'MUCHISIMO', leverage: 'IGUAL', coverage: 'toString' },
      motivo: null,
    });
    expect(texto.split('\n')[0]).toBe('El supervisor ha cambiado 2 parámetros con tu aprobación:');
  });

  it('el motivo va en una sola linea, y sin motivo no hay linea', () => {
    const conSaltos = textoDeCambio({
      momento: 'PROPUESTO',
      cambios: dos,
      campos: MM,
      motivo: '  El diferencial\nno cubre\r\n  las comisiones. ',
    });
    expect(conSaltos.split('\n').at(-1)).toBe('Motivo: El diferencial no cubre las comisiones.');

    for (const motivo of ['', '   ', null, undefined]) {
      const sin = textoDeCambio({ momento: 'PROPUESTO', cambios: dos, campos: MM, motivo });
      expect(sin).not.toContain('Motivo');
      expect(sin.split('\n')).toHaveLength(3);
    }
  });

  it(`como mucho ${MAX_LINEAS} lineas de campos; el resto se cuenta`, () => {
    const once = Array.from({ length: 11 }, (_, i) => cambio(V2, 'layers', i, i + 1));
    const lineas = textoDeCambio({
      momento: 'APLICADO',
      cambios: once,
      campos: V2,
      motivo: 'x',
    }).split('\n');
    const deCampos = lineas.filter((l) => l.startsWith('• '));
    expect(deCampos).toHaveLength(MAX_LINEAS);
    expect(deCampos.at(-1)).toBe('• … y 2 más');
    expect(lineas[0]).toContain('11 parámetros');

    // Con exactamente el tope no se resume nada.
    const diez = textoDeCambio({
      momento: 'APLICADO',
      cambios: once.slice(0, MAX_LINEAS),
      campos: V2,
      motivo: 'x',
    });
    expect(diez).not.toContain('…');
  });

  it('el peor aviso cabe de sobra en un mensaje de Telegram', () => {
    // Once campos con los nombres mas largos y valores de muchos decimales, dos
    // perillas, la nota de la aprobacion y el motivo mas largo que admite el
    // contrato (240). El notificador ademas antepone el nombre del bot.
    const largos = V2.filter((f) => ETIQUETAS[f.labelKey])
      .slice(0, 11)
      .map((f) =>
        cambio(V2, f.key, '123456789.123456789012345678', '987654321.987654321098765432'),
      );
    const texto = textoDeCambio({
      momento: 'APROBADO',
      cambios: largos,
      campos: V2,
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MUCHO_MAS', sizeGrowth: 'MUCHO_MENOS' },
      motivo: 'm'.repeat(240),
    });
    expect(texto.length).toBeLessThan(2000);
  });
});

describe('mensajes — el catalogo dice lo mismo que la app', () => {
  /**
   * Las entradas de una linea de `FIELD_LABELS`. Las ayudas, que ocupan varias
   * lineas, no interesan: aqui solo hay nombres.
   */
  function catalogoDeLaApp(): Map<string, string> {
    const ruta = resolve(__dirname, '../../../../app/src/app/core/utils/field-labels.ts');
    const fuente = readFileSync(ruta, 'utf8');
    const out = new Map<string, string>();
    for (const m of fuente.matchAll(/^\s*'([^']+)':\s*'([^']*)',\s*$/gm)) out.set(m[1], m[2]);
    return out;
  }

  it('cada nombre de la API es exactamente el de la pantalla', () => {
    // Un parametro no puede llamarse de una forma en la app y de otra en el aviso
    // que manda mirarla. Si esto falla, se cambio un nombre en un sitio solo.
    const app = catalogoDeLaApp();
    expect(app.size).toBeGreaterThan(100);
    for (const [clave, nombre] of Object.entries(ETIQUETAS)) {
      expect(`${clave} = ${app.get(clave)}`).toBe(`${clave} = ${nombre}`);
    }
  });

  it('las claves del catalogo existen en algun descriptor de las cuatro estrategias', () => {
    // Una clave que ningun campo usa es una errata: su nombre no saldria nunca.
    const usadas = new Set(
      [MM, V2, TREND, TRAILING].flatMap((campos) => campos.map((f) => f.labelKey)),
    );
    for (const clave of Object.keys(ETIQUETAS)) {
      expect(`${clave}: ${usadas.has(clave)}`).toBe(`${clave}: true`);
    }
  });
});
