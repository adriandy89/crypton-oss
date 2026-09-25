import { StrategyKind, type BotConfig } from '@crypton/shared';
import { listStrategies } from './registry';
import { BASE_CONFIG, CONFIG_MINIMA, makeContext, makeMarket, makePosition } from './testing';

/**
 * Un campo vacío en el formulario no puede tumbar nada (spec 080, 079/F-29).
 *
 * El formulario manda `''` al vaciar una casilla. Las estrategias leían
 * `D(cfg.x ?? defecto)`, y `??` no tapa la cadena vacía: `new Decimal('')`
 * lanza. Con el techo del diferencial de la V2 vacío, `POST /bots/preview`
 * respondía un 500; con el umbral defensivo del market maker vacío, que
 * `validate()` sí dejaba pasar, el tick del worker reventaba en cada revisión.
 * Se recorren TODOS los campos de TODAS las estrategias: un campo nuevo entra
 * en la prueba sin que nadie se acuerde.
 */
const base = (kind: StrategyKind): BotConfig => ({
  ...BASE_CONFIG,
  ...listStrategies()
    .find((s) => s.kind === kind)!
    .defaults(),
  ...CONFIG_MINIMA[kind],
});

describe('un campo vacío es un campo ausente, no una excepción', () => {
  for (const s of listStrategies()) {
    describe(s.kind, () => {
      it('ningún campo con valor por defecto vacío hace lanzar a validate, preview ni plan', () => {
        const fallos: string[] = [];
        for (const f of s.meta.fields.filter((x) => !x.required || x.default !== undefined)) {
          const cfg = { ...base(s.kind), [f.key]: '' } as BotConfig;
          const intentos: [string, () => unknown][] = [
            ['validate', () => s.validate(cfg, makeMarket())],
            ['preview', () => s.preview(cfg, makeMarket(), '100')],
            ['plan', () => s.plan(makeContext({ strategy: s.kind, config: cfg }))],
            [
              'plan con posición',
              () =>
                s.plan(
                  makeContext({
                    strategy: s.kind,
                    config: cfg,
                    position: makePosition('1', '100'),
                  }),
                ),
            ],
          ];
          for (const [que, fn] of intentos) {
            try {
              fn();
            } catch (e) {
              fallos.push(`${f.key} → ${que}: ${(e as Error).message}`);
            }
          }
        }
        expect(fallos).toEqual([]);
      });

      it('un obligatorio sin valor por defecto vacío es un error de validación, no una excepción', () => {
        const fallos: string[] = [];
        for (const f of s.meta.fields.filter((x) => x.required && x.default === undefined)) {
          const cfg = { ...base(s.kind), [f.key]: '' } as BotConfig;
          try {
            const r = s.validate(cfg, makeMarket());
            if (r.ok) fallos.push(`${f.key}: vacío y válido`);
            if (s.preview(cfg, makeMarket(), '100').valid)
              fallos.push(`${f.key}: vista previa válida`);
          } catch (e) {
            fallos.push(`${f.key}: ${(e as Error).message}`);
          }
        }
        expect(fallos).toEqual([]);
      });
    });
  }
});
