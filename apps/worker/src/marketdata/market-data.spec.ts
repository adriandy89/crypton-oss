import { Observable, Subject } from 'rxjs';
import type { Ticker, Venue } from '@crypton/shared';
import { MarketDataService } from './market-data.service';
import { MarketWatchService } from './watch.service';

/**
 * El feed compartido de precios.
 *
 * Existe este fichero porque la fase 2 abre este servicio a los USUARIOS —hasta
 * ahora solo lo usaban los bots— y eso convierte dos defectos latentes en dos
 * defectos visibles: abrir una pantalla no enseñaría precio hasta el siguiente
 * tick, y abrir y cerrar pantallas multiplicaría las suscripciones al venue.
 * Los dos primeros bloques son exactamente esos dos casos.
 */

/** Un adaptador público de mentira: cuenta suscripciones y bajas. */
function fakeAdapter() {
  const streams = new Map<string, Subject<Ticker>>();
  const counters = { subscribes: 0, unsubscribes: 0 };

  return {
    counters,
    /** Empuja un precio como haría el WebSocket del venue. */
    push(symbol: string, px: string, ts = Date.now()): void {
      streams.get(symbol)?.next({ symbol, last: px, ts } as Ticker);
    },
    /** Suscripciones VIVAS ahora mismo. */
    live: () => counters.subscribes - counters.unsubscribes,
    adapter: {
      streamTicker(symbol: string): Observable<Ticker> {
        return new Observable<Ticker>((observer) => {
          counters.subscribes++;
          const subject = streams.get(symbol) ?? new Subject<Ticker>();
          streams.set(symbol, subject);
          const inner = subject.subscribe(observer);
          return () => {
            counters.unsubscribes++;
            inner.unsubscribe();
          };
        });
      },
      getTicker: (symbol: string) =>
        Promise.resolve({ symbol, last: '1', ts: Date.now() } as Ticker),
      close: () => Promise.resolve(),
    },
  };
}

function build() {
  const fake = fakeAdapter();
  const published: { channel: string; symbol: string }[] = [];
  const bus = {
    cacheSet: jest.fn().mockResolvedValue(undefined),
    publishPublic: jest.fn((channel: string, m: { data: { symbol: string } }) => {
      published.push({ channel, symbol: m.data.symbol });
      return Promise.resolve();
    }),
  };
  const service = new MarketDataService(
    bus as never,
    { budget: undefined } as never,
    { get: (_k: string, d?: unknown) => d } as never,
  );
  // Se inyecta el adaptador falso: construir el real cargaría el SDK de
  // Hyperliquid, que es solo ESM y no se puede `require` desde Jest.
  (service as unknown as { adapters: Map<Venue, unknown> }).adapters.set(
    'HYPERLIQUID' as Venue,
    fake.adapter,
  );
  return { service, fake, bus, published };
}

const HL = 'HYPERLIQUID' as Venue;

describe('subscribe() — reemitir el ultimo precio', () => {
  it('quien llega tarde recibe el ultimo precio SIN esperar al siguiente tick', async () => {
    const { service, fake } = build();

    // Una pantalla ya abierta, con precio recibido.
    const primero: Ticker[] = [];
    service.subscribe(HL, 'BTC').subscribe((t) => primero.push(t));
    fake.push('BTC', '50000');
    expect(primero).toHaveLength(1);

    // Ahora se abre OTRA pantalla del mismo par. Con un `Subject` pelado esto
    // salia vacio y el grafico se quedaba en blanco hasta el siguiente tick —
    // que en un par poco liquido puede tardar minutos.
    const segundo: Ticker[] = [];
    service.subscribe(HL, 'BTC').subscribe((t) => segundo.push(t));
    expect(segundo).toHaveLength(1);
    expect(segundo[0]!.last).toBe('50000');

    await service.onModuleDestroy();
  });

  it('no reemite un precio VIEJO: mas alla del umbral, mejor nada que mentir', async () => {
    const { service, fake } = build();
    service.subscribe(HL, 'BTC').subscribe();
    fake.push('BTC', '50000', Date.now() - 60_000);

    const tarde: Ticker[] = [];
    service.subscribe(HL, 'BTC').subscribe((t) => tarde.push(t));
    expect(tarde).toHaveLength(0);

    await service.onModuleDestroy();
  });
});

