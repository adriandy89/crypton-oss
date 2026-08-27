# Stack de Docker

**Dos ficheros separados, y la separación es lo importante.**

```
docker-compose.infra.yml    Postgres + Redis   ← aquí viven los DATOS
docker-compose.yml          migrate + API + worker   ← desechable
```

## Por qué están separados

Si estuviera todo en un solo compose, un `docker compose down` durante un
despliegue se llevaría por delante la base de datos, y un `down -v` destruiría
los volúmenes. Con dos proyectos de compose distintos, **desplegar la aplicación
es literalmente incapaz de tocar los datos**.

Comprobado: `docker compose -f docker-compose.yml down --volumes` —la forma más
destructiva— elimina API, worker y el job de migraciones, y deja Postgres y Redis
en pie con sus volúmenes intactos.

> **NUNCA ejecutes `down -v` sobre `docker-compose.infra.yml`** salvo que quieras
> borrar todas las credenciales de exchange y el histórico de los bots.

## Arranque

```bash
pnpm setup        # genera los .env con los secretos compartidos
pnpm infra:up     # 1. Postgres + Redis  (crea la red crypton-network)
pnpm prisma:deploy

pnpm stack:up     # 2. migraciones + API + worker
```

En desarrollo lo normal es quedarse en el paso 1 y correr la API y el worker en
el host, con recarga en caliente:

```bash
pnpm infra:up
pnpm api      # en una terminal
pnpm worker   # en otra
```

## Detalles que hay que conocer

**`depends_on` no cruza proyectos de compose.** El job de migraciones no puede
esperar al healthcheck de Postgres, así que espera por su cuenta con un bucle en
su `command`. La API y el worker sí dependen del job —están en el mismo
proyecto—, de modo que nunca arrancan contra un esquema desactualizado.

**Se usan los nombres de CONTENEDOR, no los de servicio.** Las cadenas de
conexión apuntan a `crypton-db` y `crypton-redis`. El nombre de servicio (`db`,
`redis`) solo es un alias fiable dentro de su propio proyecto; entre proyectos
que comparten red, el nombre de contenedor es el identificador inequívoco.

**Los volúmenes tienen nombre explícito** (`crypton-db-data`,
`crypton-redis-data`) en lugar del derivado del proyecto. Si algún día se
renombra el proyecto, un volumen derivado quedaría huérfano y arrancaría una base
vacía como si no hubiera pasado nada. Fijando el nombre, eso no puede ocurrir por
accidente.

**La red `crypton-network` la crea la infraestructura** y la aplicación la
consume como externa. Si no existe, el arranque falla con un mensaje claro en vez
de crear una red aislada donde los contenedores no verían la base de datos.

## Configuración

| Fichero | Para qué | Host de la BD |
|---|---|---|
| `docker/.env` | los dos composes | `crypton-db`, `crypton-redis` |
| `apps/api/.env` | API en el host | `localhost:5341` |
| `apps/worker/.env` | worker en el host | `localhost:5341` |

Dentro de la red de Docker cada contenedor tiene su propia interfaz, así que
`localhost` no apunta a Postgres. De ahí los dos juegos de ficheros.

`pnpm setup` genera los secretos **una vez** y los reparte. Es deliberado: la
clave maestra tiene que ser idéntica en la API y en el worker —una cifra, el otro
descifra— y hacerlo a mano falla en silencio. Si no coinciden, ningún bot arranca
y el error no señala la causa.

En el stack, la clave maestra y los secretos JWT se declaran una sola vez en
`docker/.env` y el compose los inyecta a los dos servicios, lo que garantiza por
construcción que coincidan.

```bash
pnpm check:env
```

Cruza tres fuentes —lo que el código lee, lo que declaran los `.env.example` y lo
que el compose inyecta— y falla si falta alguna. Una variable sin definir no
rompe la compilación ni los tests: rompe en producción, con el valor por defecto
aplicado en silencio.

## Puertos

No son los estándar a propósito: así conviven con otros stacks en la misma
máquina.

| Servicio | Host | Contenedor |
|---|---|---|
| Postgres | 5341 | 5432 |
| Redis | 6381 | 6379 |
| API | 3200 | 3200 |
| Cliente web | 8100 | 8080 |

El worker **no publica ningún puerto**: no expone HTTP. Habla con la API a través
de Postgres y del bus de Redis, nada más.

## Cliente web

El servicio `app` es la **misma aplicación que la de Android** —el mismo código
Angular/Ionic— compilada para navegador y servida por nginx. La interfaz es de
móvil y esa vista manda, pero el contenido se centra y se limita en pantallas
grandes, así que en un monitor se ve como una aplicación de escritorio y no como
un móvil estirado.

nginx hace además de **proxy de `/api` hacia la API**, y eso no es un detalle de
comodidad:

- Navegador y API quedan en el **mismo origen**, así que no hay CORS que
  configurar ni que mantener sincronizado con cada dominio nuevo.
- La URL de la API va **relativa** dentro del bundle
  (`apps/app/src/environments/environment.docker.ts`), así que **cambiar el
  dominio del despliegue no obliga a reconstruir la imagen**.
- El flujo de eventos del motor (`/api/v1/bots/stream`, que es SSE) tiene su
  propio bloque **sin buffering y sin timeout de lectura**: con la configuración
  normal de proxy los eventos llegarían a tirones y la conexión se cortaría sola.

### Dos cosas que hay que configurar bien

1. **HTTPS es obligatorio.** La entrada con Google usa PKCE, que se apoya en
   `crypto.subtle`, y el navegador solo lo expone en contexto seguro. Por HTTP
   plano —salvo en `localhost`— el botón de entrar no funciona. Pon el
   contenedor detrás de un proxy con TLS.
2. **`APP_REDIRECT_WEB` tiene que apuntar a este servicio**, a su
   `/auth/callback` público. Es a donde la API manda al usuario de vuelta al
   terminar con Google; si apunta a otro sitio, el acceso se queda a medias.

La imagen no lleva Prisma ni el proyecto de Android: solo los estáticos
compilados sobre `nginx-unprivileged`, que corre como usuario sin privilegios y
escucha en el 8080.

## Comandos

```bash
pnpm infra:up      # Postgres + Redis
pnpm infra:down    # los para SIN borrar volúmenes
pnpm infra:logs

pnpm stack:up      # migraciones + API + worker, reconstruyendo imágenes
pnpm stack:down    # seguro: no toca los datos
pnpm stack:logs    # solo api y worker
```

## Otros detalles

**`stop_grace_period: 45s` en el worker.** Al recibir SIGTERM cierra los runners
de forma ordenada y libera sus leases, lo que acorta el relevo cuando otro worker
los adopta. Matarlo de golpe también funciona —el lease caduca solo— pero obliga
a esperar el TTL completo.

**Los Dockerfiles instalan en dos pasadas.** La primera con `--ignore-scripts`
(solo hay manifiestos, y el postinstall de `@crypton/db` necesita el esquema); la
segunda con scripts, ya con las fuentes copiadas. Hace falta porque Prisma
produce su ejecutable en su propio postinstall, y porque `koffi` —el firmante
nativo de Lighter— compila ahí su binding: sin eso, la firma de órdenes falla en
tiempo de **ejecución**, no al instalar.

**Ambos procesos corren como `node`, sin privilegios.** Descifran credenciales de
firma; ejecutarlos como root ampliaría sin motivo lo que un fallo podría
alcanzar.
