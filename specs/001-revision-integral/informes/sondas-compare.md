# Sondas públicas frente a lo que derivan los adaptadores

Generado el 2026-09-05T13:30:02.641Z a partir de los JSON de `out/`.
Solo lecturas públicas: ninguna petición firmada, ninguna credencial cargada.

## Hyperliquid

### mainnet — 233 activos, 5126 precios simulados

Cada precio se genera como `mid × factor`, se pasa por `roundPriceForSide` (lo que hace
`px()` en las estrategias) y después por `formatPrice` del adaptador, que es lo que sale al venue.

| Comprobación | Resultado |
|---|---|
| Precios con más de `6 − szDecimals` decimales (rechazo del venue) | **0** |
| Precios con más de 5 cifras significativas (rechazo del venue) | **0** |
| Precios que se mueven en la dirección INSEGURA del lado | **78** |
| Precios que `toSignificantDigits(5)` altera tras el redondeo al tick | **161** |

**Dirección insegura** (primeros 12 de 78):

```
{"sym":"BTC","f":1.5,"side":"BUY","pedido":"119375","salida":"119380"}
{"sym":"BTC","f":2,"side":"BUY","pedido":"159167","salida":"159170"}
{"sym":"AVAX","f":1.5,"side":"BUY","pedido":"11.2519","salida":"11.252"}
{"sym":"AVAX","f":2,"side":"BUY","pedido":"15.0026","salida":"15.003"}
{"sym":"BNB","f":1.5,"side":"SELL","pedido":"1124.23","salida":"1124.2"}
{"sym":"BNB","f":2,"side":"BUY","pedido":"1498.97","salida":"1499"}
{"sym":"LTC","f":2,"side":"BUY","pedido":"105.977","salida":"105.98"}
{"sym":"DOGE","f":1.5,"side":"BUY","pedido":"0.128908","salida":"0.12891"}
{"sym":"DOGE","f":2,"side":"BUY","pedido":"0.171878","salida":"0.17188"}
{"sym":"SUI","f":1.5,"side":"BUY","pedido":"1.17808","salida":"1.1781"}
{"sym":"SUI","f":2,"side":"BUY","pedido":"1.57078","salida":"1.5708"}
{"sym":"RNDR","f":1.5,"side":"BUY","pedido":"10.3428","salida":"10.343"}
```

**Alterados por toSignificantDigits** (primeros 12 de 161):

```
{"sym":"BTC","szDecimals":5,"f":1.5,"side":"BUY","pedido":"119375","salida":"119380"}
{"sym":"BTC","szDecimals":5,"f":1.5,"side":"SELL","pedido":"119376","salida":"119380"}
{"sym":"BTC","szDecimals":5,"f":2,"side":"BUY","pedido":"159167","salida":"159170"}
{"sym":"BTC","szDecimals":5,"f":2,"side":"SELL","pedido":"159167","salida":"159170"}
{"sym":"AVAX","szDecimals":2,"f":1.5,"side":"BUY","pedido":"11.2519","salida":"11.252"}
{"sym":"AVAX","szDecimals":2,"f":2,"side":"BUY","pedido":"15.0026","salida":"15.003"}
{"sym":"AVAX","szDecimals":2,"f":2,"side":"SELL","pedido":"15.0026","salida":"15.003"}
{"sym":"BNB","szDecimals":3,"f":1.5,"side":"BUY","pedido":"1124.22","salida":"1124.2"}
{"sym":"BNB","szDecimals":3,"f":1.5,"side":"SELL","pedido":"1124.23","salida":"1124.2"}
{"sym":"BNB","szDecimals":3,"f":2,"side":"BUY","pedido":"1498.97","salida":"1499"}
{"sym":"BNB","szDecimals":3,"f":2,"side":"SELL","pedido":"1498.97","salida":"1499"}
{"sym":"LTC","szDecimals":2,"f":2,"side":"BUY","pedido":"105.977","salida":"105.98"}
```

Activos sin `midPx` ni `markPx` utilizable: 0
Activos marcados `isDelisted`: 56 (MATIC, RNDR, FTM, MKR, FXS, HPOS, RLB, UNIBOT)
Apalancamiento máximo declarado: min 3, max 40.
Valores de `szDecimals` presentes: 0, 1, 2, 3, 4, 5.

### testnet — 211 activos, 4642 precios simulados

Cada precio se genera como `mid × factor`, se pasa por `roundPriceForSide` (lo que hace
`px()` en las estrategias) y después por `formatPrice` del adaptador, que es lo que sale al venue.

| Comprobación | Resultado |
|---|---|
| Precios con más de `6 − szDecimals` decimales (rechazo del venue) | **0** |
| Precios con más de 5 cifras significativas (rechazo del venue) | **0** |
| Precios que se mueven en la dirección INSEGURA del lado | **69** |
| Precios que `toSignificantDigits(5)` altera tras el redondeo al tick | **139** |

**Dirección insegura** (primeros 12 de 69):

