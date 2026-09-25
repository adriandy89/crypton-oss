import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DEFAULT_TELEGRAM_PREFS, UpdateTelegramPrefsDto } from './dtos';
import { TelegramService } from './telegram.service';

/**
 * La preferencia de los agentes de IA (spec 074).
 *
 * La API guarda las preferencias y el notificador del worker las lee con las de
 * fábrica debajo: una preferencia que la API no admitiera respondería 400 con
 * el `forbidNonWhitelisted` del `ValidationPipe` global, y el interruptor de la
 * app no haría nada.
 */

/** Mismas opciones que el `ValidationPipe` global de `main.ts`. */
const errores = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(UpdateTelegramPrefsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

function montar(prefsGuardadas: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue(undefined);
  const db = {
    telegramLink: {
      findUnique: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        chat_id: '111',
        verified_at: new Date(),
        link_code: null,
        prefs: prefsGuardadas,
      }),
      update,
    },
  };
  const config = { get: jest.fn().mockReturnValue('crypton_bot') };
  const svc = new TelegramService(db as never, config as never);
  return { svc, update };
}

describe('Telegram — la preferencia de los agentes (spec 074)', () => {
  it('se admite, y solo como booleano', () => {
    expect(errores({ agentes: false })).toEqual([]);
    expect(errores({ agentes: 'no' })).toEqual(['agentes']);
  });

  it('encendida de fábrica, también para quien vinculó antes de que existiera', async () => {
    expect(DEFAULT_TELEGRAM_PREFS.agentes).toBe(true);
    const { svc } = montar({ ai: false, fills: true });
    const estado = await svc.status('u-1');
    expect(estado.prefs).toMatchObject({ agentes: true, ai: false, fills: true });
  });

  it('apagarla no toca las demás', async () => {
    const { svc, update } = montar({ ai: false });
    const prefs = await svc.updatePrefs('u-1', { agentes: false });
    expect(prefs).toEqual({ ...DEFAULT_TELEGRAM_PREFS, ai: false, agentes: false });
    expect(update).toHaveBeenCalledWith({
      where: { user_id: 'u-1' },
      data: { prefs: { ...DEFAULT_TELEGRAM_PREFS, ai: false, agentes: false } },
    });
  });
});
