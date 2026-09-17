import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BOT_COMMANDS, BotCommandDto } from './dtos';

/**
 * Los comandos que admite la API (spec 059, R-11).
 *
 * Las decisiones del canal con IA NO son un comando: las escribe la API en
 * `bot_ai_intents` y las lee el worker. Si un cliente pudiera mandar una
 * «intención» como comando, habría un segundo camino para abrir operaciones
 * que no pasa por el modelo ni por sus barreras. La lista queda fijada aquí:
 * añadir un comando obliga a mirar este test.
 *
 * Mismas opciones que el `ValidationPipe` global de `main.ts`.
 */
const errores = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(BotCommandDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe('BotCommandDto — los comandos', () => {
  it('la lista es la que es', () => {
    expect([...BOT_COMMANDS]).toEqual([
      'START',
      'PAUSE',
      'RESUME',
      'STOP_KEEP_POSITION',
      'STOP_AND_CLOSE',
      'CLOSE_NOW',
      'TAKE_PROFIT_NOW',
      'ADD_SAFETY_NOW',
      'REANCHOR_GRID',
      'CANCEL_ALL_ORDERS',
      'PANIC',
      'REPAIR',
      'ADJUST_MARGIN',
    ]);
  });

  it('una intención del canal no es un comando', () => {
    for (const command of ['AI_INTENT', 'AI_ENTRY', 'AI_DECISION', 'OPEN', 'ENTER']) {
      expect(`${command}: ${errores({ command }).join()}`).toBe(`${command}: command`);
    }
  });

  it('ni cuela campos de una decisión junto a un comando válido', () => {
    expect(errores({ command: 'PAUSE', decision: { veredicto: 'OPERAR' } })).toEqual(['decision']);
    expect(errores({ command: 'PAUSE' })).toEqual([]);
  });
});
