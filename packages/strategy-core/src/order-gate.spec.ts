import { Venue, type DesiredOrder, type MarketSpec } from '@crypton/shared';
import { revisarOrden } from './order-gate';

/**
 * La puerta que faltaba, probada con el caso REAL que pausó un bot.
 *
 * Los números no son inventados: son los de `Test1` (BTC · Lighter · Martingala)
 * y los mínimos que publica Lighter testnet para BTC.
 */

/** Lighter testnet, BTC. `min_base_amount 0.00020`, `min_quote_amount 10`. */
const LIGHTER_BTC: MarketSpec = {
  venue: Venue.LIGHTER,
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '0.1',
  stepSize: '0.00001',
  minNotional: '10',
  minQty: '0.0002',
  maxQty: null,
  maxLeverage: 20,
  priceDecimals: 1,
  qtyDecimals: 5,
  active: true,
};

const orden = (o: Partial<DesiredOrder>): DesiredOrder => ({
  clientOrderId: 'c1',
  levelKind: 'TAKE_PROFIT',
  levelIndex: 0,
  side: 'SELL',
  type: 'LIMIT',
  price: '79743.1',
  qty: '0.00001',
  reduceOnly: true,
  ...o,
});

describe('la puerta de salida de órdenes', () => {
  describe('el caso que pausó un bot de verdad', () => {
    // BASE de 0,00196 BTC con 0,00001 ejecutado —una parcial— y las seis
    // seguridades resting en el venue.
    const takeProfit = orden({ qty: '0.00001', price: '79743.1' });

    it('con entradas vivas ESPERA: no manda la orden y no es un error', () => {
      const v = revisarOrden(LIGHTER_BTC, takeProfit, true);
      expect(v.motivo).toBe('ESPERANDO_MINIMO');
      if (v.motivo === 'OK') throw new Error('inalcanzable');
      // INFO y no WARN: no hay nada que arreglar, la posición sigue creciendo.
      expect(v.severidad).toBe('INFO');
      expect(v.mensaje).toContain('0.0002');
      expect(v.mensaje).toContain('más ejecuciones');
    });

    it('en cuanto la posición pasa el mínimo, el take profit SALE', () => {
      // Esto es lo que tiene que ocurrir solo, sin que nadie toque nada: entra
      // otra ejecución, la forma de la orden cambia, se levanta la cuarentena.
      const conMasPosicion = orden({ qty: '0.0002', price: '79743.1' });
      expect(revisarOrden(LIGHTER_BTC, conMasPosicion, true).motivo).toBe('OK');
    });

    it('sin entradas vivas AVISA: ese resto ya no se puede cerrar', () => {
      const v = revisarOrden(LIGHTER_BTC, takeProfit, false);
      expect(v.motivo).toBe('RESTO_INCERRABLE');
      if (v.motivo === 'OK') throw new Error('inalcanzable');
      expect(v.severidad).toBe('WARN');
      expect(v.mensaje).toContain('desde el exchange');
    });
  });

  describe('el stop loss se mide al precio de marca, no al de disparo', () => {
    /**
     * Spec 001, F-91. El stop lleva `price = triggerPrice`, y la puerta medía
     * su notional ahí: una posición de 10,5 USDC con stop al −10 % daba 9,45 al
     * disparo, por debajo del mínimo de 10, y el motor renunciaba a la red con
     * un WARN. El venue mide la posición que se cierra, no el precio al que se
     * dispara.
     */
    it('un stop de 10,5 USDC a -10 % sale aunque al disparo valga 9,45', () => {
      const stop = orden({
        levelKind: 'STOP_LOSS',
        type: 'MARKET',
        side: 'SELL',
        // 0,0002 BTC × 52.500 = 10,5 USDC de posición; al disparo, × 47.250 = 9,45.
        qty: '0.0002',
        price: '47250.0',
      });
      expect(revisarOrden(LIGHTER_BTC, stop, false, '52500').motivo).toBe('OK');
    });

    /**
     * Spec 044, F-02. La regla existia solo para el `levelKind` STOP_LOSS, y en
     * cuanto hubo un TAKE_PROFIT que tambien es condicional -el seguimiento del
     * spec 042- se quedo corta: su disparador vive un retroceso POR DEBAJO de la
     * marca, asi que una posicion que si cumple el minimo se media por debajo y
     * la salida no se colocaba.
     */
    it('un take profit CONDICIONAL tambien se mide en la marca', () => {
      const trailing = orden({
        levelKind: 'TAKE_PROFIT',
        type: 'MARKET',
        side: 'SELL',
        intent: 'SL',
        qty: '0.0002',
        // Disparador un 10 % por debajo de la marca: 9,45 alli, 10,5 aqui.
        price: '47250.0',
        triggerPrice: '47250.0',
      });
      expect(revisarOrden(LIGHTER_BTC, trailing, false, '52500').motivo).toBe('OK');
      // Y sin marca se sigue midiendo donde se puede, como el stop.
      expect(revisarOrden(LIGHTER_BTC, trailing, false).motivo).toBe('RESTO_INCERRABLE');
    });

    it('un take profit LIMIT sigue midiendose en su propio precio', () => {
      // Ahi el precio de la orden SI es el precio al que se ejecuta, asi que
      // medirlo en la marca seria mentir en la direccion contraria.
      const limit = orden({
        levelKind: 'TAKE_PROFIT',
        type: 'LIMIT',
        side: 'SELL',
        qty: '0.0002',
        price: '47250.0',
      });
      expect(revisarOrden(LIGHTER_BTC, limit, false, '52500').motivo).toBe('RESTO_INCERRABLE');
    });

    it('sin precio de marca se sigue midiendo al precio de la orden', () => {
      const stop = orden({
        levelKind: 'STOP_LOSS',
        type: 'MARKET',
        qty: '0.0002',
        price: '47250.0',
      });
      expect(revisarOrden(LIGHTER_BTC, stop, false).motivo).toBe('RESTO_INCERRABLE');
    });
  });

  describe('lo que no vale en ningún venue', () => {
    it('una salida que se queda en cero al redondear nunca se manda', () => {
      // Por debajo de un step. Da igual si quedan entradas vivas: no existe
      // orden que mandar, así que esperar no arreglaría nada.
      const polvo = orden({ qty: '0.000001' });
      for (const vivas of [true, false]) {
        const v = revisarOrden(LIGHTER_BTC, polvo, vivas);
        expect(v.motivo).toBe('IMPOSIBLE');
      }
    });
  });

  describe('las entradas se siguen tratando como antes', () => {
    it('un nivel por debajo del mínimo se descarta y se avisa', () => {
      const seguridad = orden({
        levelKind: 'SAFETY',
        levelIndex: 3,
        side: 'BUY',
        reduceOnly: false,
        qty: '0.00001',
      });
      const v = revisarOrden(LIGHTER_BTC, seguridad, true);
      expect(v.motivo).toBe('ENTRADA_INVALIDA');
      if (v.motivo === 'OK') throw new Error('inalcanzable');
      expect(v.severidad).toBe('WARN');
    });

    it('un nivel que cumple pasa sin ruido', () => {
      // El BASE real del bot: 0,00196 BTC a 78.603,3 = 154 $.
      const base = orden({
        levelKind: 'BASE',
        levelIndex: 0,
        side: 'BUY',
        reduceOnly: false,
        qty: '0.00196',
        price: '78603.3',
      });
      expect(revisarOrden(LIGHTER_BTC, base, true).motivo).toBe('OK');
    });
  });

  describe('un venue sin mínimos declarados no inventa ninguno', () => {
    it('deja pasar lo que en Lighter no cabría', () => {
      const sinMinimos: MarketSpec = {
        ...LIGHTER_BTC,
        minNotional: null,
        minQty: null,
      };
      expect(revisarOrden(sinMinimos, orden({ qty: '0.00001' }), false).motivo).toBe('OK');
    });
  });
});
