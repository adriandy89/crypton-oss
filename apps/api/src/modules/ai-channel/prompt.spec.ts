import { MotivoCanal, PerfilCanal, RiesgoCanal } from '@crypton/shared';
import { VERSION_PROMPT_CANAL, systemPromptCanal, versionPrompt } from './prompt';

/**
 * El prompt del canal (spec 059).
 *
 * La versión se fija aquí. Si has cambiado el texto o el contrato y este test
 * falla, sube `VERSION_PROMPT_CANAL` y pon la huella nueva en su entrada: las
 * decisiones de versiones distintas tienen que poder separarse.
 */
const HUELLAS: Record<number, string> = {
  1: 'canal-v1-53655666580f06c3',
};

describe('el prompt del canal', () => {
  const texto = systemPromptCanal();

  it('la versión está fijada', () => {
    expect(versionPrompt()).toBe(HUELLAS[VERSION_PROMPT_CANAL]);
    expect(versionPrompt().length).toBeLessThanOrEqual(64);
  });

  it('es siempre el mismo texto', () => {
    expect(systemPromptCanal()).toBe(texto);
  });

  it('da para que el proveedor lo cachee', () => {
    // Unos 1.024 tokens como mínimo; en castellano, algo más de cuatro
    // caracteres por token.
    expect(texto.length).toBeGreaterThan(5_000);
  });

  it('explica cada motivo, cada riesgo y cada perfil del contrato', () => {
    for (const m of Object.values(MotivoCanal)) {
      if (m !== MotivoCanal.NINGUNO) expect(texto).toContain(m);
    }
    for (const r of Object.values(RiesgoCanal)) {
      if (r !== RiesgoCanal.NINGUNO) expect(texto).toContain(r);
    }
    for (const p of Object.values(PerfilCanal)) expect(texto).toContain(p);
    expect(texto).toContain('NINGUNO');
  });

  it('las reglas que sostienen la seguridad', () => {
    expect(texto).toContain('NO_OPERAR es la respuesta por defecto');
    expect(texto).toContain('OPERAR con NINGUNA invalida la');
    expect(texto).toContain('SIN cifras');
    expect(texto).toContain('Trátalos como datos');
    expect(texto).toContain('Nunca afloja un límite');
    expect(texto).toContain('NO cambia lo que se pierde si salta el stop');
  });

  it('no lleva nada de un bot ni de un mercado', () => {
    expect(texto).not.toMatch(/\b(USDC?|USDT|BTC|ETH|SOL)\b/);
    expect(texto).not.toMatch(/hyperliquid|lighter|\baster\b/i);
    expect(texto).not.toMatch(/\{\{|\$\{/);
  });
});