```
{"sym":"BTC","f":1.5,"side":"BUY","pedido":"119855","salida":"119860"}
{"sym":"BTC","f":2,"side":"BUY","pedido":"159807","salida":"159810"}
{"sym":"BNB","f":1.5,"side":"BUY","pedido":"1131.86","salida":"1131.9"}
{"sym":"BNB","f":2,"side":"BUY","pedido":"1509.15","salida":"1509.2"}
{"sym":"AVAX","f":1.5,"side":"SELL","pedido":"11.2824","salida":"11.282"}
{"sym":"AVAX","f":2,"side":"SELL","pedido":"15.0432","salida":"15.043"}
{"sym":"RLB","f":1.5,"side":"BUY","pedido":"0.109759","salida":"0.10976"}
{"sym":"RLB","f":2,"side":"BUY","pedido":"0.146346","salida":"0.14635"}
{"sym":"UNIBOT","f":1.5,"side":"BUY","pedido":"12.6705","salida":"12.671"}
{"sym":"FXS","f":1.5,"side":"BUY","pedido":"1.00539","salida":"1.0054"}
{"sym":"FXS","f":2,"side":"SELL","pedido":"1.34052","salida":"1.3405"}
{"sym":"RNDR","f":1.5,"side":"BUY","pedido":"10.3849","salida":"10.385"}
```

**Alterados por toSignificantDigits** (primeros 12 de 139):

```
{"sym":"BTC","szDecimals":5,"f":1.5,"side":"BUY","pedido":"119855","salida":"119860"}
{"sym":"BTC","szDecimals":5,"f":1.5,"side":"SELL","pedido":"119856","salida":"119860"}
{"sym":"BTC","szDecimals":5,"f":2,"side":"BUY","pedido":"159807","salida":"159810"}
{"sym":"BTC","szDecimals":5,"f":2,"side":"SELL","pedido":"159807","salida":"159810"}
{"sym":"BNB","szDecimals":3,"f":1.5,"side":"BUY","pedido":"1131.86","salida":"1131.9"}
{"sym":"BNB","szDecimals":3,"f":1.5,"side":"SELL","pedido":"1131.87","salida":"1131.9"}
{"sym":"BNB","szDecimals":3,"f":2,"side":"BUY","pedido":"1509.15","salida":"1509.2"}
{"sym":"BNB","szDecimals":3,"f":2,"side":"SELL","pedido":"1509.15","salida":"1509.2"}
{"sym":"AVAX","szDecimals":2,"f":1.5,"side":"BUY","pedido":"11.2824","salida":"11.282"}
{"sym":"AVAX","szDecimals":2,"f":1.5,"side":"SELL","pedido":"11.2824","salida":"11.282"}
{"sym":"AVAX","szDecimals":2,"f":2,"side":"BUY","pedido":"15.0432","salida":"15.043"}
{"sym":"AVAX","szDecimals":2,"f":2,"side":"SELL","pedido":"15.0432","salida":"15.043"}
```

Activos sin `midPx` ni `markPx` utilizable: 0
Activos marcados `isDelisted`: 54 (MATIC, RLB, HPOS, UNIBOT, FXS, MKR, RNDR, FTM)
Apalancamiento máximo declarado: min 2, max 50.
Valores de `szDecimals` presentes: 0, 1, 2, 3, 4, 5.

## Lighter

### mainnet

| Dato | Valor |
|---|---|
| Mercados perp en el catálogo | 233 |
| Perp con `status: active` | 216 |
| Desajustes `supported_*_decimals` vs `*_decimals` | 0 |
| `min_base_amount` que no es múltiplo del step | 0 |
| Apalancamiento derivado (min…max) | 3…100 |
| `min_quote_amount` distintos | 10.000000, 0.000000 |

**Peticiones que dispararía `getOpenOrders()` sin símbolo: 216** (una `accountActiveOrders` firmada por mercado activo), contra un cupo Standard de 60 por minuto.

Ruta de velas del adaptador (`/api/v1/candles`): HTTP 200. Ruta del SDK 1.3.0 (`/api/v1/candlesticks`): HTTP 403.

### testnet

| Dato | Valor |
|---|---|
| Mercados perp en el catálogo | 176 |
| Perp con `status: active` | 176 |
| Desajustes `supported_*_decimals` vs `*_decimals` | 0 |
| `min_base_amount` que no es múltiplo del step | 0 |
| Apalancamiento derivado (min…max) | 3…50 |
| `min_quote_amount` distintos | 10.000000 |

**Peticiones que dispararía `getOpenOrders()` sin símbolo: 176** (una `accountActiveOrders` firmada por mercado activo), contra un cupo Standard de 60 por minuto.

Ruta de velas del adaptador (`/api/v1/candles`): HTTP 200. Ruta del SDK 1.3.0 (`/api/v1/candlesticks`): HTTP 404.

## Aster

### mainnet

