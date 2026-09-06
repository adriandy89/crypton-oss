import type { Observable } from 'rxjs';
import type { Ticker } from '@crypton/shared';

/**
 * Cierre de suscripciones POR SÍMBOLO.
 *
 * Este fichero existe por un defecto de escalabilidad que no se ve mirando la
 * pantalla: los dos adaptadores abrían una conexión por símbolo y **solo la
 * cerraban al cerrar el adaptador entero**. Con bots era tolerable —un bot vive
 * meses sobre el mismo par—, pero en cuanto un usuario abre gráficos, el worker
 * acumula una conexión por cada par visitado y no la suelta jamás: hasta 546 en
 * Aster, y contra el límite que Hyperliquid cuenta por IP.
 *
 * Lo que se comprueba es siempre lo mismo, dicho de tres formas: que el primero
 * que se suscribe abre, que el último que se va CIERRA, y que irse y volver no
 * multiplica nada.
 */

// ═══════════════════════════════════════════════════════════════
// Dobles de las dos conexiones reales
// ═══════════════════════════════════════════════════════════════

/** Sockets de mentira, con la cuenta de los que siguen ABIERTOS. */
const wsLog = {
  abiertos: 0,
  creados: 0,
  urls: [] as string[],
  /** El ultimo socket creado, para poder empujarle mensajes y cerrarlo. */
  ultimo: null as FakeWebSocket | null,
};

class FakeWebSocket {
  private readonly listeners = new Map<string, ((arg: unknown) => void)[]>();
  constructor(url: string) {
    wsLog.creados++;
    wsLog.abiertos++;
    wsLog.urls.push(url);
    wsLog.ultimo = this;
  }
  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
  close(): void {
    wsLog.abiertos--;
    this.emit('close');
  }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: class {
    constructor(url: string) {
      return new FakeWebSocket(url);
    }
  },
  WebSocket: class {
    constructor(url: string) {
      return new FakeWebSocket(url);
    }
  },
}));

/** Suscripciones de mentira del SDK de Hyperliquid, con su cuenta de vivas. */
const hlLog = { vivas: 0, altas: 0 };

jest.mock(
  '@nktkas/hyperliquid',
  () => {
    const alta = () => {
      hlLog.altas++;
      hlLog.vivas++;
      let dada = false;
      return Promise.resolve({
        unsubscribe: () => {
          if (!dada) {
            dada = true;
            hlLog.vivas--;
          }
          return Promise.resolve();
        },
      });
    };
    return {
      __esModule: true,
      HttpTransport: class {},
      WebSocketTransport: class {
        close() {
          return Promise.resolve();
        }
      },
      InfoClient: class {},
      ExchangeClient: class {},
      SubscriptionClient: class {
        bbo = alta;
        activeAssetCtx = alta;
        candle = alta;
        orderUpdates = alta;
        userFills = alta;
      },
    };
  },
  { virtual: false },
);

// Las importaciones van DESPUÉS de los mocks a propósito: los adaptadores
// cargan su SDK de forma perezosa, pero `ws` se resuelve al importar.

const { AsterAdapter } = require('./adapters/aster') as typeof import('./adapters/aster');
const { HyperliquidAdapter } =
  require('./adapters/hyperliquid') as typeof import('./adapters/hyperliquid');

const asterAdapter = () =>
  new AsterAdapter({
    venue: 'ASTER',
    userAddress: '0x' + '1'.repeat(40),
    signerAddress: '0x' + '2'.repeat(40),
    signerPrivateKey: '0x' + '3'.repeat(64),
  });

const hlAdapter = () =>
  new HyperliquidAdapter({
    venue: 'HYPERLIQUID',
    accountAddress: '0x' + '1'.repeat(40),
    agentPrivateKey: '0x' + '3'.repeat(64),
  });

/** El alta de Hyperliquid resuelve una promesa: hay que dejarla correr. */
const asentar = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  wsLog.abiertos = 0;
  wsLog.creados = 0;
  wsLog.urls = [];
  wsLog.ultimo = null;
  hlLog.vivas = 0;
  hlLog.altas = 0;
});

