import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { PURGE_SCOPES, type PurgeScope } from './dtos';

/**
 * La purga manual de históricos (spec 034).
 *
 * Lo que se prueba aquí no es que borre: es que NO borra lo que no debe. Un
 * borrado no tiene deshacer, y las tres salvaguardas —bots vivos fuera, suelo
 * por ámbito, y lo grave intocable— viven todas en el `WHERE`, que es
 * exactamente el sitio donde un descuido no da la cara hasta que ya pasó.
 */

/** Reconstruye el SQL de la subconsulta que el servicio compone. */
function sqlDeLaLlamada(mock: jest.Mock, indice = 0): string {
  const args = mock.mock.calls[indice] as unknown[];
  // El que lleva el SELECT, y no el primer `Prisma.Sql` que aparezca: el DELETE
  // interpola ADEMAS el nombre de la tabla como `Prisma.raw`, que tiene la misma
  // forma y viene antes.
  const anidado = args.find(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      'strings' in a &&
      (a as { strings: string[] }).strings.join(' ').includes('SELECT'),
  ) as { strings: string[]; values: unknown[] };
  return anidado.strings.join(' ? ').replace(/\s+/g, ' ');
}

function build(over: { lock?: boolean; borradas?: number } = {}) {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ n: 7n }]),
    $executeRaw: jest.fn().mockResolvedValue(over.borradas ?? 3),
  };
  const cache = {
    setnx: jest.fn().mockResolvedValue(over.lock ?? true),
    // Devuelve la marca que se acaba de escribir: el servicio solo suelta el
    // cerrojo si sigue siendo suyo.
    get: jest.fn().mockImplementation(() => cache.setnx.mock.calls[0]?.[1] ?? null),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: (_k: string, d?: unknown) => d };
  const service = new AdminMaintenanceService(db as never, cache as never, config as never);
  return { service, db, cache };
}

describe('los bots en marcha quedan fuera', () => {
  /** Los tres ámbitos que cuelgan de un bot. */
  const DE_BOT: PurgeScope[] = ['BOT_SNAPSHOTS', 'BOT_EVENTS', 'BOT_COMMANDS'];

  it.each(DE_BOT)('%s excluye las filas de bots vivos', async (scope) => {
    const { service, db } = build();

    await service.contar(scope, 30);

    const sql = sqlDeLaLlamada(db.$queryRaw);
    expect(sql).toContain('bot_id NOT IN');
    expect(sql).toContain("status IN ('STARTING','RUNNING','PAUSED','STOPPING')");
  });

  it('la curva de cartera excluye por USUARIO, no por bot', async () => {
    const { service, db } = build();

    await service.contar('PORTFOLIO_SNAPSHOTS', 30);

    // El ancla de esta tabla es el usuario: purgar la curva de quien está
    // operando le rompería el selector de un año de su pantalla de Cartera.
    const sql = sqlDeLaLlamada(db.$queryRaw);
    expect(sql).toContain('user_id NOT IN');
    expect(sql).toContain("status IN ('STARTING','RUNNING','PAUSED','STOPPING')");
  });

  /**
   * Los dos que NO la llevan, y el test existe para que la ausencia sea una
   * decisión escrita y no un olvido: un backtest corre sobre velas guardadas y no
   * toca ningún bot; la bitácora es transversal y filtrarla por bot no
   * significaría nada —lo que la protege es su suelo de 90 días—.
   */
  it.each(['BACKTESTS', 'ACTIVITY_LOG'] as PurgeScope[])(
    '%s no filtra por bot, a propósito',
    async (scope) => {
      const { service, db } = build();
      await service.contar(scope, 180);
      expect(sqlDeLaLlamada(db.$queryRaw)).not.toContain('bot_id NOT IN');
    },
  );
});

