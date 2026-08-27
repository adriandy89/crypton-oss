import { BotsSseService } from '../bots';
import { MarketStreamService } from './market-stream.service';

/**
 * El interés que declara una conexión.
 *
 * Dos clases de interés compiten por el mismo cupo de temas —precios y velas—
 * y cada una cuesta cosas muy distintas: un precio comparte el ticker que el
 * worker ya tiene abierto, y una serie de velas es una conexión propia al
 * venue. Este fichero comprueba que la barata no puede echar fuera a la cara.
 */

function build() {
  const publicados: { canal: string; data: Record<string, unknown> }[] = [];
  const bus = {
    listenPublic: jest.fn().mockResolvedValue({ subscribe: () => ({ unsubscribe() {} }) }),
    publishPublic: jest.fn((canal: string, m: { data: Record<string, unknown> }) => {
      publicados.push({ canal, data: m.data });
      return Promise.resolve();
    }),
  };
  const sse = new BotsSseService(bus as never);
  const stream = new MarketStreamService(bus as never, sse);
  const { streamId } = sse.stream('u1');
  return { sse, stream, streamId, publicados, bus };
}

/** Lo que declara la lista de mercados: los 60 pares de la cabecera. */
const sesentaPares = Array.from({ length: 60 }, (_, i) => `ASTER:PAR${i}USDT`);

describe('watch — precios y velas comparten cupo', () => {
  it('la serie de velas ENTRA aunque los precios llenen el cupo', async () => {
    const h = build();
    // Es el caso NORMAL, no un borde: la lista de mercados vive dentro de las
    // pestañas y sigue abierta debajo del gráfico, asi que sus sesenta pares
    // estan declarados a la vez que el par que se esta mirando.
    const r = await h.stream.watch('u1', h.streamId, sesentaPares, ['HYPERLIQUID:BTC:1h']);
    expect(r.candles).toEqual(['HYPERLIQUID:BTC:1h']);
    expect(h.sse.activeTopics()).toContain('kl:HYPERLIQUID:BTC:1h');
  });

  it('lo que se recorta son los PRECIOS, que es lo barato de recuperar', async () => {
    const h = build();
    const r = await h.stream.watch('u1', h.streamId, sesentaPares, ['HYPERLIQUID:BTC:1h']);
    // Un precio que se cae fuera se sigue viendo con la instantanea; una serie
    // de velas que se cae fuera deja el grafico congelado.
    expect(r.symbols.length + r.candles.length).toBeLessThanOrEqual(60);
    expect(r.symbols.length).toBe(59);
  });

  it('sin velas, los precios siguen usando el cupo entero', async () => {
    const h = build();
    const r = await h.stream.watch('u1', h.streamId, sesentaPares, []);
    expect(r.symbols).toHaveLength(60);
  });

  it('se le dice al worker cada clase por su lado', async () => {
    const h = build();
    await h.stream.watch('u1', h.streamId, ['HYPERLIQUID:BTC'], ['HYPERLIQUID:BTC:1h']);
    const ultimo = h.publicados[h.publicados.length - 1];
    expect(ultimo.data['symbols']).toEqual(['HYPERLIQUID:BTC']);
    expect(ultimo.data['candles']).toEqual(['HYPERLIQUID:BTC:1h']);
  });
});

describe('watch — las dos redes no se mezclan', () => {
  it('el mismo par en las dos redes son DOS temas distintos', async () => {
    const h = build();
    await h.stream.watch('u1', h.streamId, ['HYPERLIQUID:BTC'], [], false);
    expect(h.sse.activeTopics()).toEqual(['px:HYPERLIQUID:BTC']);

    // Declarar en testnet SUSTITUYE lo declarado: una conexion mira una red a
    // la vez, y es lo que hace que cambiar de lente suelte lo de la anterior.
    await h.stream.watch('u1', h.streamId, ['HYPERLIQUID:BTC'], [], true);
    expect(h.sse.activeTopics()).toEqual(['pt:HYPERLIQUID:BTC']);
  });

  it('el prefijo de testnet mide tres caracteres, como el de mainnet', async () => {
    // `fromTopic` corta por posicion: un prefijo de otro largo devolveria el par
    // con el prefijo pegado, o sea una suscripcion a un simbolo inventado.
    const h = build();
    await h.stream.watch('u1', h.streamId, ['LIGHTER:ETH'], ['LIGHTER:ETH:1h'], true);
    const ultimo = h.publicados[h.publicados.length - 1];
    expect(ultimo.data['symbolsTest']).toEqual(['LIGHTER:ETH']);
    expect(ultimo.data['candlesTest']).toEqual(['LIGHTER:ETH:1h']);
  });

  it('las listas de mainnet quedan vacias, no ausentes, cuando solo se mira testnet', async () => {
    // Un worker sin actualizar lee `symbols` y `candles` e ignora el resto: si
    // esas dos trajeran lo de testnet, acabaria suscribiendose en mainnet.
    const h = build();
    await h.stream.watch('u1', h.streamId, ['ASTER:BTCUSDT'], [], true);
    const ultimo = h.publicados[h.publicados.length - 1];
    expect(ultimo.data['symbols']).toEqual([]);
    expect(ultimo.data['candles']).toEqual([]);
    expect(ultimo.data['symbolsTest']).toEqual(['ASTER:BTCUSDT']);
  });

  it('sin bandera de red se declara mainnet, igual que antes de que existiera testnet', async () => {
    const h = build();
    await h.stream.watch('u1', h.streamId, ['ASTER:BTCUSDT'], []);
    const ultimo = h.publicados[h.publicados.length - 1];
    expect(ultimo.data['symbols']).toEqual(['ASTER:BTCUSDT']);
    expect(ultimo.data['symbolsTest']).toEqual([]);
  });
});

