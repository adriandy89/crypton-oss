import { revisionPublica } from './bots.service';

/**
 * El historial de configuración tal y como sale al cable (spec 006, R-2).
 *
 * Lo que se fija: que la configuración completa NO viaje (ya la sirve el
 * detalle y multiplicaría por veinte el peso de la lista), que el `id` BigInt
 * salga como texto, y que un `diff` que no sea una lista —la v1 lo tiene nulo,
 * y es un `Json` sin forma garantizada— no rompa la respuesta.
 */

const fila = (o: Partial<Parameters<typeof revisionPublica>[0]> = {}) => ({
  id: 7n,
  version: 3,
  config: { totalInvestment: '500', leverage: 3 },
  diff: [{ key: 'leverage', from: 2, to: 3, mutability: 'WARM', labelKey: 'fields.leverage' }],
  apply_level: 'WARM',
  applied_by: 'u1',
  created_at: new Date('2026-09-05T10:00:00.000Z'),
  ...o,
});

describe('revisionPublica', () => {
  it('saca versión, cuándo, cómo y qué cambió; nunca la configuración completa', () => {
    const out = revisionPublica(fila());
    expect(out).toEqual({
      id: '7',
      version: 3,
      createdAt: '2026-09-05T10:00:00.000Z',
      applyLevel: 'WARM',
      appliedBy: 'u1',
      diff: [{ key: 'leverage', from: 2, to: 3, mutability: 'WARM', labelKey: 'fields.leverage' }],
    });
    expect(out).not.toHaveProperty('config');
  });

  it('la v1 no tiene cambios: diff nulo, nivel COLD', () => {
    const out = revisionPublica(fila({ version: 1, diff: null, apply_level: 'COLD' }));
    expect(out.diff).toBeNull();
    expect(out.applyLevel).toBe('COLD');
  });

  it('un diff que no es una lista se descarta en vez de romper la lista', () => {
    expect(revisionPublica(fila({ diff: { raro: true } })).diff).toBeNull();
    expect(revisionPublica(fila({ diff: 'texto' })).diff).toBeNull();
    // Dentro de la lista, lo que no tiene `key` tampoco sirve para pintar nada.
    expect(revisionPublica(fila({ diff: [{ key: 'x' }, { sin: 'clave' }, 3] })).diff).toEqual([
      { key: 'x' },
    ]);
  });
});
