import { listStrategyMeta } from './registry';

/**
 * Invariantes del catálogo de campos.
 *
 * La app genera los formularios enteros a partir de `meta.fields`, así que un
 * descriptor mal formado no rompe nada en la compilación: se convierte en un
 * campo duplicado, un desplegable vacío o una casilla con un valor por defecto
 * que su propio rango rechaza. Se ve al abrir la pantalla, y no siempre.
 *
 * Estas comprobaciones son baratas y cubren las siete estrategias de golpe.
 */
describe('metadatos de las estrategias', () => {
  const metas = listStrategyMeta();

  it('hay estrategias registradas', () => {
    expect(metas.length).toBeGreaterThan(0);
  });

  for (const meta of metas) {
    describe(meta.kind, () => {
      it('no repite ninguna clave de campo', () => {
        // Un duplicado pinta el campo dos veces y la segunda copia pisa a la
        // primera al escribir: el usuario cambia una y ve cómo la otra no se
        // entera. Pasa en cuanto una estrategia declara un campo que ya venía
        // en los comunes.
        const keys = meta.fields.map((f) => f.key);
        expect(keys).toEqual([...new Set(keys)]);
      });

      it('todo campo tiene clave de etiqueta', () => {
        for (const f of meta.fields) {
          expect(f.labelKey).toBeTruthy();
        }
      });

      it('todo enum ofrece opciones', () => {
        for (const f of meta.fields) {
          // Cuenta y par son enums que se rellenan en pasos anteriores del
          // asistente: sus opciones vienen del servidor, no del descriptor.
          if (f.kind !== 'enum') continue;
          if (f.key === 'exchangeAccountId' || f.key === 'symbol') continue;
          expect(f.options?.length ?? 0).toBeGreaterThan(0);
        }
      });

      it('los grupos de botones caben en una fila', () => {
        // Por encima de tres opciones la app cae al desplegable por su cuenta,
        // así que pedir `segment` con más es una intención que no se cumple.
        for (const f of meta.fields) {
          if (f.control !== 'segment') continue;
          expect(f.options?.length ?? 0).toBeGreaterThanOrEqual(2);
          expect(f.options?.length ?? 0).toBeLessThanOrEqual(3);
        }
      });

      it('el valor por defecto respeta su propio rango', () => {
        for (const f of meta.fields) {
          if (f.default === undefined || f.default === null) continue;
          if (typeof f.default !== 'number') continue;
          if (f.min !== undefined) expect(f.default).toBeGreaterThanOrEqual(f.min);
          if (f.max !== undefined) expect(f.default).toBeLessThanOrEqual(f.max);
        }
      });

      it('el valor por defecto de un enum es una de sus opciones', () => {
        for (const f of meta.fields) {
          if (f.kind !== 'enum' || f.default === undefined) continue;
          if (!f.options?.length) continue;
          expect(f.options).toContain(f.default as string);
        }
      });

      it('`defaults()` no contradice al descriptor', () => {
        // Los dos existen y se usan a la vez: `defaults()` rellena el formulario
        // y el descriptor lo valida. Si discrepan, el asistente nace con un
        // valor que su propio campo rechaza.
        const strategy = metas.find((m) => m.kind === meta.kind);
        expect(strategy).toBeDefined();
        for (const f of meta.fields) {
          if (f.kind !== 'enum' || !f.options?.length) continue;
          const fromDefaults = defaultsOf(meta.kind)[f.key];
          if (fromDefaults === undefined) continue;
          expect(f.options).toContain(String(fromDefaults));
        }
      });
    });
  }
});

function defaultsOf(kind: string): Record<string, unknown> {
  // Import perezoso para no crear un ciclo con el registro en tiempo de módulo.
  const { getStrategy } = require('./registry') as typeof import('./registry');
  return getStrategy(kind as never).defaults();
}
