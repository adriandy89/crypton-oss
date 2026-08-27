import { BotsSseService } from './bots-sse.service';

/**
 * El reparto del flujo SSE.
 *
 * Este fichero existe porque la fase 2 mete un SEGUNDO criterio de reparto en
 * el mismo canal: los eventos de bots van por usuario —son suyos— y los precios
 * van por tema —son publicos, y quien los recibe es quien los mira—. Mezclar
 * los dos criterios en un canal por el que viajan fills y liquidaciones es
 * justo donde un error se paga caro, asi que se comprueba que no se tocan.
 */

/** Recoge lo que sale por una conexion. */
function open(sse: BotsSseService, userId: string) {
  const { obs, subject, streamId } = sse.stream(userId);
  const received: Record<string, unknown>[] = [];
  const sub = obs.subscribe((e: MessageEvent) =>
    received.push(JSON.parse(String(e.data)) as Record<string, unknown>),
  );
  return {
    streamId,
    subject,
    received,
    types: () => received.map((r) => r['type']),
    close: () => {
      sub.unsubscribe();
      sse.remove(userId, subject, streamId);
    },
  };
}

const build = () => new BotsSseService({ listen: jest.fn() } as never);

describe('HELLO — el identificador de la conexion', () => {
  it('es lo PRIMERO que sale, antes de cualquier otro evento', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    expect(conn.received[0]).toEqual({
      type: 'HELLO',
      streamId: conn.streamId,
    });
    conn.close();
  });

  it('dos conexiones del MISMO usuario tienen identificadores distintos', () => {
    const sse = build();
    const movil = open(sse, 'u1');
    const portatil = open(sse, 'u1');
    // Es lo que permite que mirar la lista en el movil y un grafico en el
    // portatil no se pisen: con un solo conjunto por usuario, el ultimo en
    // declarar dejaria al otro sin precios.
    expect(movil.streamId).not.toBe(portatil.streamId);
    movil.close();
    portatil.close();
  });
});

describe('Reparto por tema — quien mira que', () => {
  it('solo lo recibe quien lo ha pedido', () => {
    const sse = build();
    const mira = open(sse, 'u1');
    const noMira = open(sse, 'u2');
    sse.setTopics('u1', mira.streamId, ['px:HYPERLIQUID:BTC']);

    sse.emitTopic('px:HYPERLIQUID:BTC', {
      type: 'TICK',
      data: { last: '50000' },
    });

    expect(mira.types()).toEqual(['HELLO', 'TICK']);
    expect(noMira.types()).toEqual(['HELLO']);
    mira.close();
    noMira.close();
  });

  it('sin interes declarado no llega NADA: nadie recibe los 935 simbolos', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    sse.emitTopic('px:ASTER:BTCUSDT', { type: 'TICK', data: {} });
    expect(conn.types()).toEqual(['HELLO']);
    conn.close();
  });

  it('declarar SUSTITUYE la lista, no la amplia', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    sse.setTopics('u1', conn.streamId, ['px:HYPERLIQUID:BTC']);
    sse.setTopics('u1', conn.streamId, ['px:HYPERLIQUID:ETH']);

    sse.emitTopic('px:HYPERLIQUID:BTC', { type: 'TICK', data: {} });
    expect(conn.types()).toEqual(['HELLO']);

    sse.emitTopic('px:HYPERLIQUID:ETH', { type: 'TICK', data: {} });
    expect(conn.types()).toEqual(['HELLO', 'TICK']);
    conn.close();
  });

  it('un tema sin interesados desaparece: es lo que suelta la suscripcion al venue', () => {
    const sse = build();
    const a = open(sse, 'u1');
    const b = open(sse, 'u2');
    sse.setTopics('u1', a.streamId, ['px:LIGHTER:SOL']);
    sse.setTopics('u2', b.streamId, ['px:LIGHTER:SOL']);
    expect(sse.activeTopics()).toEqual(['px:LIGHTER:SOL']);

    // Que se vaya uno no puede dejar al otro sin precios.
    a.close();
    expect(sse.activeTopics()).toEqual(['px:LIGHTER:SOL']);

    b.close();
    expect(sse.activeTopics()).toEqual([]);
  });

  it('cerrar la conexion suelta su interes aunque no se declare nada', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    sse.setTopics('u1', conn.streamId, ['px:ASTER:ETHUSDT']);
    conn.close();
    // Sin esto, cerrar la aplicacion de golpe dejaria al worker manteniendo
    // una suscripcion al venue para una pantalla que ya no existe.
    expect(sse.activeTopics()).toEqual([]);
  });
});

