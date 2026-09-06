# 027 — Plan

## Enfoque

Cambio solo de interfaz: ni la API, ni los paquetes, ni una sola orden. Dos commits, uno por asunto.

Decisiones de diseño tomadas aquí:

- **Hoja, no desplegable.** Elegida por el usuario frente a una lista bajo el campo: en el móvil el teclado
  tapa un desplegable dentro del formulario, y una hoja deja sitio para el precio y el cambio de cada par.
  Sin topes de altura, así Ionic la pinta a pantalla completa en el móvil y como tarjeta centrada en
  escritorio.
- **Fuera de `ion-content`.** El paso «Cuenta» vive dentro de `@if (step() === 'venue' && !busy())` y se
  destruye entero cuando el asistente recarga el catálogo. La hoja va al final de la plantilla, exactamente
  donde el detalle del bot y el gráfico ponen la de ajustar margen.
- **La hoja no guarda el par.** Emite `Market.symbol` y la página lo escribe en su señal, que sigue siendo
  la única fuente. Así los reinicios de fuera —cambiar de red, cambiar de conexión— siguen mandando, y un
  par que aún no está en el catálogo (llegando por enlace o copiando del ranking) no la confunde.
- **Instantánea de precios, no ticks en vivo.** `tickerMap()` se rehace cinco veces por segundo; con 546
  pares eso serían 546 filas repintadas a ese ritmo mientras alguien escribe. `tickers()` cambia una vez por
  minuto y para elegir un par sobra. Tampoco se declara ningún `watch`: en Mercados eso son 60 símbolos
  fijos, pero aquí cada tecla dispararía una petición.
- **Relevancia por encima del volumen.** Quien teclea «sol» quiere `SOL/USDC`, no el par con más volumen que
  contenga esas letras. La función es pura y está exportada, por si algún día se prueba.
- **El respaldo del capital usa la función compartida**, no una resta escrita en la app: es la misma regla
  que el servidor, y la app ya componía así el PnL total.

## Ficheros afectados

| Fichero | Qué cambia | Commit |
|---|---|---|
| `shared/ui/ui-pair-sheet.component.ts` | **nuevo**: la hoja, su buscador, el orden y la fila | `c2e150b` |
| `shared/ui/index.ts` | una línea | `c2e150b` |
| `features/bots/bot-create.page.html` | el disparador en lugar del `ion-select`; la hoja tras `</ion-content>` | `c2e150b` |
| `features/bots/bot-create.page.ts` | señal `pairOpen`, icono e imports | `c2e150b` |
| `global.scss` | `.pairbtn`, junto al tematizado de los campos | `c2e150b` |
| `features/bots/bots-list.page.{ts,scss}` | franja de totales; `capital(bot)` con respaldo | `4f45222` |
| `features/bots/bot-detail.page.{html,ts}` | `capital()` con el mismo respaldo | `4f45222` |

`bot-create.page.scss` no se toca: ya ocupa 10 293 bytes y el presupuesto por componente avisa a los 6 kB.

## Verificación

```bash
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm --filter app lint
pnpm --filter app build     # sin avisos de presupuesto
pnpm lint
```

Manual (CA-2): asistente → conexión de simulación de Aster → hoja con los más negociados arriba → escribir
`sol` → `SOL/USDC` primero → elegir → tope de apalancamiento, vista previa y creación igual que antes →
cambiar de conexión y comprobar que el par se limpia. Repetir en Hyperliquid y Lighter.
