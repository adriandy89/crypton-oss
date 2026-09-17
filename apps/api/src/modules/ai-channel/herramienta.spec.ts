import type { SalidaHerramienta } from '@crypton/shared';
import { ofertaDe, renderHerramienta } from './herramienta';
import {
  ABSOLUTOS,
  CAPITAL,
  configDePrueba,
  corto,
  largo,
  salidaDePrueba,
  vigilando,
} from './oferta.fixture-spec';

/**
 * La herramienta que ve el modelo (spec 059, CA-2).
 *
 * Dos cosas: que ofrece exactamente lo que la ejecución aceptaría, y que no
 * sale de aquí nada que identifique o que sea un precio o un importe.
 */

const render = (
  salida: SalidaHerramienta = salidaDePrueba(),
  extra: Record<string, unknown> = {},
) => {
  const cfg = configDePrueba(extra);
  return renderHerramienta(salida, ofertaDe(salida, cfg), cfg);
};

describe('ofertaDe', () => {
  it('los elegibles, en su orden, con etiquetas neutras', () => {
    const o = ofertaDe(salidaDePrueba(), configDePrueba());
    expect(o.etiquetas).toEqual(['A', 'B']);
    expect(o.porEtiqueta.get('A')?.id).toBe(largo().id);
    expect(o.porEtiqueta.get('B')?.id).toBe(corto().id);
  });

  it('fuera lo que la configuración no permite', () => {
    const ids = (extra: Record<string, unknown>, salida = salidaDePrueba()) =>
      [...ofertaDe(salida, configDePrueba(extra)).porEtiqueta.values()].map((c) => c.id);
    expect(ids({ direction: 'LONG' })).toEqual([largo().id]);
    expect(ids({ direction: 'SHORT' })).toEqual([corto().id]);
    expect(ids({ allowedSetups: 'REBOTE' })).toEqual([largo().id]);
    expect(ids({ allowedSetups: 'FALSO_QUIEBRE' })).toEqual([corto().id]);
    expect(ids({ allowedChannels: 'INCLINADO' })).toEqual([]);
    expect(ids({ allowedChannels: 'HORIZONTAL' })).toHaveLength(2);
  });

  it('fuera lo descartado y lo que no tiene ningún stop disponible', () => {
    const salida = salidaDePrueba({
      candidatos: [
        vigilando(),
        largo({ id: 'REB-L-X', descartes: ['EVIDENCIA'] }),
        largo({ id: 'REB-L-Y', stops: largo().stops.map((s) => ({ ...s, viable: false })) }),
        corto(),
      ],
    });
    const o = ofertaDe(salida, configDePrueba());
    expect(o.etiquetas).toEqual(['A']);
    expect(o.porEtiqueta.get('A')?.id).toBe(corto().id);
  });

  it('sin canal no hay oferta', () => {
    expect(ofertaDe(salidaDePrueba({ canal: null }), configDePrueba()).etiquetas).toEqual([]);
  });
});

describe('renderHerramienta: privacidad', () => {
  const inclinado = (): SalidaHerramienta => {
    const s = salidaDePrueba();
    return {
      ...s,
      canal: s.canal && { ...s.canal, tipo: 'INCLINADO', pendientePorVela: 3.21, r2: 0.72 },
    };
  };

  it.each<[string, () => SalidaHerramienta]>([
    ['un canal horizontal', () => salidaDePrueba()],
    ['un canal inclinado', inclinado],
    ['sin canal', () => salidaDePrueba({ canal: null })],
  ])('con %s no sale ni un precio, ni un importe, ni un id', (_, salida) => {
    const t = render(salida());
    for (const prohibido of ABSOLUTOS) expect(t).not.toContain(prohibido);
    expect(t).not.toMatch(/\d{7,}/); // ni horas en milisegundos ni ids numéricos
    expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // ni UUID
    // Los símbolos en mayúsculas y como palabra: «solo» no es SOL.
    expect(t).not.toMatch(/\b(USDC?|USDT|BTC|ETH|SOL)\b/);
    expect(t).not.toMatch(/hyperliquid|lighter|\baster\b/i);
    expect(t).not.toMatch(/\d[eE][+-]?\d/); // ni notación científica
    // El capital solo se usa para pasar el margen a porcentaje.
    expect(t).not.toContain(CAPITAL);
  });

  it('el candidato que no se ofrece no aparece', () => {
    const t = render();
    expect(t).not.toContain('VIGILANDO');
    expect(t.match(/^Opción /gm)).toHaveLength(2);
  });

  it('es determinista', () => {
    expect(render()).toBe(render());
  });
});