| Dato | Valor |
|---|---|
| Símbolos PERPETUAL | 572 |
| Sin `PRICE_FILTER` (usarían el tick por defecto `0.01`) | 0 |
| Sin `LOT_SIZE` (usarían el step por defecto `0.001`) | 0 |
| Sin `MIN_NOTIONAL` (quedaría `minNotional: null`) | 0 |
| `decimalsOf(tickSize)` distinto de `pricePrecision` | 1 |
| `MAX_NUM_ORDERS` por símbolo (min…max) | 200…200 |
| `PERCENT_PRICE` distintos | 0.9500…1.0500 · 0.9800…1.0200 · 0.9700…1.0300 · 0.9000…1.1000 · 0.8500…1.1500 · 0.9600…1.0400 |
| `MARKET_LOT_SIZE.maxQty` menor que `LOT_SIZE.maxQty` | 572 |
| `rateLimits` declarados | [{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":2400},{"rateLimitType":"ORDERS","interval":"MINUTE","intervalNum":1,"limit":1200},{"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":300}] |

**`pricePrecision` no coincide con los decimales del tick** (por eso el adaptador usa el filtro):

```
YFIUSDT: tickSize=1 (0 dec) vs pricePrecision=3
```

**El tope de una orden a MERCADO es menor que el de una LIMIT** (el adaptador solo lee `LOT_SIZE`):

```
ASTERUSDT: MARKET_LOT_SIZE.maxQty=900000 < LOT_SIZE.maxQty=10000000
BTCUSDT: MARKET_LOT_SIZE.maxQty=120 < LOT_SIZE.maxQty=1000
ETHUSDT: MARKET_LOT_SIZE.maxQty=2000 < LOT_SIZE.maxQty=10000
BNBUSDT: MARKET_LOT_SIZE.maxQty=2000 < LOT_SIZE.maxQty=100000
SOLUSDT: MARKET_LOT_SIZE.maxQty=8000 < LOT_SIZE.maxQty=1000000
XRPUSDT: MARKET_LOT_SIZE.maxQty=2000000 < LOT_SIZE.maxQty=10000000
DOGEUSDT: MARKET_LOT_SIZE.maxQty=30000000 < LOT_SIZE.maxQty=50000000
HYPEUSDT: MARKET_LOT_SIZE.maxQty=20000 < LOT_SIZE.maxQty=200000
ADAUSDT: MARKET_LOT_SIZE.maxQty=2000000 < LOT_SIZE.maxQty=6000000
DOTUSDT: MARKET_LOT_SIZE.maxQty=300000 < LOT_SIZE.maxQty=3000000
```

Valores de `MIN_NOTIONAL`: 5.

### testnet

| Dato | Valor |
|---|---|
| Símbolos PERPETUAL | 18 |
| Sin `PRICE_FILTER` (usarían el tick por defecto `0.01`) | 0 |
| Sin `LOT_SIZE` (usarían el step por defecto `0.001`) | 0 |
| Sin `MIN_NOTIONAL` (quedaría `minNotional: null`) | 0 |
| `decimalsOf(tickSize)` distinto de `pricePrecision` | 0 |
| `MAX_NUM_ORDERS` por símbolo (min…max) | 200…200 |
| `PERCENT_PRICE` distintos | 0.9500…1.0500 · 0.9800…1.0200 · 0.9100…1.0500 · 0.9700…1.0300 · 0.9000…1.1000 |
| `MARKET_LOT_SIZE.maxQty` menor que `LOT_SIZE.maxQty` | 18 |
| `rateLimits` declarados | [{"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":-2},{"rateLimitType":"ORDERS","interval":"MINUTE","intervalNum":1,"limit":-2},{"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":1000}] |

**El tope de una orden a MERCADO es menor que el de una LIMIT** (el adaptador solo lee `LOT_SIZE`):

```
ASTERUSDT: MARKET_LOT_SIZE.maxQty=200000 < LOT_SIZE.maxQty=2000000
BTCUSDT: MARKET_LOT_SIZE.maxQty=120 < LOT_SIZE.maxQty=1000
ETHUSDT: MARKET_LOT_SIZE.maxQty=2000 < LOT_SIZE.maxQty=10000
BNBUSDT: MARKET_LOT_SIZE.maxQty=10000000 < LOT_SIZE.maxQty=1000000000
SOLUSDT: MARKET_LOT_SIZE.maxQty=5000 < LOT_SIZE.maxQty=1000000
XRPUSDT: MARKET_LOT_SIZE.maxQty=200000 < LOT_SIZE.maxQty=1000000
SUIUSDT: MARKET_LOT_SIZE.maxQty=600000 < LOT_SIZE.maxQty=10000000
1000PEPEUSDT: MARKET_LOT_SIZE.maxQty=100000000 < LOT_SIZE.maxQty=800000000
1000SHIBUSDT: MARKET_LOT_SIZE.maxQty=50000000 < LOT_SIZE.maxQty=800000000
ADAUSDT: MARKET_LOT_SIZE.maxQty=2000000 < LOT_SIZE.maxQty=6000000
```

Valores de `MIN_NOTIONAL`: 5.