// ═══════════════════════════════════════════════════════════════
// Aster: un WebSocket por símbolo
// ═══════════════════════════════════════════════════════════════

describe('Aster — el socket se cierra al irse el ultimo interesado', () => {
  it('el primero abre y el ultimo cierra', async () => {
    const a = asterAdapter();
    const sub = a.streamTicker('BTCUSDT').subscribe();
    await asentar();
    expect(wsLog.abiertos).toBe(1);

    sub.unsubscribe();
    expect(wsLog.abiertos).toBe(0);
    await a.close();
  });

  it('abrir y cerrar VEINTE graficos del mismo par deja cero sockets abiertos', async () => {
    const a = asterAdapter();
    for (let i = 0; i < 20; i++) {
      const sub = a.streamTicker('BTCUSDT').subscribe();
      await asentar();
      sub.unsubscribe();
    }
    // Antes esto dejaba veinte sockets vivos hasta reiniciar el proceso: el
    // `Subject` se cacheaba por simbolo y solo se cerraba en `close()`.
    expect(wsLog.abiertos).toBe(0);
    expect(wsLog.creados).toBe(20);
    await a.close();
  });

  it('veinte pares DISTINTOS visitados y cerrados dejan cero sockets', async () => {
    const a = asterAdapter();
    for (let i = 0; i < 20; i++) {
      const sub = a.streamTicker(`PAR${i}USDT`).subscribe();
      await asentar();
      sub.unsubscribe();
    }
    expect(wsLog.abiertos).toBe(0);
    await a.close();
  });

  it('con DOS interesados, que se vaya uno NO corta al otro', async () => {
    const a = asterAdapter();
    const recibidos: Ticker[] = [];
    const uno = a.streamTicker('BTCUSDT').subscribe();
    const dos = a.streamTicker('BTCUSDT').subscribe((t) => recibidos.push(t));
    await asentar();
    // Uno solo: es el sentido de compartir el flujo.
    expect(wsLog.creados).toBe(1);

    uno.unsubscribe();
    expect(wsLog.abiertos).toBe(1);

    dos.unsubscribe();
    expect(wsLog.abiertos).toBe(0);
    await a.close();
  });

  it('las velas tienen su propio socket por par Y resolucion', async () => {
    const a = asterAdapter();
    const unaHora = a.streamCandles('BTCUSDT', '1h').subscribe();
    const unMinuto = a.streamCandles('BTCUSDT', '1m').subscribe();
    await asentar();
    expect(wsLog.creados).toBe(2);
    expect(wsLog.urls.some((u) => u.includes('kline_1h'))).toBe(true);
    expect(wsLog.urls.some((u) => u.includes('kline_1m'))).toBe(true);

    // Cambiar de intervalo suelta el viejo: es la secuencia real de la pantalla.
    unaHora.unsubscribe();
    expect(wsLog.abiertos).toBe(1);
    unMinuto.unsubscribe();
    expect(wsLog.abiertos).toBe(0);
    await a.close();
  });

  it('cerrar el adaptador cierra lo que quede abierto', async () => {
    const a = asterAdapter();
    a.streamTicker('BTCUSDT').subscribe();
    a.streamTicker('ETHUSDT').subscribe();
    await asentar();
    expect(wsLog.abiertos).toBe(2);

    await a.close();
    expect(wsLog.abiertos).toBe(0);
  });

  it('cerrar el adaptador COMPLETA a quien siguiera suscrito', async () => {
    const a = asterAdapter();
    let completado = false;
    a.streamTicker('BTCUSDT').subscribe({ complete: () => (completado = true) });
    await asentar();

    await a.close();
    // Sin esto, el suscriptor se quedaria esperando para siempre datos de un
    // adaptador que ya no existe.
    expect(completado).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Hyperliquid: una suscripción por símbolo sobre el transporte compartido
// ═══════════════════════════════════════════════════════════════

describe('Hyperliquid — la suscripcion se suelta al irse el ultimo interesado', () => {
  it('el primero da de alta y el ultimo da de baja', async () => {
    const h = hlAdapter();
    const sub = h.streamTicker('BTC').subscribe();
    await asentar();
    // Dos altas por ticker: el bbo y el contexto que trae la marca (spec 014).
    expect(hlLog.vivas).toBe(2);

    sub.unsubscribe();
    await asentar();
    expect(hlLog.vivas).toBe(0);
    await h.close();
  });

  it('abrir y cerrar VEINTE graficos deja cero suscripciones vivas', async () => {
    const h = hlAdapter();
    for (let i = 0; i < 20; i++) {
      const sub = h.streamTicker('BTC').subscribe();
      await asentar();
      sub.unsubscribe();
      await asentar();
    }
    expect(hlLog.vivas).toBe(0);
    expect(hlLog.altas).toBe(40);
    await h.close();
  });

  it('irse ANTES de que el alta resuelva no deja una suscripcion huerfana', async () => {
    const h = hlAdapter();
    // El alta es asincrona. Sin la guarda, quien abre y cierra deprisa —tocar
    // un par y volver atras— dejaba viva una suscripcion que nadie escucha.
    const sub = h.streamTicker('BTC').subscribe();
    sub.unsubscribe();
    await asentar();
    await asentar();
    expect(hlLog.vivas).toBe(0);
    await h.close();
  });

  it('con DOS interesados hay UN solo par de altas (libro y contexto), y hacen falta las dos bajas', async () => {
    const h = hlAdapter();
    const uno = h.streamTicker('BTC').subscribe();
    const dos = h.streamTicker('BTC').subscribe();
    await asentar();
    expect(hlLog.altas).toBe(2);

    uno.unsubscribe();
    await asentar();
    expect(hlLog.vivas).toBe(2);

    dos.unsubscribe();
    await asentar();
    expect(hlLog.vivas).toBe(0);
    await h.close();
  });

  it('las velas van por par Y resolucion', async () => {
    const h = hlAdapter();
    const unaHora = h.streamCandles('BTC', '1h').subscribe();
    const unMinuto = h.streamCandles('BTC', '1m').subscribe();
    await asentar();
    expect(hlLog.altas).toBe(2);

    unaHora.unsubscribe();
    unMinuto.unsubscribe();
    await asentar();
    expect(hlLog.vivas).toBe(0);
    await h.close();
  });

  it('un intervalo que el venue no sirve se rechaza ANTES de suscribir nada', () => {
    const h = hlAdapter();
    // 6h no esta en la lista de Hyperliquid, y el fallo tiene que ser un error
    // legible aqui y no un socket abierto que no entrega nunca.
    expect(() => h.streamCandles('BTC', '6h')).toThrow(/6h/);
    expect(hlLog.altas).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Lo que el contrato promete a quien consume
// ═══════════════════════════════════════════════════════════════

describe('El contrato del flujo compartido', () => {
  it('vuelve a abrir despues de que todos se hayan ido', async () => {
    const a = asterAdapter();
    const primera = a.streamTicker('BTCUSDT').subscribe();
    await asentar();
    primera.unsubscribe();
    expect(wsLog.abiertos).toBe(0);

    // Volver a entrar en el mismo par tiene que funcionar: si el flujo quedara
    // terminado, la pantalla se abriria muda y sin nada que lo explicara.
    const segunda = a.streamTicker('BTCUSDT').subscribe();
    await asentar();
    expect(wsLog.abiertos).toBe(1);
    segunda.unsubscribe();
    await a.close();
  });

  it('el mismo simbolo devuelve el MISMO flujo, no uno nuevo cada vez', () => {
    const a = asterAdapter();
    const uno: Observable<Ticker> = a.streamTicker('BTCUSDT');
    const dos: Observable<Ticker> = a.streamTicker('BTCUSDT');
    expect(uno).toBe(dos);
    void a.close();
  });
});

describe('Aster — la marca y el listenKey (spec 015)', () => {
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Spec 001, F-72. `mark` era el punto medio del libro; el venue publica la
   * marca en `<symbol>@markPrice@1s` y los flujos combinados llegan envueltos
   * en `{ stream, data }`.
   */
  it('el ticker lleva la ultima marca recibida, no el punto medio', async () => {
    const a = asterAdapter();
    const recibidos: Ticker[] = [];
    a.streamTicker('BTCUSDT').subscribe((t) => recibidos.push(t));
    await asentar();

    expect(wsLog.urls.at(-1)).toContain('@bookTicker/btcusdt@markPrice@1s');
    wsLog.ultimo!.emit(
      'message',
      JSON.stringify({
        stream: 'btcusdt@markPrice@1s',
        data: { e: 'markPriceUpdate', p: '11.5', E: 1 },
      }),
    );
    wsLog.ultimo!.emit(
      'message',
      JSON.stringify({ stream: 'btcusdt@bookTicker', data: { b: '10', a: '12', E: 2 } }),
    );

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0].last).toBe('11');
    expect(recibidos[0].mark).toBe('11.5');
    await a.close();
  });

  /**
   * Spec 001, F-73. «No more user data event will be updated after this event
   * received until a new valid listenKey used»; el socket seguia abierto y
   * mudo hasta el corte de 24 h.
   */
  it('listenKeyExpired reabre el socket de usuario con un listenKey nuevo', async () => {
    let claves = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ listenKey: 'clave-' + ++claves }),
    }));
    const a = asterAdapter();
    try {
      a.streamFills().subscribe();
      await espera(100);
      expect(wsLog.urls.at(-1)).toContain('clave-1');

      wsLog.ultimo!.emit('message', JSON.stringify({ e: 'listenKeyExpired', E: 1 }));
      await espera(1_200);

      expect(wsLog.urls.at(-1)).toContain('clave-2');
    } finally {
      // Siempre: el keepalive del listenKey (30 min) mantendria vivo el proceso.
      await a.close();
    }
  });
});

describe('Aster — la reconexion del socket, con el flujo compartido', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('tras caerse y reengancharse, el MISMO suscriptor sigue recibiendo', async () => {
    const a = asterAdapter();
    const recibidos: Ticker[] = [];
    const sub = a.streamTicker('BTCUSDT').subscribe((t) => recibidos.push(t));
    await jest.advanceTimersByTimeAsync(1);

    wsLog.ultimo!.emit('message', JSON.stringify({ b: '10', a: '12', E: 1 }));
    expect(recibidos).toHaveLength(1);

    // Se cae. El adaptador programa el reenganche.
    const primero = wsLog.ultimo!;
    primero.close();
    expect(wsLog.abiertos).toBe(0);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(wsLog.creados).toBe(2);
    expect(wsLog.abiertos).toBe(1);

    // Y el flujo sigue siendo el mismo: quien estaba suscrito no se ha enterado.
    wsLog.ultimo!.emit('message', JSON.stringify({ b: '20', a: '22', E: 2 }));
    expect(recibidos).toHaveLength(2);
    expect(recibidos[1].last).toBe('21');

    sub.unsubscribe();
    expect(wsLog.abiertos).toBe(0);
    void a.close();
  });

  it('soltar con un reintento EN VUELO no reabre el socket', async () => {
    const a = asterAdapter();
    const sub = a.streamTicker('BTCUSDT').subscribe();
    await jest.advanceTimersByTimeAsync(1);

    // Se cae y queda un temporizador de reenganche pendiente...
    wsLog.ultimo!.close();
    expect(wsLog.creados).toBe(1);

    // ...y el interesado se va ANTES de que salte.
    sub.unsubscribe();
    await jest.advanceTimersByTimeAsync(60_000);

    // Sin cancelar el temporizador, el reintento abriria una conexion que ya no
    // mira nadie y que nadie iba a cerrar: la misma fuga por otro camino.
    expect(wsLog.creados).toBe(1);
    expect(wsLog.abiertos).toBe(0);
    void a.close();
  });

  it('cerrar el adaptador con un reintento pendiente tampoco reabre', async () => {
    const a = asterAdapter();
    a.streamTicker('BTCUSDT').subscribe();
    await jest.advanceTimersByTimeAsync(1);
    wsLog.ultimo!.close();

    void a.close();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(wsLog.creados).toBe(1);
    expect(wsLog.abiertos).toBe(0);
  });
});