describe('renderHerramienta: contenido', () => {
  const t = render();

  it('las preferencias del dueño', () => {
    expect(t).toContain('- Perfil: AGRESIVA (stop AJUSTADO si está disponible, banda ALTA');
    expect(t).toContain('- Lados permitidos: los dos (largos y cortos).');
    expect(t).toContain('- Confianza mínima para operar: MEDIA.');
    expect(t).toContain('- Esquemas de salida permitidos: MEDIA, ESCALONADO, OPUESTO.');
    expect(t).toContain('- R neto mínimo por objetivo: 1.20.');
    expect(t).toContain(
      '- Riesgo por operación: 1.00 % del capital. Tope de pérdida diaria: 6.00 %.',
    );
    expect(render(salidaDePrueba(), { direction: 'SHORT', aiProfile: 'PRUDENTE' })).toContain(
      '- Lados permitidos: solo cortos.',
    );
  });

  it('el mercado en unidades relativas', () => {
    expect(t).toContain('- Régimen en 1 h: RANGO.');
    expect(t).toContain('- ADX 1 h: 17.2. CHOP 1 h: 61.4. CHOP 15 min: 58.2.');
    expect(t).toContain('percentil 22 y anchura de bandas en el percentil 45');
    // 12,3456 / 64321,987 · 100 = 0,0192 · 43,2109 → 0,0672 · 98,7654 → 0,1535
    expect(t).toContain('- ATR: 5 min 0.02 %, 15 min 0.07 %, 1 h 0.15 % del precio.');
    expect(t).toContain('- Spread: 1.2 bps. Funding: +0.40 bps por periodo (lo pagan los largos).');
  });

  it('el funding en todas sus formas', () => {
    const conFunding = (fundingBps: number | null) => {
      const s = salidaDePrueba();
      return render({ ...s, mercado: { ...s.mercado, fundingBps } });
    };
    expect(conFunding(null)).toContain('Funding: sin dato.');
    expect(conFunding(-2.5)).toContain('Funding: -2.50 bps por periodo (lo pagan los cortos).');
    expect(conFunding(0)).toContain('Funding: +0.00 bps por periodo.');
  });

  it('el canal y el precio dentro de él', () => {
    expect(t).toContain('- HORIZONTAL, calidad B, puntuación 68 de 100.');
    // 444,444 / 64321,987
    expect(t).toContain('- Anchura: 5.60 ATR de 15 min (0.69 % del precio).');
    expect(t).toContain('Toques: 3 en el soporte y 2 en la resistencia. Cierres dentro: 96 %.');
    expect(t).toContain('- Duración: 84 velas. Media vida: 9.0 velas. Último toque: hace 1 vela.');
    expect(t).toContain('R²: no aplica.');
    expect(t).toContain('- Pendiente: horizontal.');
    // 210,876 / 444,444 = 47 %; 210,876 / 43,2109 = 4,88; 233,568 / 43,2109 = 5,41
    expect(t).toContain(
      '- Precio: al 47 % de la anchura desde el soporte (4.88 ATR sobre el soporte, 5.41 ATR bajo la resistencia).',
    );
  });

  it('un canal inclinado lleva su pendiente en ATR', () => {
    const s = salidaDePrueba();
    const canal = s.canal && {
      ...s.canal,
      tipo: 'INCLINADO' as const,
      pendientePorVela: -3.21,
      ultimoToqueHace: 3,
      mediaVidaVelas: null,
      r2: 0.7249,
    };
    const texto = render({ ...s, canal });
    // 3,21 / 43,2109 = 0,0743
    expect(texto).toContain('- Pendiente: bajista, 0.074 ATR de 15 min por vela de 15 min.');
    expect(texto).toContain('Media vida: sin estimar. Último toque: hace 3 velas. R²: 0.72.');
    expect(texto).toContain('- INCLINADO, calidad B');
  });

  it('sin canal lo dice', () => {
    expect(render(salidaDePrueba({ canal: null }))).toContain('CANAL\n- Ninguno.');
  });

  it('el día', () => {
    expect(t).toContain('- Pérdida realizada: 0.80 % del capital, con un tope del 6.00 %.');
    expect(t).toContain('- Operaciones: 1 de 8. Pérdidas seguidas: 0.');
  });

  it('cada opción con sus números relativos', () => {
    expect(t).toContain('OPCIONES (responde con una letra: A, B; o NINGUNA)');
    expect(t).toContain('Opción A: REBOTE, largo');
    expect(t).toContain('- Confirmaciones: MECHA, RSI.');
    // 2,22 / 64123,45
    expect(t).toContain(
      '- Entrada: orden inmediata con el precio limitado a 0.003 % de la referencia.',
    );
    // 207,66 / 64125,67 = 0,32 % y 4,81 ATR; 363,21 → 0,57 % y 8,41 ATR
    expect(t).toContain(
      '- Objetivos: la media a 0.32 % (4.81 ATR) de la entrada; el borde opuesto a 0.57 % (8.41 ATR).',
    );
    expect(t).toContain(
      '- Histórico del setup: 34 casos, acierto 62 %, límite inferior de Wilson 45 %, R medio +0.31, evidencia DEBIL.',
    );
    // 45,55 / 64125,67 = 0,07 %; 45,55 / 43,2109 = 1,05 ATR
    expect(t).toContain(
      '  · AJUSTADO: a 0.07 % (1.05 ATR) de la entrada. R neto: 1.87 con la media, 3.95 con el ' +
        'borde opuesto. Coste: 0.21 R. Acierto de equilibrio: 35 % con la media, 20 % con el borde opuesto.',
    );
    expect(t).toContain(
      '    Si salta, pierde el 0.29 % del capital. Esquemas disponibles: MEDIA, ESCALONADO, ' +
        'OPUESTO. Tamaño MEDIO: disponible.',
    );
    // Margen 1234,56 / 4321,5 = 28,6 %; liquidación (64125,67 − 61000,1) / 45,55 = 68,6 stops
    expect(t).toContain(
      '    Bandas: BAJA 8x (margen 28.6 % del capital, liquidación a 68.6 stops) · ' +
        'MEDIA 16x (margen 14.3 % del capital, liquidación a 35.7 stops) · ' +
        'ALTA 25x (margen 9.1 % del capital, liquidación a 22.5 stops).',
    );
    expect(t).toContain('Esquemas disponibles: MEDIA, ESCALONADO. Tamaño MEDIO: disponible.');
    expect(t).toContain('  · AMPLIO: no disponible, el stop sería más ancho de lo permitido.');
  });

  it('el corto, con lo que no tiene', () => {
    expect(t).toContain('Opción B: FALSO_QUIEBRE, corto');
    expect(t).toContain('- Confirmaciones: ninguna.');
    expect(t).toContain('- Histórico del setup: sin datos.');
    expect(t).toContain('  · AJUSTADO: no disponible, ningún objetivo permitido paga el R mínimo.');
    expect(t).toContain('Tamaño MEDIO: no disponible (no llega al mínimo del exchange).');
    expect(t).toContain('  · AMPLIO: no disponible, no llega al mínimo del exchange.');
  });

  it('un motivo desconocido no se inventa', () => {
    const s = salidaDePrueba();
    const raro = largo({
      stops: [...largo().stops.slice(0, 2), { ...largo().stops[2], motivo: 'ALGO_NUEVO' }],
    });
    expect(render({ ...s, candidatos: [raro] })).toContain(
      '  · AMPLIO: no disponible, no se ofrece.',
    );
  });
});
