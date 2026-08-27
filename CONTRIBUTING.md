# Contribuir

Gracias por pasarte. Este documento es corto a propósito: lo que no está aquí,
pregúntalo abriendo una *issue*.

## Antes de escribir código

Abre una *issue* describiendo el problema antes de mandar un *pull request*
grande. Un parche de tres líneas no necesita ceremonia; un adaptador de venue
nuevo o un cambio en el motor de reconciliación sí, porque puede que ya haya una
razón para que las cosas estén como están.

## Arrancar el proyecto

```bash
pnpm install
pnpm setup            # genera los .env con secretos nuevos
pnpm infra:up         # Postgres + Redis
pnpm prisma:deploy
pnpm build:packages
```

Los detalles y lo que hay que rellenar a mano —las credenciales de Google— están
en el [README](README.md).

## Lo que se espera de un cambio

```bash
pnpm test        # tiene que quedar en verde: 4.916 tests
pnpm -r build    # tiene que compilar entero, sin errores de tsc
pnpm lint
```

Los dos primeros son la barra. Si tocas `packages/strategy-core` o
`packages/exchange-core`, acompaña el cambio de tests: son las dos piezas donde
un fallo se traduce directamente en dinero perdido.

**Sobre `pnpm lint`, con honestidad:** hoy solo está configurado en `apps/api`, y
ahí deja unos 100 avisos de tipos heredados que nadie ha limpiado todavía. La
app, el worker y los paquetes nunca llegaron a tener `eslint.config`, y sus
scripts lo dicen en voz alta en vez de fingir que pasan. Así que el criterio no
es «lint en verde», es **no añadir avisos nuevos**. Dejarlo bien configurado y
limpio es una contribución en sí misma —el worker suelta unos 160 a la primera—
y va mejor separada de cualquier cambio funcional.

Ojo: `pnpm lint` corre con `--fix` y **modifica ficheros**. Míralo con `git diff`
antes de dar nada por bueno.

**Los comentarios explican el porqué, no el qué.** El código de este repositorio
está comentado en castellano y con esa regla; sigue el estilo de lo que haya
alrededor del sitio que toques.

## Estrategias y adaptadores

- Las estrategias de `packages/strategy-core` son **funciones puras**:
  `validate()`, `preview()` y `plan()`. No hacen E/S, no leen la hora ni el
  azar. Si tu estrategia necesita alguna de esas cosas, el diseño está mal.
- Los adaptadores de `packages/exchange-core` van detrás de una interfaz única.
  Un adaptador nuevo tiene que pasar por el mismo contrato que los demás y traer
  su simulador.

## Seguridad

Los fallos de seguridad **no** van en una *issue* pública: mira
[SECURITY.md](SECURITY.md).

## Licencia

Al contribuir aceptas que tu código se publique bajo la
[AGPL-3.0](LICENSE), igual que el resto del proyecto.