describe('release() — cerrar de verdad la suscripcion al venue', () => {
  it('al llegar a cero se da de baja en el venue', async () => {
    const { service, fake } = build();
    service.subscribe(HL, 'BTC').subscribe();
    expect(fake.live()).toBe(1);

    service.release(HL, 'BTC');
    expect(fake.live()).toBe(0);

    await service.onModuleDestroy();
  });

  it('abrir y cerrar veinte veces deja UNA suscripcion viva, no veinte', async () => {
    const { service, fake } = build();
    for (let i = 0; i < 20; i++) {
      service.subscribe(HL, 'BTC').subscribe();
      service.release(HL, 'BTC');
    }
    // Este es el fallo que importa: el retorno de `.subscribe()` se descartaba,
    // asi que al llegar a cero se borraba el feed pero el WebSocket seguia
    // vivo, y el siguiente `subscribe()` abria OTRO. Veinte aperturas eran
    // veinte suscripciones al mismo simbolo contra el limite del venue.
    expect(fake.live()).toBe(0);
    expect(fake.counters.subscribes).toBe(20);
    expect(fake.counters.unsubscribes).toBe(20);

    await service.onModuleDestroy();
  });

  it('con DOS interesados, que se vaya uno no deja al otro sin precios', async () => {
    const { service, fake } = build();
    const recibidos: Ticker[] = [];
    service.subscribe(HL, 'BTC').subscribe();
    service.subscribe(HL, 'BTC').subscribe((t) => recibidos.push(t));

    service.release(HL, 'BTC');
    expect(fake.live()).toBe(1);

    fake.push('BTC', '51000');
    expect(recibidos.map((t) => t.last)).toEqual(['51000']);

    await service.onModuleDestroy();
  });

  it('cerrar el modulo se da de baja en el venue', async () => {
    const { service, fake } = build();
    service.subscribe(HL, 'BTC').subscribe();
    service.subscribe(HL, 'ETH').subscribe();
    expect(fake.live()).toBe(2);

    await service.onModuleDestroy();
    expect(fake.live()).toBe(0);
  });
});

