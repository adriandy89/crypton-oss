import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CacheService, DbService } from '../src/libs';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/modules/auth';
import type { Role } from '@crypton/db';

/**
 * Aislamiento entre usuarios.
 *
 * Esta es la batería que faltaba. Los 154 tests anteriores son de lógica pura
 * —estrategias, escalera, cifrado, códec— y ninguno comprobaba lo único que de
 * verdad no puede fallar en una plataforma que custodia claves de firma: que
 * los datos de un usuario no lleguen a otro.
 *
 * Se levanta la aplicación de verdad contra Postgres y Redis, se crean DOS
 * usuarios y se recorre cada ruta que acepta un `:id` comprobando que el
 * segundo no alcanza nada del primero.
 *
 * Criterio de respuesta esperada: **404, no 403**. Un 403 confirmaría que el
 * recurso existe, que es justo lo que no se quiere decir. Es el mismo criterio
 * que aplica `mustOwn` en los servicios.
 *
 * Necesita infraestructura: `pnpm infra:up` antes de ejecutar.
 */

const PREFIX = '/api/v1';

interface Actor {
  email: string;
  token: string;
  /** Hace falta para probar que revocar cierra TAMBIEN el refresco. */
  refreshToken: string;
  id: string;
}

describe('Aislamiento entre usuarios (e2e)', () => {
  let app: INestApplication;
  let db: DbService;
  let tokens: TokenService;
  let alicia: Actor;
  let bruno: Actor;
  /** Una administradora de verdad: es lo unico que abre la consola. */
  let admin: Actor;
  /**
   * Un usuario de usar y tirar, para las pruebas que DESHABILITAN una cuenta.
   *
   * No se usa a bruno: dejarlo deshabilitado a mitad de fichero convertiria los
   * 404 que esperan los bloques siguientes en 401, y el fallo apuntaria a
   * cualquier sitio menos a la causa.
   */
  let victima: Actor;

  /** Sufijo único por ejecución: la suite no puede chocar consigo misma. */
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const http = () => request(app.getHttpServer());

  /**
   * Crea un usuario y le emite una sesión, sin pasar por Google.
   *
   * El alta real exige un viaje de ida y vuelta a accounts.google.com, que ni
   * puede ni debe ocurrir dentro de una suite: haría falta una cuenta de verdad
   * y una persona tecleando una contraseña. Lo que aquí se prueba es el
   * aislamiento entre usuarios, no el protocolo, así que se inserta la fila y
   * se firma el par de tokens con el mismo servicio que usa el flujo de verdad.
   * Lo que sí se comprueba del acceso con Google está más abajo, en su bloque.
   */
  async function crearUsuario(nombre: string, role: Role = 'USER'): Promise<Actor> {
    const email = `${nombre}-${stamp}@crypton.test`;
    const user = await db.user.create({
      data: {
        email,
        name: nombre,
        // Identidad de Google simulada, única por ejecución.
        google_sub: `test-${nombre}-${stamp}`,
        is_email_verified: true,
        role,
        risk_limit: {
          create: {
            max_leverage: 10,
            max_open_bots: 5,
            kill_switch_drawdown_pct: 30,
            liquidation_alert_pct: 10,
          },
        },
      },
    });

    const par = await tokens.issuePair({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      language: user.language,
    });

    return { email, token: par.accessToken, refreshToken: par.refreshToken, id: user.id };
  }

  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Misma configuración que producción. Sin el pipe, `forbidNonWhitelisted`
    // no actuaría y la suite validaría respuestas que nadie llega a recibir.
    //
    // El filtro de excepciones YA NO se registra aquí: viene de `AppModule` por
    // `APP_FILTER`. Añadirlo a mano lo ejecutaría dos veces.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    db = app.get(DbService);
    tokens = app.get(TokenService);
    alicia = await crearUsuario('alicia');
    bruno = await crearUsuario('bruno');
    admin = await crearUsuario('admin', 'ADMIN');
    victima = await crearUsuario('victima');
  }, 60_000);

  afterAll(async () => {
    // Se limpia por email para no tocar datos ajenos a la suite. Las cascadas
    // del esquema se llevan bots, credenciales, límites y vinculaciones.
    await db.user
      .deleteMany({
        where: {
          email: {
            in: [alicia?.email, bruno?.email, admin?.email, victima?.email].filter(Boolean),
          },
        },
      })
      .catch(() => undefined);

    // Las marcas de revocacion viven en un Redis compartido y sobreviven a la
    // suite: sin esto, dos ejecuciones seguidas se pisan.
    const cache = app?.get(CacheService);
    for (const actor of [alicia, bruno, admin, victima]) {
      if (actor) await cache?.del(`auth:revoked:${actor.id}`).catch(() => undefined);
    }
    await app?.close();
  });

  it('crea dos usuarios distintos', () => {
    expect(alicia.id).toBeTruthy();
    expect(bruno.id).toBeTruthy();
    expect(alicia.id).not.toBe(bruno.id);
  });

  /**
   * La consola de administracion (spec 033).
   *
   * OJO, porque contradice EN APARIENCIA la cabecera de este fichero: aqui se
   * espera 403 y no 404. El criterio de «404, nunca 403» existe para no
   * confirmar la existencia de un recurso ajeno, y sigue vigente en todo lo de
   * arriba. En `/admin/*` el `RolesGuard` deniega ANTES de mirar el `:id`: el
   * 403 solo dice «esta ruta es de administracion», que ya lo dice su nombre, y
   * no revela ninguna fila. Un ADMIN con un id inexistente si recibe 404.
   *
   * Que nadie lo «corrija» a 404 sin leer esto.
   */
  describe('administracion', () => {
    let botDeAlicia: string;

    beforeAll(async () => {
      const cuenta = await db.exchangeAccount.create({
        data: {
          user_id: alicia.id,
          venue: 'HYPERLIQUID',
          label: 'para-admin',
          status: 'VERIFIED',
          public_ref: '0xalicia-admin',
          enc_payload: 'SECRETO-QUE-NO-PUEDE-SALIR',
          enc_dek: 'DEK-QUE-NO-PUEDE-SALIR',
          enc_iv: 'x',
          enc_tag: 'x',
          enc_key_id: 'v1',
        },
      });
      // En RUNNING: los comandos de contencion solo valen sobre un bot que el
      // motor tenga en la mano. Nadie lo ejecuta — en la suite no hay worker.
      const bot = await db.bot.create({
        data: {
          user_id: alicia.id,
          exchange_account_id: cuenta.id,
          name: 'bot-vivo-de-alicia',
          venue: 'HYPERLIQUID',
          symbol: 'ETH',
          strategy: 'GRID_CLASSIC',
          direction: 'LONG',
          margin_mode: 'CROSS',
          leverage: 2,
          status: 'RUNNING',
          dry_run: true,
          config_version: 1,
        },
      });
      botDeAlicia = bot.id;
    });

    const superficie: [metodo: 'get' | 'post', ruta: string][] = [
      ['get', '/admin/users'],
      ['get', '/admin/users/00000000-0000-0000-0000-000000000000'],
      ['post', '/admin/users/00000000-0000-0000-0000-000000000000/disable'],
      ['post', '/admin/users/00000000-0000-0000-0000-000000000000/enable'],
      ['post', '/admin/users/00000000-0000-0000-0000-000000000000/sessions/revoke'],
      ['get', '/admin/bots'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/orders'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/fills'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/cycles'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/events'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/revisions'],
      ['get', '/admin/bots/00000000-0000-0000-0000-000000000000/levels'],
      ['post', '/admin/bots/00000000-0000-0000-0000-000000000000/commands'],
      ['get', '/admin/maintenance'],
      ['post', '/admin/maintenance/preview'],
      ['post', '/admin/maintenance/purge'],
    ];

    it.each(superficie)('un usuario normal recibe 403 en %s %s', async (metodo, ruta) => {
      await http()[metodo](`${PREFIX}${ruta}`).set(as(bruno)).expect(403);
    });

    it.each(superficie)('sin token, %s %s es 401', async (metodo, ruta) => {
      await http()[metodo](`${PREFIX}${ruta}`).expect(401);
    });

    it('la administradora ve a los demas usuarios', async () => {
      const res = await http()
        .get(`${PREFIX}/admin/users`)
        .query({ q: `alicia-${stamp}`, limit: 10 })
        .set(as(admin))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ email: alicia.email, disabled: false });
      expect(res.body.meta).toMatchObject({ page: 1, hasPreviousPage: false });
    });

    it('y NADA de lo que no debe verse', async () => {
      const res = await http().get(`${PREFIX}/admin/users/${alicia.id}`).set(as(admin)).expect(200);

      const json = JSON.stringify(res.body);
      for (const prohibido of [
        'SECRETO-QUE-NO-PUEDE-SALIR',
        'DEK-QUE-NO-PUEDE-SALIR',
        'google_sub',
        `test-alicia-${stamp}`,
      ]) {
        expect(json).not.toContain(prohibido);
      }
      // Y lo que si, para que el test no pase por estar vacio.
      expect(json).toContain(alicia.email);
    });

    /**
     * La prueba de que la consola CRUZA usuarios. El bloque de arriba sigue
     * comprobando que bruno no alcanza el bot de alicia; este comprueba que la
     * administradora si, que es justo para lo que existe.
     */
    it('el listado global de bots incluye los de otra persona', async () => {
      const res = await http()
        .get(`${PREFIX}/admin/bots`)
        .query({ userId: alicia.id, limit: 50 })
        .set(as(admin))
        .expect(200);

      const ids = (res.body.data as { id: string }[]).map((b) => b.id);
      expect(ids).toContain(botDeAlicia);
      expect(res.body.data[0].owner.email).toBe(alicia.email);
      // El dinero viaja como cadena, nunca como numero (invariante 1).
      expect(typeof res.body.data[0].totalInvestment).toBe('string');
    });

    it('un id que no existe si es 404, aun siendo administradora', async () => {
      await http()
        .get(`${PREFIX}/admin/bots/00000000-0000-0000-0000-000000000000`)
        .set(as(admin))
        .expect(404);
    });

    describe('contener un bot ajeno', () => {
      const PROHIBIDOS = [
        'PANIC',
        'STOP_AND_CLOSE',
        'CLOSE_NOW',
        'CANCEL_ALL_ORDERS',
        'START',
        'ADJUST_MARGIN',
        'REPAIR',
      ];

      it.each(PROHIBIDOS)('%s se rechaza y no deja rastro en la bandeja', async (command) => {
        // 400 y no 403: lo para el `@IsIn` del DTO antes de llegar al servicio.
        // Que la puerta de fuera sea la del validador es exactamente lo que se
        // quiere; la del servicio esta debajo, y la prueba su propio spec.
        await http()
          .post(`${PREFIX}/admin/bots/${botDeAlicia}/commands`)
          .set(as(admin))
          .send({ command, reason: 'probando lo que no se puede' })
          .expect(400);

        const encolados = await db.botCommand.count({ where: { bot_id: botDeAlicia, command } });
        expect(encolados).toBe(0);
      });

      it('sin motivo no se acepta ni un comando permitido', async () => {
        await http()
          .post(`${PREFIX}/admin/bots/${botDeAlicia}/commands`)
          .set(as(admin))
          .send({ command: 'PAUSE' })
          .expect(400);
      });

      it('PAUSE se encola a nombre de la ADMINISTRADORA, no de la dueña', async () => {
        await http()
          .post(`${PREFIX}/admin/bots/${botDeAlicia}/commands`)
          .set(as(admin))
          .send({ command: 'PAUSE', reason: 'lleva media hora en error' })
          .expect(200);

        const fila = await db.botCommand.findFirst({
          where: { bot_id: botDeAlicia, command: 'PAUSE' },
          orderBy: { created_at: 'desc' },
        });
        // Poner aqui a la dueña seria falsificar la trazabilidad justo en la
        // fila que existe para investigar quien toco que.
        expect(fila?.requested_by).toBe(admin.id);
        expect(fila?.requested_by).not.toBe(alicia.id);

        const evento = await db.botEvent.findFirst({
          where: { bot_id: botDeAlicia, type: 'COMMAND_PAUSE' },
          orderBy: { created_at: 'desc' },
        });
        // La dueña tiene que poder ver en SU bitacora que vino de fuera.
        expect(evento?.severity).toBe('WARN');
        expect(evento?.message).toContain('soporte');
      });
    });

    describe('purga de historicos', () => {
      it('el estado dice que hay guardado y con que reglas', async () => {
        const res = await http().get(`${PREFIX}/admin/maintenance`).set(as(admin)).expect(200);

        const ambitos = res.body.ambitos as { scope: string; sueloDias: number }[];
        expect(ambitos.map((a) => a.scope)).toEqual(
          expect.arrayContaining(['BOT_SNAPSHOTS', 'ACTIVITY_LOG', 'BACKTESTS']),
        );
        // La bitacora es la unica con suelo alto.
        expect(ambitos.find((a) => a.scope === 'ACTIVITY_LOG')?.sueloDias).toBe(90);
      });

      it('contar no borra', async () => {
        const antes = await db.botSnapshot.count();

        await http()
          .post(`${PREFIX}/admin/maintenance/preview`)
          .set(as(admin))
          .send({ scope: 'BOT_SNAPSHOTS', days: 15 })
          .expect(200);

        expect(await db.botSnapshot.count()).toBe(antes);
      });

      it('la bitacora no se puede purgar por debajo de su suelo', async () => {
        const antes = await db.activityLog.count();

        // 30 esta en la lista del DTO, asi que llega al servicio: lo para el
        // suelo, que es justo lo que este test vigila.
        await http()
          .post(`${PREFIX}/admin/maintenance/purge`)
          .set(as(admin))
          .send({ scope: 'ACTIVITY_LOG', days: 30, reason: 'a ver si cuela' })
          .expect(400);

        expect(await db.activityLog.count()).toBe(antes);
      });

      it('una antiguedad fuera de la lista es 400', async () => {
        await http()
          .post(`${PREFIX}/admin/maintenance/purge`)
          .set(as(admin))
          .send({ scope: 'BOT_SNAPSHOTS', days: 1, reason: 'ni de broma' })
          .expect(400);
      });

      it('un ambito inventado es 400', async () => {
        await http()
          .post(`${PREFIX}/admin/maintenance/purge`)
          .set(as(admin))
          .send({ scope: 'BOT_ORDERS', days: 180, reason: 'las ordenes no se tocan' })
          .expect(400);
      });

      it('sin motivo no se purga', async () => {
        await http()
          .post(`${PREFIX}/admin/maintenance/purge`)
          .set(as(admin))
          .send({ scope: 'BOT_SNAPSHOTS', days: 180 })
          .expect(400);
      });

      /**
       * Lo que este bloque de verdad defiende: el bot de alicia esta RUNNING, asi
       * que ni sus snapshots ni sus eventos pueden entrar en una purga por mucho
       * que se pida la antiguedad mas agresiva.
       */
      it('los datos de un bot EN MARCHA sobreviven a la purga mas agresiva', async () => {
        await db.botSnapshot.create({
          data: {
            bot_id: botDeAlicia,
            taken_at: new Date('2020-01-01T00:00:00Z'),
            equity: '100',
            position_qty: '0',
            mark_price: '1',
            unrealized_pnl: '0',
            realized_pnl_acc: '0',
            margin_used: '0',
            open_orders: 0,
          },
        });

        const previo = await http()
          .post(`${PREFIX}/admin/maintenance/preview`)
          .set(as(admin))
          .send({ scope: 'BOT_SNAPSHOTS', days: 15 })
          .expect(200);
        const purgables = previo.body.filas as number;

        await http()
          .post(`${PREFIX}/admin/maintenance/purge`)
          .set(as(admin))
          .send({ scope: 'BOT_SNAPSHOTS', days: 15, reason: 'limpieza de prueba' })
          .expect(200);

        // La fila de 2020 sigue ahi: su bot esta vivo.
        expect(await db.botSnapshot.count({ where: { bot_id: botDeAlicia } })).toBeGreaterThan(0);
        expect(purgables).toBeGreaterThanOrEqual(0);
      });
    });

    describe('el rol no se toca desde aqui', () => {
      it('no hay PATCH sobre una cuenta', async () => {
        await http().patch(`${PREFIX}/admin/users/${bruno.id}`).set(as(admin)).send({}).expect(404);
      });

      it('no hay ruta para cambiar el rol', async () => {
        await http()
          .post(`${PREFIX}/admin/users/${bruno.id}/role`)
          .set(as(admin))
          .send({ role: 'ADMIN' })
          .expect(404);
      });

      it('y colar `role` en el cuerpo de una accion es 400', async () => {
        await http()
          .post(`${PREFIX}/admin/users/${bruno.id}/disable`)
          .set(as(admin))
          .send({ reason: 'da igual', role: 'ADMIN' })
          .expect(400);
      });

      it('un parametro de consulta no declarado tambien es 400', async () => {
        await http().get(`${PREFIX}/admin/users`).query({ foo: '1' }).set(as(admin)).expect(400);
      });
    });

    describe('deshabilitar corta la sesion en el acto', () => {
      it('el MISMO token que valia deja de valer', async () => {
        // Antes: bruno opera con normalidad.
        await http().get(`${PREFIX}/bots`).set(as(victima)).expect(200);

        await http()
          .post(`${PREFIX}/admin/users/${victima.id}/disable`)
          .set(as(admin))
          .send({ reason: 'cuenta comprometida' })
          .expect(200);

        // Despues: el mismo token, sin esperar a que caduque.
        await http().get(`${PREFIX}/bots`).set(as(victima)).expect(401);

        // Y tampoco puede renovar: el cierre es completo, no solo del acceso.
        await http()
          .post(`${PREFIX}/auth/refresh`)
          .send({ refreshToken: victima.refreshToken })
          .expect(401);

        expect((await db.user.findUnique({ where: { id: victima.id } }))?.disabled).toBe(true);
      });

      it('rehabilitar levanta la marca y un token nuevo vuelve a valer', async () => {
        await http().post(`${PREFIX}/admin/users/${victima.id}/enable`).set(as(admin)).expect(200);

        const par = await tokens.issuePair({
          id: victima.id,
          email: victima.email,
          name: 'victima',
          role: 'USER',
          language: 'es',
        });
        await http()
          .get(`${PREFIX}/bots`)
          .set({ Authorization: `Bearer ${par.accessToken}` })
          .expect(200);
      });

      it('la administradora no puede deshabilitarse a si misma', async () => {
        await http()
          .post(`${PREFIX}/admin/users/${admin.id}/disable`)
          .set(as(admin))
          .send({ reason: 'a ver que pasa' })
          .expect(409);

        // Y sigue dentro.
        await http().get(`${PREFIX}/admin/users`).set(as(admin)).expect(200);
      });
    });
  });

  describe('bots', () => {
    let botDeAlicia: string;

    beforeAll(async () => {
      // Se inserta directamente: crear un bot por API exige credencial de
      // exchange verificada contra el venue, y lo que se prueba aquí es el
      // control de acceso, no el alta.
      const cuenta = await db.exchangeAccount.create({
        data: {
          user_id: alicia.id,
          venue: 'HYPERLIQUID',
          label: 'de-alicia',
          status: 'VERIFIED',
          public_ref: '0xalicia',
          enc_payload: 'x',
          enc_dek: 'x',
          enc_iv: 'x',
          enc_tag: 'x',
          enc_key_id: 'v1',
        },
      });
      const bot = await db.bot.create({
        data: {
          user_id: alicia.id,
          exchange_account_id: cuenta.id,
          name: 'bot-privado-de-alicia',
          venue: 'HYPERLIQUID',
          symbol: 'BTC',
          strategy: 'GRID_CLASSIC',
          direction: 'LONG',
          margin_mode: 'CROSS',
          leverage: 2,
          status: 'STOPPED',
          config_version: 1,
        },
      });
      botDeAlicia = bot.id;
    });

    const rutasDeLectura = ['', '/levels', '/orders', '/fills', '/cycles', '/events', '/snapshots'];

    it.each(rutasDeLectura)('bruno no puede leer /bots/:id%s de alicia', async (sufijo) => {
      await http().get(`${PREFIX}/bots/${botDeAlicia}${sufijo}`).set(as(bruno)).expect(404);
    });

    it('alicia sí puede leer su propio bot', async () => {
      const res = await http().get(`${PREFIX}/bots/${botDeAlicia}`).set(as(alicia)).expect(200);
      expect(res.body.name).toBe('bot-privado-de-alicia');
    });

    it('bruno no puede renombrar el bot de alicia', async () => {
      await http()
        .patch(`${PREFIX}/bots/${botDeAlicia}`)
        .set(as(bruno))
        .send({ name: 'secuestrado' })
        .expect(404);

      const sigue = await db.bot.findUnique({ where: { id: botDeAlicia } });
      expect(sigue?.name).toBe('bot-privado-de-alicia');
    });

    it('bruno no puede mandar comandos al bot de alicia', async () => {
      await http()
        .post(`${PREFIX}/bots/${botDeAlicia}/commands`)
        .set(as(bruno))
        .send({ command: 'PANIC', confirm: true })
        .expect(404);
    });

    it('bruno no puede cambiar la configuración del bot de alicia', async () => {
      await http()
        .patch(`${PREFIX}/bots/${botDeAlicia}/config`)
        .set(as(bruno))
        .send({ config: { takeProfitPct: 99 } })
        .expect(404);
    });

    it('bruno no puede borrar el bot de alicia', async () => {
      await http().delete(`${PREFIX}/bots/${botDeAlicia}`).set(as(bruno)).expect(404);
      expect(await db.bot.findUnique({ where: { id: botDeAlicia } })).not.toBeNull();
    });

    it('el listado de bruno no incluye bots de alicia', async () => {
      const res = await http().get(`${PREFIX}/bots`).set(as(bruno)).expect(200);
      const ids = (res.body as { id: string }[]).map((b) => b.id);
      expect(ids).not.toContain(botDeAlicia);
    });

    it('no se puede colar un user_id por el cuerpo de la petición', async () => {
      // `forbidNonWhitelisted` debe rechazar la propiedad, no ignorarla en
      // silencio: ignorarla dejaría la puerta abierta a que algún DTO futuro
      // sí la aceptara sin que nadie se diera cuenta.
      await http()
        .patch(`${PREFIX}/bots/${botDeAlicia}`)
        .set(as(alicia))
        .send({ name: 'nombre', user_id: bruno.id })
        .expect(400);
    });
  });

  describe('credenciales de exchange', () => {
    let cuentaDeAlicia: string;

    beforeAll(async () => {
      const cuenta = await db.exchangeAccount.create({
        data: {
          user_id: alicia.id,
          venue: 'ASTER',
          label: 'secreta-de-alicia',
          status: 'VERIFIED',
          public_ref: '0xsecreto',
          enc_payload: 'x',
          enc_dek: 'x',
          enc_iv: 'x',
          enc_tag: 'x',
          enc_key_id: 'v1',
        },
      });
      cuentaDeAlicia = cuenta.id;

      // El mercado tiene que existir para que el preview llegue a pedir un
      // precio de referencia, que es donde vivía el fallo. Sin esta fila el
      // preview se corta antes con un 404 de mercado desconocido y el test no
      // probaría nada.
      await db.market.upsert({
        where: {
          venue_testnet_symbol: {
            venue: 'ASTER',
            testnet: false,
            symbol: 'BTCUSDT',
          },
        },
        update: {},
        create: {
          venue: 'ASTER',
          symbol: 'BTCUSDT',
          canonical: 'BTC',
          base: 'BTC',
          quote: 'USDT',
          tick_size: '0.1',
          step_size: '0.001',
          min_notional: '5',
          max_leverage: 50,
          price_decimals: 1,
          qty_decimals: 3,
        },
      });
    });

    it('el listado de bruno no ve la credencial de alicia', async () => {
      const res = await http().get(`${PREFIX}/exchange-accounts`).set(as(bruno)).expect(200);
      const ids = (res.body as { id: string }[]).map((c) => c.id);
      expect(ids).not.toContain(cuentaDeAlicia);
    });

    it('ninguna respuesta expone el sobre cifrado', async () => {
      const res = await http().get(`${PREFIX}/exchange-accounts`).set(as(alicia)).expect(200);
      const serializado = JSON.stringify(res.body);
      for (const campo of ['encPayload', 'enc_payload', 'encDek', 'enc_dek', 'encTag', 'enc_iv']) {
        expect(serializado).not.toContain(campo);
      }
    });

    it('bruno no puede reverificar ni borrar la credencial de alicia', async () => {
      await http()
        .post(`${PREFIX}/exchange-accounts/${cuentaDeAlicia}/verify`)
        .set(as(bruno))
        .expect(404);
      await http()
        .delete(`${PREFIX}/exchange-accounts/${cuentaDeAlicia}`)
        .set(as(bruno))
        .expect(404);
      expect(await db.exchangeAccount.findUnique({ where: { id: cuentaDeAlicia } })).not.toBeNull();
    });

    /**
     * El fallo C-1, convertido en test.
     *
     * `POST /bots/preview` no comprueba propiedad de nada: recibe venue y
     * símbolo. Antes, al faltarle un precio de referencia, buscaba «cualquier
     * cuenta verificada de ese venue» y descifraba su clave privada — la de un
     * tercero elegible cambiando el venue. Ahora solo puede usar una cuenta
     * propia, así que bruno, que no tiene ninguna en ASTER, recibe un 403 con
     * el motivo, en vez de provocar el descifrado de la clave de alicia.
     */
    it('el preview no toma prestada la credencial de otro usuario', async () => {
      const res = await http()
        .post(`${PREFIX}/bots/preview`)
        .set(as(bruno))
        .send({
          venue: 'ASTER',
          symbol: 'BTCUSDT',
          strategy: 'GRID_CLASSIC',
          config: {
            direction: 'LONG',
            leverage: 2,
            marginMode: 'CROSS',
            totalInvestment: '100',
            lowerPrice: '90000',
            upperPrice: '110000',
            gridLevels: 5,
            gridSpacing: 'ARITHMETIC',
            sizingMode: 'QUOTE',
          },
        });

      // Lo que NO puede pasar es un 200 servido con la credencial de alicia.
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
      // Y el motivo debe ser que BRUNO no tiene conexión propia en ese venue,
      // no cualquier otro error que enmascare el problema.
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/conexión verificada/i);
    });
  });

  describe('riesgo y telegram', () => {
    it('cada usuario ve SUS límites de riesgo', async () => {
      await http()
        .patch(`${PREFIX}/risk/limits`)
        .set(as(alicia))
        .send({ maxLeverage: '7' })
        .expect(200);

      const deBruno = await http().get(`${PREFIX}/risk/limits`).set(as(bruno)).expect(200);
      expect(String(deBruno.body.maxLeverage ?? '')).not.toBe('7');
    });

    it('el kill-switch de bruno no toca los bots de alicia', async () => {
      const antes = await db.bot.findMany({
        where: { user_id: alicia.id },
        select: { status: true },
      });
      await http().post(`${PREFIX}/risk/kill-switch`).set(as(bruno)).expect(200);
      const despues = await db.bot.findMany({
        where: { user_id: alicia.id },
        select: { status: true },
      });
      expect(despues.map((b) => b.status)).toEqual(antes.map((b) => b.status));
    });

    it('el código de Telegram nace con caducidad', async () => {
      // Lo que se comprueba es que NUNCA se emite un código sin fecha de
      // caducidad: un código eterno es una puerta abierta indefinidamente.
      const res = await http().post(`${PREFIX}/telegram/link`).set(as(alicia)).send({});

      expect([200, 201]).toContain(res.status);

      const link = await db.telegramLink.findUnique({
        where: { user_id: alicia.id },
      });
      expect(link?.link_code).toBeTruthy();
      expect(link?.link_code_expires_at).toBeInstanceOf(Date);
      expect(link!.link_code_expires_at!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('perfil y reautenticación', () => {
    it('cada usuario lee SU perfil, nunca el de otro', async () => {
      const deAlicia = await http().get(`${PREFIX}/users/me`).set(as(alicia)).expect(200);
      const deBruno = await http().get(`${PREFIX}/users/me`).set(as(bruno)).expect(200);

      expect(deAlicia.body.email).toBe(alicia.email);
      expect(deBruno.body.email).toBe(bruno.email);
      expect(deAlicia.body.id).not.toBe(deBruno.body.id);
    });

    it('el perfil no devuelve la identidad de Google ni restos de credenciales', async () => {
      const res = await http().get(`${PREFIX}/users/me`).set(as(alicia)).expect(200);
      const serializado = JSON.stringify(res.body);
      // `google_sub` identifica la cuenta ante Google: ninguna pantalla lo
      // necesita, así que no debe salir de la base de datos. Los otros tres son
      // columnas que ya no existen; si reaparecen, alguien las ha vuelto a
      // meter y este test lo dirá.
      for (const campo of ['google_sub', 'googleSub', 'password', 'totp']) {
        expect(serializado).not.toContain(campo);
      }
    });

    it('actualizar el perfil no permite tocar el rol ni el id', async () => {
      // `forbidNonWhitelisted` debe rechazarlo: un DTO que aceptara `role`
      // sería una escalada de privilegios en una línea.
      await http()
        .patch(`${PREFIX}/users/me`)
        .set(as(bruno))
        .send({ name: 'Bruno', role: 'ADMIN' })
        .expect(400);

      const res = await http().get(`${PREFIX}/users/me`).set(as(bruno)).expect(200);
      expect(res.body.role).toBe('USER');
    });

    it('guarda los campos de perfil que sí son suyos', async () => {
      const res = await http()
        .patch(`${PREFIX}/users/me`)
        .set(as(bruno))
        .send({
          bio: 'Opero rejillas',
          country: 'es',
          timezone: 'Europe/Madrid',
        })
        .expect(200);

      expect(res.body.bio).toBe('Opero rejillas');
      // El país se normaliza a mayúsculas.
      expect(res.body.country).toBe('ES');
      expect(res.body.timezone).toBe('Europe/Madrid');
    });

    it('conectar un exchange exige reautenticación', async () => {
      // Sin `password` ni `code`, la API debe rechazarlo antes de tocar nada:
      // un token robado no puede bastar para conectar una clave de firma.
      const res = await http()
        .post(`${PREFIX}/exchange-accounts`)
        .set(as(bruno))
        .send({
          venue: 'HYPERLIQUID',
          label: 'intruso',
          // Con forma válida a propósito: si el DTO la rechazara, la petición
          // ni llegaría al control de reautenticación y el test no probaría
          // lo que dice probar.
          hyperliquid: {
            accountAddress: '0x' + 'a'.repeat(40),
            agentPrivateKey: '0x' + '1'.repeat(64),
          },
        });

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).toContain('STEP_UP_REQUIRED');
    });

    it('la reautenticación empieza en blanco y no se puede fingir', async () => {
      // Nadie arranca con permiso vivo para operaciones críticas.
      const estado = await http().get(`${PREFIX}/auth/step-up`).set(as(bruno)).expect(200);
      expect((estado.body as { fresh: boolean }).fresh).toBe(false);

      // Y no hay forma de dárselo a uno mismo: el único camino pasa por volver
      // de Google con un vale válido.
      await http()
        .post(`${PREFIX}/auth/google/exchange`)
        .send({ ticket: 'A'.repeat(43), verifier: 'B'.repeat(43) })
        .expect(401);
    });

    it('borrar la cuenta exige reautenticación y la palabra exacta', async () => {
      // Palabra correcta pero sin prueba de identidad.
      const sinPrueba = await http()
        .delete(`${PREFIX}/users/me`)
        .set(as(bruno))
        .send({ confirm: 'ELIMINAR' });
      expect(sinPrueba.status).toBe(401);

      // Sin la palabra exacta: lo rechaza la validación, antes de mirar nada más.
      const sinPalabra = await http()
        .delete(`${PREFIX}/users/me`)
        .set(as(bruno))
        .send({ confirm: 'BORRAR' });
      expect(sinPalabra.status).toBe(400);

      // Y sigue existiendo.
      await http().get(`${PREFIX}/users/me`).set(as(bruno)).expect(200);
    });
  });

  /**
   * Acceso con Google.
   *
   * Lo que se puede comprobar sin salir de la máquina: que la petición que se
   * le hace a Google lleva lo que tiene que llevar, y que ningún atajo permite
   * saltarse el viaje. El canje real necesita a Google al otro lado y queda
   * fuera del alcance de una suite automática.
   */
  describe('acceso con Google', () => {
    /** Un SHA-256 en base64url tiene exactamente 43 caracteres. */
    const reto = 'a'.repeat(43);

    const urlDe = (res: { body: unknown }): URL =>
      new URL((res.body as { authorizationUrl: string }).authorizationUrl);

    it('la URL de Google lleva PKCE, nonce y solo los permisos necesarios', async () => {
      const res = await http()
        .post(`${PREFIX}/auth/google/start`)
        .send({ platform: 'web', challenge: reto })
        .expect(200);

      const url = urlDe(res);
      expect(url.origin).toBe('https://accounts.google.com');

      // Solo `openid` y `email`. Si algún día aparece `profile` aquí, es que
      // alguien ha empezado a pedir el nombre y la foto del usuario.
      expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'openid']);

      // PKCE con S256. En `plain` el reto viaja en claro y no protege de nada.
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      // El reto de PKCE es el del servidor, NO el que manda la app: son dos
      // secretos distintos que protegen dos tramos distintos del recorrido.
      expect(url.searchParams.get('code_challenge')).not.toBe(reto);

      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('prompt')).toBe('select_account');
    });

    it('dos intentos seguidos no comparten state', async () => {
      const uno = await http()
        .post(`${PREFIX}/auth/google/start`)
        .send({ platform: 'native', challenge: reto })
        .expect(200);
      const dos = await http()
        .post(`${PREFIX}/auth/google/start`)
        .send({ platform: 'native', challenge: reto })
        .expect(200);

      const state = (res: { body: unknown }) => urlDe(res).searchParams.get('state');
      expect(state(uno)).not.toBe(state(dos));
    });

    it('el destino de vuelta no lo elige el cliente', async () => {
      // Solo `web` o `native`, dos URLs fijas de la configuración. Aceptar una
      // URL del cliente convertiría esto en un redirect abierto con una sesión
      // recién creada dentro.
      await http()
        .post(`${PREFIX}/auth/google/start`)
        .send({
          platform: 'https://sitio-del-atacante.example',
          challenge: reto,
        })
        .expect(400);

      await http()
        .post(`${PREFIX}/auth/google/start`)
        .send({
          platform: 'web',
          challenge: reto,
          redirectUri: 'https://sitio.example',
        })
        .expect(400);
    });

    it('un state desconocido no lleva a ninguna parte', async () => {
      // Ni redirige a la app ni filtra nada: la respuesta es la misma para un
      // state caducado que para uno inventado.
      const res = await http()
        .get(`${PREFIX}/auth/google/callback`)
        .query({
          code: 'lo-que-sea',
          state: 'b'.repeat(43),
        });

      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('el vale de vuelta no se puede canjear sin el verificador correcto', async () => {
      await http()
        .post(`${PREFIX}/auth/google/exchange`)
        .send({ ticket: 'c'.repeat(43), verifier: 'd'.repeat(43) })
        .expect(401);
    });
  });

  describe('endurecimiento', () => {
    it('la resincronización de mercados es solo para administradores', async () => {
      await http().post(`${PREFIX}/markets/sync`).set(as(bruno)).expect(403);
    });

    it('no queda ninguna ruta de contraseña ni de segundo factor propio', async () => {
      // Se entra solo con Google. Estas rutas existieron; si alguna vuelve a
      // responder, la plataforma ha recuperado un camino de acceso con
      // contraseña sin que nadie lo haya decidido.
      const difuntas: Array<[string, Record<string, string>]> = [
        ['/auth/sign-in', { email: 'a@b.c', password: 'Contrasena123' }],
        ['/auth/sign-up', { email: 'a@b.c', password: 'Contrasena123', name: 'a' }],
        ['/auth/password', { currentPassword: 'a', newPassword: 'Contrasena123' }],
        ['/auth/totp/setup', {}],
      ];

      for (const [ruta, cuerpo] of difuntas) {
        const res = await http().post(`${PREFIX}${ruta}`).set(as(bruno)).send(cuerpo);
        expect(res.status).toBe(404);
      }

      // Y la sesión sigue siendo válida: nada de esto la ha tocado.
      await http().get(`${PREFIX}/auth/me`).set(as(bruno)).expect(200);
    });

    it('un error interno no filtra detalles al cliente', async () => {
      // Un uuid con formato válido pero inexistente debe dar 404 limpio, sin
      // rastro de Prisma ni de la consulta.
      const res = await http()
        .get(`${PREFIX}/bots/00000000-0000-4000-8000-000000000000`)
        .set(as(bruno))
        .expect(404);

      const cuerpo = JSON.stringify(res.body);
      for (const filtracion of ['prisma', 'PrismaClient', 'invocation', 'SELECT', 'user_id']) {
        expect(cuerpo.toLowerCase()).not.toContain(filtracion.toLowerCase());
      }
    });
  });

  describe('sin credenciales', () => {
    it('las rutas protegidas exigen token', async () => {
      await http().get(`${PREFIX}/bots`).expect(401);
      await http().get(`${PREFIX}/exchange-accounts`).expect(401);
      await http().get(`${PREFIX}/risk/limits`).expect(401);
    });

    it('un token manipulado no vale', async () => {
      await http()
        .get(`${PREFIX}/bots`)
        .set({ Authorization: `Bearer ${alicia.token.slice(0, -3)}xyz` })
        .expect(401);
    });
  });
});
