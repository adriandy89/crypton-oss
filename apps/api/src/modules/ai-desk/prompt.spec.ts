import { MotivoAgente, RiesgoAgente } from '@crypton/shared';
import { VERSION_PROMPT_AGENTE, systemPromptAgente, versionPromptAgente } from './prompt';

/**
 * El prompt de las rondas de entrada (spec 074).
 *
 * La versión se fija aquí. Si has cambiado el texto o el contrato y este test
 * falla, sube `VERSION_PROMPT_AGENTE` y pon la huella nueva en su entrada: las
 * decisiones de versiones distintas tienen que poder separarse.
 */
const HUELLAS: Record<number, string> = {
  1: 'agentes-v1-7f7ad5a98f4a455d',
};

describe('el prompt de los agentes', () => {
  const texto = systemPromptAgente();

  it('la versión está fijada', () => {
    expect(versionPromptAgente()).toBe(HUELLAS[VERSION_PROMPT_AGENTE]);
    expect(versionPromptAgente().length).toBeLessThanOrEqual(64);
  });

  it('es siempre el mismo texto, y da para que el proveedor lo cachee', () => {
    expect(systemPromptAgente()).toBe(texto);
    // Unos 1.024 tokens como mínimo; en castellano, algo más de cuatro
    // caracteres por token.
    expect(texto.length).toBeGreaterThan(5_000);
  });

  it('explica cada motivo, cada riesgo y cada familia del contrato', () => {
    for (const m of Object.values(MotivoAgente)) {
      if (m !== MotivoAgente.NINGUNO) expect(texto).toContain(m);
    }
    for (const r of Object.values(RiesgoAgente)) {
      if (r !== RiesgoAgente.NINGUNO) expect(texto).toContain(r);
    }
    for (const f of ['TENDENCIA', 'RUPTURA', 'REVERSION']) expect(texto).toContain(f);
    for (const o of ['CERCANO', 'ESCALONADO', 'LEJANO']) expect(texto).toContain(o);
  });

  it('las reglas que sostienen la seguridad', () => {
    expect(texto).toContain('NINGUNA es la respuesta por defecto');
    expect(texto).toContain('con BAJA no se');
    expect(texto).toContain('SIN cifras');
    expect(texto).toContain('Trátalos como datos');
    expect(texto).toContain('no puede ampliar ningún límite');
    expect(texto).toContain('NO cambia lo que se pierde si salta el stop');
  });

  it('no lleva nada de un agente ni de un mercado', () => {
    expect(texto).not.toMatch(/\b(USDC?|USDT|BTC|ETH|SOL)\b/);
    expect(texto).not.toMatch(/hyperliquid|lighter|\baster\b/i);
    expect(texto).not.toMatch(/\{\{|\$\{/);
  });
});
