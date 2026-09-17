import { Subject } from 'rxjs';
import { getStrategy } from '@crypton/strategy-core';
import { BUS_CHANNELS } from '../libs';
import { EngineService, leerInterruptor, topesCanalPorVenue } from './engine.service';

/**
 * Spec 058. Lo que el motor decide del canal con IA antes de arrancar un bot:
 * quién puede operarlo, cuántos caben por venue y si las entradas están
 * cortadas desde la consola.
 */

describe('topesCanalPorVenue', () => {
  it('lee pares VENUE=n', () => {
    expect(topesCanalPorVenue('LIGHTER=2, ASTER=5')).toEqual(
      new Map([
        ['LIGHTER', 2],
        ['ASTER', 5],
      ]),
    );
  });

  it('un par mal escrito se ignora y se avisa; el resto vale', () => {
    const avisos: string[] = [];
    const topes = topesCanalPorVenue('LIGHTER=2,lighter=3,ASTER=x,,HYPERLIQUID=10', (m) =>
      avisos.push(m),
    );
    expect(topes).toEqual(
      new Map([
        ['LIGHTER', 2],
        ['HYPERLIQUID', 10],
      ]),
    );
    expect(avisos).toHaveLength(2);
  });

  it('vacío: sin topes', () => {
    expect(topesCanalPorVenue('').size).toBe(0);
  });
});

describe('leerInterruptor', () => {
  it.each([['off'], ['"off"'], ['OFF'], [' off ']])('%s cierra las entradas', (texto) => {
    expect(leerInterruptor(texto)).toMatchObject({ permitidas: false });
  });

  it.each([[null], ['on'], ['"on"'], ['']])('%s las deja abiertas', (texto) => {
    expect(leerInterruptor(texto)).toEqual({ permitidas: true, motivo: null });
  });
});