describe('watch — lo que no puede pasar del borde', () => {
  it('un intervalo inventado no llega al venue', async () => {
    const h = build();
    const r = await h.stream.watch(
      'u1',
      h.streamId,
      [],
      ['HYPERLIQUID:BTC:99x', 'HYPERLIQUID:BTC', 'INVENTADO:BTC:1h', 'sin-nada'],
    );
    expect(r.candles).toEqual([]);
    expect(h.sse.activeTopics()).toEqual([]);
  });

  it('un venue que no existe no llega al venue', async () => {
    const h = build();
    const r = await h.stream.watch('u1', h.streamId, ['NOEXISTE:BTC'], []);
    expect(r.symbols).toEqual([]);
  });

  it('mas velas de las permitidas se recortan, no se aceptan todas', async () => {
    const h = build();
    const muchas = Array.from({ length: 20 }, (_, i) => `HYPERLIQUID:BTC:${i + 1}m`);
    const r = await h.stream.watch('u1', h.streamId, [], muchas);
    // Cada serie es una conexion al venue: el borde tiene que acotarlo antes de
    // que llegue a nadie.
    expect(r.candles.length).toBeLessThanOrEqual(4);
  });

  it('una conexion ajena no puede declarar nada', async () => {
    const h = build();
    const otra = new MarketStreamService(
      { publishPublic: jest.fn().mockResolvedValue(undefined) } as never,
      h.sse,
    );
    const r = await otra.watch('atacante', h.streamId, ['HYPERLIQUID:BTC'], ['HYPERLIQUID:BTC:1h']);
    expect(r.symbols).toEqual([]);
    expect(r.candles).toEqual([]);
  });
});

describe('Simbolos que existen de verdad', () => {
  /** Los cuatro pares en chino que Aster lista y que el catalogo tiene. */
  const chinos = ['币安人生USDT', '龙虾USDT', '我踏马来了USDT', '牛来USDT'];

  it('un par con nombre en chino se acepta como cualquier otro', async () => {
    const h = build();
    const r = await h.stream.watch(
      'u1',
      h.streamId,
      chinos.map((s) => `ASTER:${s}`),
      [`ASTER:${chinos[0]}:1h`],
    );
    // Antes el patron era una lista blanca de ASCII y estos cuatro caian fuera:
    // se veian en la lista, se podian tocar y su grafico respondia 400.
    expect(r.symbols).toHaveLength(4);
    expect(r.candles).toEqual([`ASTER:${chinos[0]}:1h`]);
  });

  it('UNO malo entre sesenta buenos no se lleva por delante a los demas', async () => {
    const h = build();
    const buenos = Array.from({ length: 59 }, (_, i) => `ASTER:PAR${i}USDT`);
    const r = await h.stream.watch('u1', h.streamId, [...buenos, 'ASTER:con:dos:puntos'], []);
    // El borde descarta el que no encaja y deja pasar el resto. Lo que NO puede
    // hacer es tirar la declaracion entera y dejar la pantalla sin precios.
    expect(r.symbols).toHaveLength(59);
  });

  it('lo que romperia la estructura sigue fuera', async () => {
    const h = build();
    const r = await h.stream.watch(
      'u1',
      h.streamId,
      [
        'ASTER:con:dos:puntos',
        'ASTER:con,coma',
        'ASTER:con|barra',
        'ASTER:con espacio',
        'ASTER:' + 'x'.repeat(33),
        'ASTER:',
      ],
      [],
    );
    expect(r.symbols).toEqual([]);
  });
});