describe('publish() — el puente al canal publico', () => {
  it('cada precio sale tambien al bus, para que la API lo reparta', async () => {
    const { service, fake, bus } = build();
    service.subscribe(HL, 'BTC').subscribe();
    fake.push('BTC', '50000');
    expect(bus.publishPublic).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('con freno: un par liquido late varias veces por segundo y no se reenvia cada latido', async () => {
    const { service, fake, bus } = build();
    service.subscribe(HL, 'BTC').subscribe();
    for (let i = 0; i < 50; i++) fake.push('BTC', String(50_000 + i));
    expect(bus.publishPublic.mock.calls.length).toBeLessThanOrEqual(2);

    await service.onModuleDestroy();
  });

  it('el mensaje publico NO lleva destinatario: un precio no es de nadie', async () => {
    const { service, fake, bus } = build();
    service.subscribe(HL, 'BTC').subscribe();
    fake.push('BTC', '50000');
    const [, message] = bus.publishPublic.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).not.toHaveProperty('userId');

    await service.onModuleDestroy();
  });
});

describe('MarketWatchService — reconciliacion del interes', () => {
  /** El bus falso: guarda al suscriptor para poder empujarle mensajes. */
  function harness() {
    const { service: marketData, fake } = build();
    let emit: (m: { data?: { symbols?: unknown }; origin?: string }) => void = () => undefined;
    const bus = {
      listenPublic: jest.fn().mockResolvedValue({
        subscribe: (fn: typeof emit) => {
          emit = fn;
          return { unsubscribe: () => undefined };
        },
      }),
    };
    const watch = new MarketWatchService(bus as never, marketData);
    return { watch, marketData, fake, start: () => watch.onModuleInit(), emit: (m: Parameters<typeof emit>[0]) => emit(m) };
  }

  const watched = (symbols: string[], origin = 'api-1') => ({ data: { symbols }, origin });

  it('abre lo que falta y suelta lo que sobra', async () => {
    const h = harness();
    await h.start();

    h.emit(watched(['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH']));
    expect(h.fake.live()).toBe(2);

    h.emit(watched(['HYPERLIQUID:ETH']));
    expect(h.fake.live()).toBe(1);

    h.emit(watched([]));
    expect(h.fake.live()).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('repetir el mismo conjunto NO reabre nada: es un latido, no un cambio', async () => {
    const h = harness();
    await h.start();
    for (let i = 0; i < 10; i++) h.emit(watched(['HYPERLIQUID:BTC']));
    // Sin esto, cada latido de la API cerraria y reabriria el WebSocket del
    // venue cinco veces por minuto y por simbolo.
    expect(h.fake.counters.subscribes).toBe(1);
    expect(h.fake.counters.unsubscribes).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('DOS replicas de la API no se pisan: se mantiene la union', async () => {
    const h = harness();
    await h.start();

    h.emit(watched(['HYPERLIQUID:BTC'], 'api-1'));
    h.emit(watched(['HYPERLIQUID:ETH'], 'api-2'));
    expect(h.fake.live()).toBe(2);

    // Este es el fallo que se evita: con un solo conjunto, el mensaje de api-2
    // habria soltado BTC, el siguiente de api-1 habria soltado ETH, y los
    // WebSockets se abririan y cerrarian varias veces por segundo para siempre.
    h.emit(watched(['HYPERLIQUID:BTC'], 'api-1'));
    h.emit(watched(['HYPERLIQUID:ETH'], 'api-2'));
    expect(h.fake.live()).toBe(2);
    expect(h.fake.counters.subscribes).toBe(2);
    h.watch.onModuleDestroy();
  });

  it('dos replicas mirando el MISMO par comparten UNA suscripcion', async () => {
    const h = harness();
    await h.start();
    h.emit(watched(['HYPERLIQUID:BTC'], 'api-1'));
    h.emit(watched(['HYPERLIQUID:BTC'], 'api-2'));
    expect(h.fake.counters.subscribes).toBe(1);

    // Y hace falta que las DOS lo suelten para que se cierre.
    h.emit(watched([], 'api-1'));
    expect(h.fake.live()).toBe(1);
    h.emit(watched([], 'api-2'));
    expect(h.fake.live()).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('cerrar el modulo suelta el interes de TODAS las replicas', async () => {
    const h = harness();
    await h.start();
    h.emit(watched(['HYPERLIQUID:BTC'], 'api-1'));
    h.emit(watched(['HYPERLIQUID:ETH'], 'api-2'));
    h.watch.onModuleDestroy();
    expect(h.fake.live()).toBe(0);
  });

  it('un mensaje mal formado no tumba el feed ni suelta nada', async () => {
    const h = harness();
    await h.start();
    h.emit(watched(['HYPERLIQUID:BTC']));
    h.emit({ data: { symbols: 'no-es-una-lista' }, origin: 'api-1' });
    h.emit({ data: {}, origin: 'api-1' });
    h.emit({ origin: 'api-1' });
    expect(h.fake.live()).toBe(1);
    h.watch.onModuleDestroy();
  });

  it('un par con forma imposible se ignora sin dejar reserva colgada', async () => {
    const h = harness();
    await h.start();
    h.emit(watched(['sin-dos-puntos', ':sin-venue', 'HYPERLIQUID:']));
    expect(h.fake.live()).toBe(0);
    h.watch.onModuleDestroy();
  });
});

describe('Velas en vivo — el feed que sustituye al sondeo del grafico', () => {
  /** El adaptador falso gana un stream de velas por par Y resolucion. */
  function conVelas() {
    const base = build();
    const streams = new Map<string, Subject<unknown>>();
    const counters = { subscribes: 0, unsubscribes: 0 };
    const adapter = {
      ...(base.fake.adapter as Record<string, unknown>),
      streamCandles(symbol: string, interval: string) {
        return new Observable((observer) => {
          counters.subscribes++;
          const key = symbol + '|' + interval;
          const subject = streams.get(key) ?? new Subject<unknown>();
          streams.set(key, subject);
          const inner = subject.subscribe(observer as never);
          return () => {
            counters.unsubscribes++;
            inner.unsubscribe();
          };
        });
      },
    };
    (base.service as unknown as { adapters: Map<Venue, unknown> }).adapters.set(HL, adapter);
    return {
      ...base,
      counters,
      live: () => counters.subscribes - counters.unsubscribes,
      push: (symbol: string, interval: string, candle: unknown) =>
        streams.get(symbol + '|' + interval)?.next(candle),
    };
  }

  it('una serie abierta es UNA suscripcion, la miren uno o mil', async () => {
    const h = conVelas();
    expect(h.service.subscribeCandles(HL, 'BTC', '1h')).toBe(true);
    expect(h.service.subscribeCandles(HL, 'BTC', '1h')).toBe(true);
    expect(h.counters.subscribes).toBe(1);

    h.service.releaseCandles(HL, 'BTC', '1h');
    expect(h.live()).toBe(1);
    h.service.releaseCandles(HL, 'BTC', '1h');
    expect(h.live()).toBe(0);
    await h.service.onModuleDestroy();
  });

  it('el mismo par en DOS resoluciones son dos suscripciones', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');
    h.service.subscribeCandles(HL, 'BTC', '1m');
    expect(h.counters.subscribes).toBe(2);
    await h.service.onModuleDestroy();
  });

  it('cada vela sale al bus por su canal, y sin destinatario', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');
    h.push('BTC', '1h', { t: 1_000, o: '1', h: '2', l: '1', c: '2', v: '10' });

    expect(h.bus.publishPublic).toHaveBeenCalledTimes(1);
    const [canal, mensaje] = h.bus.publishPublic.mock.calls[0] as [
      string,
      { type: string; data: Record<string, unknown> },
    ];
    expect(canal).toContain('market-candles');
    expect(mensaje.type).toBe('CANDLE');
    expect(mensaje.data['interval']).toBe('1h');
    // Una vela no es de nadie: es el mismo dato para todos los usuarios.
    expect(mensaje).not.toHaveProperty('userId');
    await h.service.onModuleDestroy();
  });

  it('con freno, pero la vela que CIERRA pasa siempre', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');
    // Cincuenta reemisiones de la MISMA vela: el freno se las come.
    for (let i = 0; i < 50; i++) {
      h.push('BTC', '1h', { t: 1_000, o: '1', h: '2', l: '1', c: String(i), v: '10' });
    }
    const conFreno = h.bus.publishPublic.mock.calls.length;
    expect(conFreno).toBeLessThanOrEqual(2);

    // El relevo saca DOS mensajes y ninguno pasa por el freno: el estado final
    // de la barra que se cierra —que fija su maximo, minimo, cierre y volumen
    // definitivos— y la barra nueva.
    h.push('BTC', '1h', { t: 2_000, o: '2', h: '3', l: '2', c: '3', v: '20' });
    expect(h.bus.publishPublic.mock.calls.length).toBe(conFreno + 2);
    await h.service.onModuleDestroy();
  });

  it('un venue SIN stream de velas lo dice, en vez de callarse', async () => {
    // Ya no hay ninguno asi —Lighter tambien tiene su canal `candle/...`—, pero
    // el MECANISMO tiene que seguir funcionando: devolver `false` es lo que
    // permite a la pantalla componer la vela desde el precio en vez de esperar
    // algo que no va a llegar. Se prueba con un adaptador de mentira.
    const { service, fake } = build();
    (service as unknown as { adapters: Map<Venue, unknown> }).adapters.set('LIGHTER' as Venue, {
      ...(fake.adapter as Record<string, unknown>),
      streamCandles: undefined,
    });
    expect(service.subscribeCandles('LIGHTER' as Venue, 'BTC', '1h')).toBe(false);
    await service.onModuleDestroy();
  });

  it('cerrar el modulo suelta tambien las velas', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');
    h.service.subscribeCandles(HL, 'ETH', '1h');
    expect(h.live()).toBe(2);
    await h.service.onModuleDestroy();
    expect(h.live()).toBe(0);
  });
});

describe('MarketWatchService — el interes de velas', () => {
  function harness() {
    const { service: marketData } = build();
    const abiertas = new Set<string>();
    jest.spyOn(marketData, 'subscribeCandles').mockImplementation((v, s, i) => {
      abiertas.add(`${v}:${s}:${i}`);
      return true;
    });
    jest.spyOn(marketData, 'releaseCandles').mockImplementation((v, s, i) => {
      abiertas.delete(`${v}:${s}:${i}`);
    });
    jest.spyOn(marketData, 'subscribe').mockReturnValue(new Subject<never>().asObservable());
    jest.spyOn(marketData, 'release').mockImplementation(() => undefined);

    let emit: (m: unknown) => void = () => undefined;
    const bus = {
      listenPublic: jest.fn().mockResolvedValue({
        subscribe: (fn: typeof emit) => {
          emit = fn;
          return { unsubscribe: () => undefined };
        },
      }),
    };
    const watch = new MarketWatchService(bus as never, marketData);
    return {
      watch,
      abiertas,
      start: () => watch.onModuleInit(),
      emit: (symbols: string[], candles: string[] | undefined, origin = 'api-1') =>
        emit({ data: { symbols, ...(candles ? { candles } : {}) }, origin }),
    };
  }

  it('abre y suelta series segun lo que se declare', async () => {
    const h = harness();
    await h.start();

    h.emit([], ['HYPERLIQUID:BTC:1h']);
    expect([...h.abiertas]).toEqual(['HYPERLIQUID:BTC:1h']);

    // Cambiar de intervalo: se abre la nueva y se suelta la vieja.
    h.emit([], ['HYPERLIQUID:BTC:1m']);
    expect([...h.abiertas]).toEqual(['HYPERLIQUID:BTC:1m']);

    h.emit([], []);
    expect(h.abiertas.size).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('los precios y las velas NO se pisan entre si', async () => {
    const h = harness();
    await h.start();
    h.emit(['HYPERLIQUID:BTC'], ['HYPERLIQUID:BTC:1h']);
    expect(h.abiertas.size).toBe(1);

    // Anadir un precio no puede soltar la serie de velas de la misma replica:
    // son dos dimensiones del mismo conjunto, no una lista mezclada.
    h.emit(['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH'], ['HYPERLIQUID:BTC:1h']);
    expect([...h.abiertas]).toEqual(['HYPERLIQUID:BTC:1h']);
    h.watch.onModuleDestroy();
  });

  it('un mensaje SIN el campo candles suelta las velas de esa replica', async () => {
    const h = harness();
    await h.start();
    h.emit([], ['HYPERLIQUID:BTC:1h']);
    h.emit(['HYPERLIQUID:BTC'], undefined);
    // Sin campo se trata como conjunto vacio: es la unica lectura segura de un
    // mensaje del que no se puede saber si la otra parte lo omitio o lo vacio.
    expect(h.abiertas.size).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('un intervalo inventado se ignora: no llega al venue', async () => {
    const h = harness();
    await h.start();
    h.emit([], ['HYPERLIQUID:BTC:99x', 'HYPERLIQUID:BTC', 'sin-nada']);
    expect(h.abiertas.size).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('DOS replicas con series distintas mantienen la union', async () => {
    const h = harness();
    await h.start();
    h.emit([], ['HYPERLIQUID:BTC:1h'], 'api-1');
    h.emit([], ['HYPERLIQUID:ETH:1h'], 'api-2');
    expect(h.abiertas.size).toBe(2);

    // El latido de una no puede soltar lo de la otra.
    h.emit([], ['HYPERLIQUID:BTC:1h'], 'api-1');
    expect(h.abiertas.size).toBe(2);
    h.watch.onModuleDestroy();
  });
});

describe('publishCandle — la barra que se cierra', () => {
  function conVelas() {
    const base = build();
    const streams = new Map<string, Subject<unknown>>();
    const adapter = {
      ...(base.fake.adapter as Record<string, unknown>),
      streamCandles(symbol: string, interval: string) {
        return new Observable((observer) => {
          const key = symbol + '|' + interval;
          const subject = streams.get(key) ?? new Subject<unknown>();
          streams.set(key, subject);
          const inner = subject.subscribe(observer as never);
          return () => inner.unsubscribe();
        });
      },
    };
    (base.service as unknown as { adapters: Map<Venue, unknown> }).adapters.set(HL, adapter);
    return {
      ...base,
      push: (candle: unknown) => streams.get('BTC|1h')?.next(candle as never),
      publicadas: () =>
        base.bus.publishPublic.mock.calls.map(
          (c) => (c as [string, { data: { candle: { t: number; c: string } } }])[1].data.candle,
        ),
    };
  }

  const vela = (t: number, c: string, v = '1') => ({ t, o: '1', h: c, l: '1', c, v });

  it('sale con su ULTIMO estado, aunque el freno se comiera sus ultimas actualizaciones', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');

    // Una vela que se actualiza muchas veces dentro de la misma ventana del
    // freno: solo la primera llega a publicarse.
    h.push(vela(1_000, '10'));
    for (let i = 11; i <= 60; i++) h.push(vela(1_000, String(i)));

    // Y ahora se abre la siguiente. La anterior queda CERRADA con c=60, y ese
    // es su valor definitivo: maximo, minimo, cierre y volumen de esa barra.
    h.push(vela(2_000, '61'));

    const cierres = h.publicadas().filter((c) => c.t === 1_000);
    // Sin esto, el cliente se queda con c=10 para siempre en una barra que de
    // verdad cerro en 60, sin ningun error y sin forma de notarlo.
    expect(cierres[cierres.length - 1]!.c).toBe('60');
    await h.service.onModuleDestroy();
  });

  it('la vela nueva tambien sale en el acto, sin esperar al freno', async () => {
    const h = conVelas();
    h.service.subscribeCandles(HL, 'BTC', '1h');
    h.push(vela(1_000, '10'));
    h.push(vela(2_000, '11'));
    expect(h.publicadas().some((c) => c.t === 2_000)).toBe(true);
    await h.service.onModuleDestroy();
  });
});

describe('MarketWatchService — las dos redes son interes independiente', () => {
  /**
   * El adaptador falso se inyecta por venue Y RED, igual que hace el servicio,
   * para poder contar por separado lo que se abre en cada una.
   */
  function harness() {
    const { service: marketData, fake } = build();
    const fakeTest = fakeAdapter();
    (
      marketData as unknown as { adapters: Map<string, unknown> }
    ).adapters.set('HYPERLIQUID:t', fakeTest.adapter);

    let emit: (m: { data?: Record<string, unknown>; origin?: string }) => void = () => undefined;
    const bus = {
      listenPublic: jest.fn().mockResolvedValue({
        subscribe: (fn: typeof emit) => {
          emit = fn;
          return { unsubscribe: () => undefined };
        },
      }),
    };
    const watch = new MarketWatchService(bus as never, marketData);
    return {
      watch,
      fake,
      fakeTest,
      start: () => watch.onModuleInit(),
      emit: (m: Parameters<typeof emit>[0]) => emit(m),
    };
  }

  it('el mismo par en las dos redes son DOS suscripciones', async () => {
    const h = harness();
    await h.start();

    h.emit({
      data: { symbols: ['HYPERLIQUID:BTC'], symbolsTest: ['HYPERLIQUID:BTC'] },
      origin: 'api-1',
    });
    expect(h.fake.live()).toBe(1);
    expect(h.fakeTest.live()).toBe(1);
    h.watch.onModuleDestroy();
  });

  /**
   * Es el fallo que se evita llevando cada red como un origen aparte: con un
   * solo conjunto por replica, declarar en una red soltaba lo de la otra en el
   * mismo mensaje, y el par que se estaba mirando se quedaba sin precio.
   */
  it('declarar en una red NO suelta lo de la otra', async () => {
    const h = harness();
    await h.start();

    h.emit({ data: { symbols: ['HYPERLIQUID:BTC'] }, origin: 'api-1' });
    expect(h.fake.live()).toBe(1);

    h.emit({
      data: { symbols: ['HYPERLIQUID:BTC'], symbolsTest: ['HYPERLIQUID:ETH'] },
      origin: 'api-1',
    });
    expect(h.fake.live()).toBe(1);
    expect(h.fake.counters.subscribes).toBe(1);
    expect(h.fakeTest.live()).toBe(1);
    h.watch.onModuleDestroy();
  });

  it('una API sin actualizar no manda las listas de testnet y no pasa nada', async () => {
    const h = harness();
    await h.start();
    h.emit({ data: { symbols: ['HYPERLIQUID:BTC'] }, origin: 'api-vieja' });
    expect(h.fake.live()).toBe(1);
    expect(h.fakeTest.live()).toBe(0);
    h.watch.onModuleDestroy();
  });

  it('al apagar se suelta lo de las dos redes', async () => {
    const h = harness();
    await h.start();
    h.emit({
      data: { symbols: ['HYPERLIQUID:BTC'], symbolsTest: ['HYPERLIQUID:ETH'] },
      origin: 'api-1',
    });
    h.watch.onModuleDestroy();
    expect(h.fake.live()).toBe(0);
    expect(h.fakeTest.live()).toBe(0);
  });
});

describe('MarketWatchService — lo que llega por Redis no puede tumbar el motor', () => {
  /** Aqui NO se simula `subscribe`: se deja llegar al adaptador de verdad. */
  function crudo() {
    const { service: marketData } = build();
    let emit: (m: unknown) => void = () => undefined;
    const bus = {
      listenPublic: jest.fn().mockResolvedValue({
        subscribe: (fn: typeof emit) => {
          emit = fn;
          return { unsubscribe: () => undefined };
        },
      }),
    };
    const watch = new MarketWatchService(bus as never, marketData);
    const avisos: string[] = [];
    jest
      .spyOn((watch as unknown as { logger: { warn(m: string): void } }).logger, 'warn')
      .mockImplementation((m: string) => void avisos.push(m));
    return {
      watch,
      marketData,
      avisos,
      start: () => watch.onModuleInit(),
      emit: (data: unknown) => emit({ data, origin: 'api-1' }),
    };
  }

  it('un venue inventado NO llega a construir un adaptador', async () => {
    const h = crudo();
    await h.start();
    // Sin la comprobacion, esto llegaba a `createPublicAdapter('INVENTADO')`,
    // que busca unas credenciales vacias por clave y revienta con un TypeError.
    // Dentro del `next` de un Observable eso es una excepcion no capturada: el
    // proceso que opera los bots de todo el mundo, abajo.
    expect(() =>
      h.emit({ symbols: ['INVENTADO:BTC'], candles: ['INVENTADO:BTC:1h'] }),
    ).not.toThrow();
    const adaptadores = (h.marketData as unknown as { adapters: Map<string, unknown> }).adapters;
    expect(adaptadores.has('INVENTADO')).toBe(false);
    // Y NI SIQUIERA se intento: sin la comprobacion del venue, el `try` de
    // arriba atraparia el TypeError y dejaria un aviso. Que no lo haya
    // distingue «no llego a pasar» de «paso y se tapo».
    expect(h.avisos).toHaveLength(0);
    h.watch.onModuleDestroy();
  });

  it('un mensaje con cualquier forma rara se registra y se sigue', async () => {
    const h = crudo();
    await h.start();
    for (const data of [null, undefined, {}, { symbols: 'no' }, { symbols: [1, 2] }]) {
      expect(() => h.emit(data)).not.toThrow();
    }
    h.watch.onModuleDestroy();
  });
});
