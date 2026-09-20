# 065 — Plan

## Enfoque

Tres capas, de fuera adentro, y en este orden porque el orden importa:

1. **Que no se pida lo que no hace falta** (R-1, R-7, R-8). El bot simulado ya recibe el precio por
   WebSocket; pedirlo otra vez por REST en cada tick era pagar dos veces por el mismo dato.
2. **Que lo que sí hace falta quepa** (R-2). El depósito se dimensionó en el spec 020 para lecturas
   de peso 2; el canal con IA trajo lecturas de peso 37 y nadie volvió a mirar el número.
3. **Que la espera sea justa y visible** (R-3, R-4, R-9). Dormir en vez de fallar fue una decisión
   correcta, pero dormir **sin cola** convierte una espera en hambre, y dormir **sin contador**
   la hace invisible hasta que un usuario ve un aviso en Telegram.

**R-3 va antes que R-4.** Subir la concurrencia sin arreglar antes la cola del presupuesto
*empeora* el hambre: añade pretendientes que compiten al despertar. Es la única dependencia dura
entre fases.

## Alternativas descartadas

- **Subir el umbral de `TICK_SLOW` o su enfriamiento.** Apagar el detector de humos. El bot seguiría
  llegando tarde, solo que en silencio.
- **Trocear la petición de velas** para que ninguna supere la capacidad. Cuatro páginas de 250
  pesan 100 frente a 37: multiplica por 2,7 el consumo real del cupo para resolver un problema que
  no es de cupo sino de capacidad instantánea.
- **Meter a los simulados en `MarketDataService`.** Es la solución de libro y probablemente el paso
  siguiente, pero hoy ese servicio no tiene suscripción para los símbolos que solo usan simulados,
  así que su `ticker()` iría a REST igual: no arreglaría nada sin cambiar también `streamTicker`,
  el contador de referencias del feed y dónde vive el último precio del spec 050 R-4.
- **Un TTL ciego en `DryRunAdapter.getTicker`.** Habría roto el backtest en silencio:
  `ReplaySourceAdapter.streamTicker` devuelve `EMPTY`, los ticks sintéticos comparten la marca de
  tiempo de su vela, y lo único que mueve un replay es precisamente que cada `getTicker` case. Por
  eso se guarda la **procedencia** y no solo la antigüedad.
- **Recortar la serie de 1 h para ahorrar peso.** Sus percentiles se calculan sobre toda la serie:
  la longitud no es margen, es la ventana de referencia. Medido, a 336 velas el escenario de prueba
  pasa de RANGO a INDEFINIDO.
- **Agregar el 1 h desde el 15 min** y quitar una temporalidad. Exigiría 1920 velas de 15 min, y
  Lighter solo sirve 497: el régimen pasaría a depender del venue.
- **Recortar la serie de estructura a 480 o 500.** Por debajo de 584 velas se pierde la banda de
  evidencia MODERADA, y con ella la puerta que hoy descarta un setup con esperanza negativa. Bajar
  el peso apagando una protección no es optimizar.
- **`burstSeconds` como variable de entorno.** API y worker comparten depósito: si uno llevara 6 y
  el otro 2, el recorte del script de Redis limitaría en silencio y para siempre. El número viaja
  con la versión del paquete. `VENUE_MAX_CONCURRENT_READS` sí puede ser variable porque es estado
  por proceso, sin nada compartido.
- **Versionar la clave del depósito en Redis** para el despliegue escalonado. Daría dos depósitos
  simultáneos sobre la misma IP, y ahí sí se podría pasar del cupo. Se prefiere la ventana mixta,
  que limita de más y nunca de menos — la misma asimetría que el código ya eligió para el fallo de
  Redis.
- **Elegir el carril del limitador por método.** Parece lo natural y es la trampa: `lighter.ts`
  cancela por `call()`, el mismo método que usan las lecturas, pero con prioridad de escritura. Se
  elige **por prioridad**.

## La aritmética que sostiene los números

**Capacidad del depósito.** Un depósito de fichas con caudal `r` y capacidad `C` consume como mucho
`C + r·T` en cualquier ventana `T`. Con `r = cupo × 0,85 / 60` y `T = 60 s`:

```
C + cupo × 0,85 ≤ cupo   ⟺   C ≤ 0,15 × cupo
```

| Venue | Cupo/min | Caudal | Hoy | Nueva | Tope | Peor minuto |
|---|---|---|---|---|---|---|
| Hyperliquid | 1200 | 17/s | 34 | **102** | 180 | 1122 = 93,5 % |
| Lighter | 60 | 0,85/s | 1,7 | **5,1** | 9 | 56,1 = 93,5 % |
| Aster | 2400 | 34/s | 68 | **204** | 360 | 2244 = 93,5 % |

El tope teórico de `burstSeconds` es `60 × (1/0,85 − 1) = 10,6`. Se elige **6**, que deja margen
sobre el cupo real además del 15 % de `QUOTA_HEADROOM`, y con el que la serie de mil velas pasa de
necesitar el depósito entero a ocupar el 36 %.

**Ventana de estructura.** Las ventanas de muestreo son `⌊(N − ventanaCanal) / PASO_TASAS⌋`, y como
mucho sale una etiqueta por ventana y por par (setup, lado) porque `libreDesde` impide el solape.
Para las 61 muestras de MODERADA hacen falta `ventanaCanal + 8 × 61 = 584` con la ventana por
defecto; se toma `ventanaCanal + 8 × 70` = **656**, un 15 % por encima, porque 70 es el techo
teórico y en la práctica alguna ventana no da toque. Medido: con 640 velas salieron 67 muestras.

## Lo que no puede romperse

| # | Invariante | Cómo se preserva |
|---|---|---|
| I-1 | El consumo por IP y minuto nunca pasa del cupo publicado | Pasa a ser **demostrable** por test sobre los tres venues (CA-6) |
| I-2 | Lecturas, escrituras y críticas con sus reservas; una crítica no espera detrás de lecturas | Los suelos quedan idénticos, y encima se añade orden de cola por clase (CA-5) |
| I-3 | Dormir en vez de fallar (specs 020/031) | Se mantiene por defecto; la cota es opcional y solo para lecturas |
| I-4 | El presupuesto se pide ANTES del limitador | No se toca el orden: es lo que impide que una espera de presupuesto retenga la cola |
| I-5 | El orden de envío se conserva donde el nonce lo exige | Carril ordenado obligatorio para todo lo que firme (CA-8) |
| I-6 | Redis caído, se limita en memoria y nunca se deja de limitar | Se conserva; la cola se comparte con el respaldo |
| 6 | El stop loss es nativo del venue | Nada de este spec toca el camino del stop |

## Despliegue

**API y worker juntos**: comparten `crypton:budget:shared:<venue>` y un proceso viejo recorta el
depósito en cada refill. Durante la ventana mixta se limita de más, nunca de menos.

Vuelta atrás: R-9 y R-1 se revierten sin estado persistente; R-2 y R-3 exigen redesplegar los dos
procesos y el depósito se autoajusta en un `PEXPIRE` (60 s); R-4 se desactiva bajando
`VENUE_MAX_CONCURRENT_READS` a 1 **sin redesplegar código**, que es para lo que existe.