describe('los suelos los impone el servidor', () => {
  it('la bitácora no baja de 90 días', async () => {
    const { service, db } = build();

    await expect(service.contar('ACTIVITY_LOG', 30)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.purgar('ACTIVITY_LOG', 30)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('la bitácora sí acepta 90', async () => {
    const { service } = build();
    await expect(service.contar('ACTIVITY_LOG', 90)).resolves.toBe(7);
  });

  it.each(PURGE_SCOPES)('%s rechaza una antigüedad por debajo de su suelo', async (scope) => {
    const { service, db } = build();
    await expect(service.purgar(scope, 1)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('lo grave no se purga desde el panel', () => {
  it('de los eventos solo caen DEBUG, INFO y WARN', async () => {
    const { service, db } = build();

    await service.contar('BOT_EVENTS', 15);

    // Los ERROR y CRITICAL son justo los que se van a mirar cuando algo salga
    // mal, y el cron ya los conserva un año: un selector a quince días no puede
    // llevárselos por delante.
    expect(sqlDeLaLlamada(db.$queryRaw)).toContain("severity IN ('DEBUG','INFO','WARN')");
  });

  it('de la bitácora nunca cae un CRITICAL', async () => {
    const { service, db } = build();

    await service.contar('ACTIVITY_LOG', 180);

    expect(sqlDeLaLlamada(db.$queryRaw)).toContain("severity <> 'CRITICAL'");
  });

  it('los comandos sin ejecutar son trabajo pendiente, no historial', async () => {
    const { service, db } = build();

    await service.contar('BOT_COMMANDS', 30);

    expect(sqlDeLaLlamada(db.$queryRaw)).toContain('executed_at IS NOT NULL');
  });
});

describe('contar y purgar', () => {
  it('contar NO borra', async () => {
    const { service, db } = build();

    await expect(service.contar('BOT_SNAPSHOTS', 30)).resolves.toBe(7);

    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  /**
   * El recuento que se le enseña a quien va a pulsar el botón tiene que ser el
   * número de filas que van a desaparecer, no una estimación parecida. La única
   * forma de garantizarlo es que las dos consultas salgan del mismo sitio.
   */
  it('el filtro de contar y el de purgar son el MISMO', async () => {
    const { service, db } = build({ borradas: 0 });

    await service.contar('BOT_EVENTS', 30);
    await service.purgar('BOT_EVENTS', 30);

    const filtroContar = sqlDeLaLlamada(db.$queryRaw);
    const filtroPurgar = sqlDeLaLlamada(db.$executeRaw);
    // El del borrado añade el LIMIT del lote; lo demás, palabra por palabra.
    expect(filtroPurgar.replace(' LIMIT ? ', ' ')).toBe(filtroContar);
  });

  it('borra por lotes y devuelve cuántas cayeron', async () => {
    const { service, db } = build({ borradas: 0 });

    await expect(service.purgar('BOT_SNAPSHOTS', 30)).resolves.toEqual({
      borradas: 0,
      completo: true,
    });
    // Un lote que vuelve corto significa que ya no queda nada: no se insiste.
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('el cerrojo', () => {
  it('sin cerrojo no se borra nada, y se dice', async () => {
    const { service, db } = build({ lock: false });

    await expect(service.purgar('BOT_SNAPSHOTS', 30)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  /**
   * Y NO la del worker, que es el fallo que este test congela.
   *
   * `retention.service.ts` toma `crypton:lock:retention` cada hora con un TTL de
   * 55 minutos y no lo suelta: lo deja expirar. Compartir esa clave —que es lo
   * que hacía la primera versión— dejaba este endpoint respondiendo 503 durante
   * 55 de cada 60 minutos, y encima culpando a Redis.
   */
  it('usa su PROPIA clave, no la del cron del worker', async () => {
    const { service, cache } = build({ borradas: 0 });

    await service.purgar('BOT_SNAPSHOTS', 30);

    expect(cache.setnx.mock.calls[0][0]).toBe('crypton:lock:maintenance');
    expect(cache.setnx.mock.calls[0][0]).not.toBe('crypton:lock:retention');
  });

  it('no suelta un cerrojo que ya no es suyo', async () => {
    const { service, cache } = build({ borradas: 0 });
    // El TTL venció a mitad de purga y otro tomó el cerrojo.
    cache.get.mockResolvedValue('la-marca-de-otro');

    await service.purgar('BOT_SNAPSHOTS', 30);

    expect(cache.del).not.toHaveBeenCalled();
  });

  it('se suelta aunque el borrado reviente', async () => {
    const { service, db, cache } = build();
    db.$executeRaw.mockRejectedValue(new Error('la base dice que no'));

    await expect(service.purgar('BOT_SNAPSHOTS', 30)).rejects.toThrow('la base dice que no');

    // Sin esto, un fallo dejaría el cerrojo puesto dos minutos y el siguiente
    // intento se encontraría un 503 sin motivo aparente.
    expect(cache.del).toHaveBeenCalledWith('crypton:lock:maintenance');
  });
});
