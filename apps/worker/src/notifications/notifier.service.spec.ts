import { NotifierService } from './notifier.service';

/**
 * El resumen diario sumaba el PnL de los bots SIMULADOS al de los reales.
 *
 * La regla de la casa está escrita en `portfolio-aggregate.ts`: «el resultado de
 * un simulado es dinero que no existe y no se suma nunca al de verdad». La
 * cartera, los snapshots y el ranking la respetaban; este resumen —el único
 * mensaje que muchos usuarios leen— no, y daba una cifra de ganancias que
 * mezclaba las dos (spec 029).
 */

type Fila = { realized_pnl: string; fees: string; bot: { dry_run: boolean } };
type BotFila = { status: string; dry_run: boolean };

function build(cycles: Fila[], bots: BotFila[]) {
  const enviados: { chatId: string; text: string }[] = [];

  const db = {
    telegramLink: {
      findMany: jest.fn().mockResolvedValue([
        {
          user_id: 'u-1',
          chat_id: '111',
          prefs: {},
          verified_at: new Date(),
        },
      ]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    botCycle: { findMany: jest.fn().mockResolvedValue(cycles) },
    bot: { findMany: jest.fn().mockResolvedValue(bots), findUnique: jest.fn() },
  };
  const bus = { originId: 'test', listen: jest.fn(), publish: jest.fn() };
  const leases = { tryLock: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue('token-de-prueba') };

  const service = new NotifierService(db as never, bus as never, leases as never, config as never);

  // El cliente sale a la red; aquí solo interesa QUÉ se manda.
  (service as unknown as { client: { enabled: boolean; sendMessage: unknown } }).client = {
    enabled: true,
    sendMessage: async (chatId: string, text: string) => {
      enviados.push({ chatId, text });
      return true;
    },
  };

  return { service, enviados, db };
}

const ciclo = (pnl: string, dryRun: boolean): Fila => ({
  realized_pnl: pnl,
  fees: '0',
  bot: { dry_run: dryRun },
});

describe('NotifierService — resumen diario', () => {
  it('no suma el resultado de los bots simulados al de los reales', async () => {
    const { service, enviados } = build(
      [ciclo('10', false), ciclo('100', true)],
      [
        { status: 'RUNNING', dry_run: false },
        { status: 'RUNNING', dry_run: true },
      ],
    );

    await service.dailyDigest();

    expect(enviados).toHaveLength(1);
    const texto = enviados[0].text;
    // El resultado es el REAL, no 110.
    expect(texto).toMatch(/Resultado: <b>\+10\.00<\/b> en 1 ciclo/);
    expect(texto).not.toMatch(/110\.00/);
    // Y el recuento de bots tampoco mezcla.
    expect(texto).toMatch(/Bots: 1 operando/);
  });

  it('el simulado sale aparte, para que no parezca parado', async () => {
    const { service, enviados } = build(
      [ciclo('10', false), ciclo('100', true)],
      [{ status: 'RUNNING', dry_run: true }],
    );

    await service.dailyDigest();

    expect(enviados[0].text).toMatch(
      /Simulado \(no cuenta\): \+100\.00 en 1 ciclo\(s\) · 1 operando/,
    );
  });

  it('sin nada que contar no manda mensaje', async () => {
    const { service, enviados } = build([], []);
    await service.dailyDigest();
    expect(enviados).toHaveLength(0);
  });
});

describe('NotifierService — etiqueta del bot', () => {
  /**
   * Un aviso de un bot de pruebas era indistinguible del de uno con dinero
   * dentro: el usuario no puede decidir si le importa sin saber cuál es.
   */
  it('marca los bots simulados', async () => {
    const { service, db } = build([], []);
    db.bot.findUnique.mockResolvedValue({ name: 'm v1', symbol: 'LIT', dry_run: true });

    const label = await (
      service as unknown as { botLabel: (id: string) => Promise<string> }
    ).botLabel('bot-1');

    expect(label).toBe('m v1 (LIT) · simulado');
  });

  it('no marca los reales', async () => {
    const { service, db } = build([], []);
    db.bot.findUnique.mockResolvedValue({ name: 'real', symbol: 'BTC', dry_run: false });

    const label = await (
      service as unknown as { botLabel: (id: string) => Promise<string> }
    ).botLabel('bot-2');

    expect(label).toBe('real (BTC)');
  });
});