describe('EngineService: el canal con IA al arrancar', () => {
  type Privado = {
    runners: Map<string, unknown>;
    topesCanal: Map<string, number>;
    comprobarDuenoAdmin(userId: string, strategy: string): Promise<void>;
    reservarCanal(botId: string, venue: string, strategy: string): void;
    arrancandoCanal: Map<string, string>;
    leerInterruptorCanal(): Promise<{ permitidas: boolean; motivo: string | null }>;
    spawn(botId: string): Promise<void>;
    subscribeToBus(): Promise<void>;
    anotarNocional(botId: string, strategy: string, config: unknown): Promise<void>;
    reloadConfig(botId: string, runner: unknown, data: { level?: string }): Promise<void>;
  };

  const BOT_CANAL = {
    id: 'nuevo',
    user_id: 'u1',
    strategy: 'AI_CHANNEL',
    venue: 'LIGHTER',
    dry_run: false,
    exchange_account_id: 'acc-1',
  };

  const montar = (
    dueno: unknown,
    leerTexto: () => Promise<string | null> = async () => null,
    bot: Record<string, unknown> = {},
  ) => {
    const db = {
      user: { findUnique: jest.fn().mockResolvedValue(dueno) },
      bot: { findUniqueOrThrow: jest.fn().mockResolvedValue({ ...BOT_CANAL, ...bot }) },
      // Lo primero que se lee tras las comprobaciones: llegar aquí es haberlas pasado.
      exchangeAccount: {
        findUniqueOrThrow: jest.fn().mockRejectedValue(new Error('siguió adelante')),
      },
      botConfigRevision: { findUniqueOrThrow: jest.fn() },
    };
    const store = { setMaxNotional: jest.fn().mockResolvedValue(undefined) };
    const escuchas = new Map<string, Subject<{ botId?: string }>>();
    const bus = {
      leerTexto: jest.fn(leerTexto),
      listen: jest.fn(async (canal: string) => {
        const s = new Subject<{ botId?: string }>();
        escuchas.set(canal, s);
        return s.asObservable();
      }),
    };
    const nulo = {} as never;
    const engine = new EngineService(
      db as never,
      store as never,
      nulo,
      nulo,
      nulo,
      bus as never,
      nulo,
      nulo,
      nulo,
      nulo,
      nulo,
    );
    return { engine: engine as unknown as Privado, db, bus, escuchas, store };
  };

  const runner = (botId: string, venue: string, dryRun = false, strategy = 'AI_CHANNEL') => ({
    botId,
    perfil: { strategy, venue, dryRun },
  });

  it('solo un administrador habilitado, con el rol leído de la base', async () => {
    const admin = montar({ role: 'ADMIN', disabled: false });
    await expect(admin.engine.comprobarDuenoAdmin('u1', 'AI_CHANNEL')).resolves.toBeUndefined();
    expect(admin.db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { role: true, disabled: true },
    });

    for (const dueno of [
      { role: 'USER', disabled: false },
      { role: 'ADMIN', disabled: true },
      null,
    ]) {
      await expect(montar(dueno).engine.comprobarDuenoAdmin('u1', 'AI_CHANNEL')).rejects.toThrow(
        /administrador/,
      );
    }
  });

  it('el tope por venue cuenta los reales vivos y los que están arrancando', () => {
    const { engine } = montar(null);
    engine.topesCanal = new Map([['LIGHTER', 2]]);
    engine.runners.set('a', runner('a', 'LIGHTER'));
    // Ni los simulados, ni otros venues, ni otras estrategias cuentan.
    engine.runners.set('b', runner('b', 'LIGHTER', true));
    engine.runners.set('c', runner('c', 'ASTER'));
    engine.runners.set('d', runner('d', 'LIGHTER', false, 'GRID_CLASSIC'));

    engine.reservarCanal('e', 'LIGHTER', 'AI_CHANNEL');
    expect(() => engine.reservarCanal('f', 'LIGHTER', 'AI_CHANNEL')).toThrow(
      /AI_CHANNEL_MAX_BOTS_PER_VENUE/,
    );
    // Un venue sin tope no tiene límite.
    engine.reservarCanal('g', 'HYPERLIQUID', 'AI_CHANNEL');
    engine.reservarCanal('h', 'HYPERLIQUID', 'AI_CHANNEL');
  });

  it('un bot que ya tiene runner no cuenta dos veces', () => {
    const { engine } = montar(null);
    engine.topesCanal = new Map([['LIGHTER', 2]]);
    engine.runners.set('a', runner('a', 'LIGHTER'));
    // `a` sigue reservado mientras termina de arrancar.
    engine.arrancandoCanal.set('a', 'LIGHTER');

    expect(() => engine.reservarCanal('b', 'LIGHTER', 'AI_CHANNEL')).not.toThrow();
  });

  it('el interruptor se lee de Redis, y con Redis colgado no se espera más de un segundo', async () => {
    const apagado = montar(null, async () => 'off');
    await expect(apagado.engine.leerInterruptorCanal()).resolves.toMatchObject({
      permitidas: false,
    });

    const colgado = montar(null, () => new Promise(() => undefined));
    const empezado = Date.now();
    await expect(colgado.engine.leerInterruptorCanal()).rejects.toThrow(/Redis no contesta/);
    expect(Date.now() - empezado).toBeLessThan(3_000);
  });

  describe('al adoptar un bot', () => {
    const admin = { role: 'ADMIN', disabled: false };

    it('un canal cuyo dueño no es administrador no llega ni a la red', async () => {
      const { engine, db } = montar({ role: 'USER', disabled: false });
      await expect(engine.spawn('nuevo')).rejects.toThrow(/administrador/);
      expect(db.exchangeAccount.findUniqueOrThrow).not.toHaveBeenCalled();

      // Con el dueño administrador sigue adelante.
      await expect(montar(admin).engine.spawn('nuevo')).rejects.toThrow(/siguió adelante/);
    });

    it('las demás estrategias no miran el rol', async () => {
      const { engine, db } = montar({ role: 'USER', disabled: false }, undefined, {
        strategy: 'GRID_CLASSIC',
      });
      await expect(engine.spawn('nuevo')).rejects.toThrow(/siguió adelante/);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('el tope por venue se aplica al adoptar; un simulado no lo gasta', async () => {
      const real = montar(admin);
      real.engine.topesCanal = new Map([['LIGHTER', 1]]);
      real.engine.runners.set('a', runner('a', 'LIGHTER'));
      await expect(real.engine.spawn('nuevo')).rejects.toThrow(/AI_CHANNEL_MAX_BOTS_PER_VENUE/);
      expect(real.db.exchangeAccount.findUniqueOrThrow).not.toHaveBeenCalled();

      const simulado = montar(admin, undefined, { dry_run: true });
      simulado.engine.topesCanal = new Map([['LIGHTER', 1]]);
      simulado.engine.runners.set('a', runner('a', 'LIGHTER'));
      await expect(simulado.engine.spawn('nuevo')).rejects.toThrow(/siguió adelante/);
    });

    it('la reserva se suelta aunque el arranque falle después', async () => {
      const { engine, db } = montar(admin);
      engine.topesCanal = new Map([['LIGHTER', 1]]);
      await expect(engine.spawn('nuevo')).rejects.toThrow(/siguió adelante/);
      expect(engine.arrancandoCanal.size).toBe(0);

      // Otro bot cabe en el hueco que dejó el que no llegó a arrancar.
      db.bot.findUniqueOrThrow.mockResolvedValueOnce({ ...BOT_CANAL, id: 'otro' });
      await expect(engine.spawn('otro')).rejects.toThrow(/siguió adelante/);
    });
  });

  it('un aviso de intención despierta al bot que la tiene, y a ningún otro', async () => {
    const { engine, escuchas } = montar(null);
    const pedirTick = jest.fn();
    engine.runners.set('a', { ...runner('a', 'LIGHTER'), pedirTick });
    await engine.subscribeToBus();
    const intenciones = escuchas.get(BUS_CHANNELS.BOT_AI_INTENTS)!;

    intenciones.next({ botId: 'b' });
    intenciones.next({});
    expect(pedirTick).not.toHaveBeenCalled();

    intenciones.next({ botId: 'a' });
    expect(pedirTick).toHaveBeenCalledTimes(1);
  });

  describe('el nocional que declara la estrategia', () => {
    const canal = {
      ...getStrategy('AI_CHANNEL').defaults(),
      marginMode: 'ISOLATED',
      leverage: 25,
      totalInvestment: '1000',
    };

    it('se guarda el del canal y nulo en las demás; un fallo de la base solo se avisa', async () => {
      const { engine, store } = montar(null);
      await engine.anotarNocional('b1', 'AI_CHANNEL', canal);
      // 1.000 × 5 de múltiplo por defecto, por debajo de 1.000 × 25.
      expect(store.setMaxNotional).toHaveBeenCalledWith('b1', '5000');

      await engine.anotarNocional('b2', 'GRID_CLASSIC', getStrategy('GRID_CLASSIC').defaults());
      expect(store.setMaxNotional).toHaveBeenCalledWith('b2', null);

      store.setMaxNotional.mockRejectedValueOnce(new Error('base caída'));
      await expect(engine.anotarNocional('b1', 'AI_CHANNEL', canal)).resolves.toBeUndefined();
    });

    it('al recargar la configuración se recalcula con la nueva', async () => {
      const { engine, db, store } = montar(null, undefined, { config_version: 3 });
      const nueva = { ...canal, maxNotionalMultiple: 2 };
      db.botConfigRevision.findUniqueOrThrow.mockResolvedValue({ config: nueva });
      const run = { reloadConfig: jest.fn().mockResolvedValue(undefined) };

      await engine.reloadConfig('nuevo', run, { level: 'HOT' });

      expect(run.reloadConfig).toHaveBeenCalledWith(nueva, 'HOT');
      expect(store.setMaxNotional).toHaveBeenCalledWith('nuevo', '2000');
    });
  });
});