describe('Aislamiento — lo que no puede hacer un cliente', () => {
  it('no se puede manipular el interes de OTRO usuario conociendo su id', () => {
    const sse = build();
    const victima = open(sse, 'victima');
    sse.setTopics('victima', victima.streamId, ['px:HYPERLIQUID:BTC']);

    // El atacante conoce el identificador ajeno e intenta vaciarlo. Los precios
    // son publicos y no habria fuga de datos, pero si una forma barata de dejar
    // a un tercero con la pantalla congelada.
    const resultado = sse.setTopics('atacante', victima.streamId, []);
    expect(resultado).toEqual([]);
    expect(sse.activeTopics()).toEqual(['px:HYPERLIQUID:BTC']);

    sse.emitTopic('px:HYPERLIQUID:BTC', { type: 'TICK', data: {} });
    expect(victima.types()).toEqual(['HELLO', 'TICK']);
    victima.close();
  });

  it('un identificador inventado no crea conexion ni interes', () => {
    const sse = build();
    expect(sse.setTopics('u1', 'no-existe', ['px:HYPERLIQUID:BTC'])).toEqual(
      [],
    );
    expect(sse.activeTopics()).toEqual([]);
  });

  it('hay TOPE de temas: nadie puede pedir el catalogo entero', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    const muchos = Array.from({ length: 500 }, (_, i) => `px:ASTER:PAR${i}`);
    const aceptados = sse.setTopics('u1', conn.streamId, muchos);
    // Cada tema puede acabar en una suscripcion al WebSocket de un venue, que
    // es un recurso contado y compartido con los bots que estan operando.
    expect(aceptados).toHaveLength(60);
    expect(sse.activeTopics()).toHaveLength(60);
    conn.close();
  });
});

describe('Los eventos de bots siguen intactos', () => {
  it('van por USUARIO y a TODAS sus conexiones, sin depender de ningun tema', () => {
    const sse = build();
    const movil = open(sse, 'u1');
    const portatil = open(sse, 'u1');
    const otro = open(sse, 'u2');

    sse.emit('u1', { type: 'FILL', botId: 'b1', data: { qty: '1' } });

    expect(movil.types()).toEqual(['HELLO', 'FILL']);
    expect(portatil.types()).toEqual(['HELLO', 'FILL']);
    expect(otro.types()).toEqual(['HELLO']);
    movil.close();
    portatil.close();
    otro.close();
  });

  it('un tema declarado no desvia ni filtra los eventos del bot', () => {
    const sse = build();
    const conn = open(sse, 'u1');
    sse.setTopics('u1', conn.streamId, ['px:HYPERLIQUID:BTC']);
    sse.emit('u1', { type: 'BOT_STATUS', data: { status: 'PAUSED' } });
    expect(conn.types()).toEqual(['HELLO', 'BOT_STATUS']);
    conn.close();
  });

  it('cerrar una conexion no se lleva por delante la otra del mismo usuario', () => {
    const sse = build();
    const primera = open(sse, 'u1');
    const segunda = open(sse, 'u1');
    primera.close();

    sse.emit('u1', { type: 'FILL', data: {} });
    expect(segunda.types()).toEqual(['HELLO', 'FILL']);
    expect(sse.connectionCount()).toBe(1);
    segunda.close();
    expect(sse.connectionCount()).toBe(0);
  });
});

describe('Tope de conexiones abiertas por usuario', () => {
  it('cuarenta conexiones del mismo usuario no dejan cuarenta abiertas', () => {
    const sse = build();
    const conns = Array.from({ length: 40 }, () => open(sse, 'u1'));
    // Antes se aceptaban las cuarenta: cada una es un Subject, un temporizador
    // de latido cada 15 s, dos entradas de mapa y un socket, y nada las acotaba.
    expect(sse.connectionCount()).toBeLessThanOrEqual(5);
    for (const c of conns) c.close();
    expect(sse.connectionCount()).toBe(0);
  });

  it('la que se cierra es la MAS ANTIGUA, y la nueva sigue viva', () => {
    const sse = build();
    const viejas = Array.from({ length: 5 }, () => open(sse, 'u1'));
    const nueva = open(sse, 'u1');

    sse.emit('u1', { type: 'FILL', data: {} });
    // La primera ya no recibe...
    expect(viejas[0].types()).toEqual(['HELLO']);
    // ...y la ultima si.
    expect(nueva.types()).toEqual(['HELLO', 'FILL']);
    nueva.close();
  });

  it('se COMPLETA el flujo de la que se cierra, no se abandona', () => {
    const sse = build();
    let completada = false;
    const { obs, subject, streamId } = sse.stream('u1');
    obs.subscribe({ complete: () => (completada = true) });
    void subject;
    void streamId;
    for (let i = 0; i < 5; i++) open(sse, 'u1');
    // Sin completar, el cliente se quedaria con una conexion que ya no recibe
    // nada y sin enterarse de que tiene que reconectar.
    expect(completada).toBe(true);
  });

  it('el tope es POR USUARIO: uno no puede echar al otro', () => {
    const sse = build();
    const mias = Array.from({ length: 5 }, () => open(sse, 'u1'));
    const suya = open(sse, 'u2');
    Array.from({ length: 5 }, () => open(sse, 'u1'));

    sse.emit('u2', { type: 'FILL', data: {} });
    expect(suya.types()).toEqual(['HELLO', 'FILL']);
    void mias;
    suya.close();
  });
});
