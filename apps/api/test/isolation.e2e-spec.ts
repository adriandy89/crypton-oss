import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DbService } from '../src/libs';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/modules/auth';

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
  id: string;
}

describe('Aislamiento entre usuarios (e2e)', () => {
  let app: INestApplication;
  let db: DbService;
  let tokens: TokenService;
  let alicia: Actor;
  let bruno: Actor;

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
  async function crearUsuario(nombre: string): Promise<Actor> {
    const email = `${nombre}-${stamp}@crypton.test`;
    const user = await db.user.create({
      data: {
        email,
        name: nombre,
        // Identidad de Google simulada, única por ejecución.
        google_sub: `test-${nombre}-${stamp}`,
        is_email_verified: true,
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

    return { email, token: par.accessToken, id: user.id };
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
  }, 60_000);

  afterAll(async () => {
    // Se limpia por email para no tocar datos ajenos a la suite. Las cascadas
    // del esquema se llevan bots, credenciales, límites y vinculaciones.
    await db.user
      .deleteMany({
        where: { email: { in: [alicia?.email, bruno?.email].filter(Boolean) } },
      })
      .catch(() => undefined);
    await app?.close();
  });

  it('crea dos usuarios distintos', () => {
    expect(alicia.id).toBeTruthy();
    expect(bruno.id).toBeTruthy();
    expect(alicia.id).not.toBe(bruno.id);
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

    const rutasDeLectura = [
      '',
      '/levels',
      '/orders',
      '/fills',
      '/cycles',
      '/events',
      '/snapshots',
    ];

    it.each(rutasDeLectura)(
      'bruno no puede leer /bots/:id%s de alicia',
      async (sufijo) => {
        await http()
          .get(`${PREFIX}/bots/${botDeAlicia}${sufijo}`)
          .set(as(bruno))
          .expect(404);
      },
    );

    it('alicia sí puede leer su propio bot', async () => {
      const res = await http()
        .get(`${PREFIX}/bots/${botDeAlicia}`)
        .set(as(alicia))
        .expect(200);
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
      await http()
        .delete(`${PREFIX}/bots/${botDeAlicia}`)
        .set(as(bruno))
        .expect(404);
      expect(
        await db.bot.findUnique({ where: { id: botDeAlicia } }),
      ).not.toBeNull();
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
      const res = await http()
        .get(`${PREFIX}/exchange-accounts`)
        .set(as(bruno))
        .expect(200);
      const ids = (res.body as { id: string }[]).map((c) => c.id);
      expect(ids).not.toContain(cuentaDeAlicia);
    });

    it('ninguna respuesta expone el sobre cifrado', async () => {
      const res = await http()
        .get(`${PREFIX}/exchange-accounts`)
        .set(as(alicia))
        .expect(200);
      const serializado = JSON.stringify(res.body);
      for (const campo of [
        'encPayload',
        'enc_payload',
        'encDek',
        'enc_dek',
        'encTag',
        'enc_iv',
      ]) {
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
      expect(
        await db.exchangeAccount.findUnique({ where: { id: cuentaDeAlicia } }),
      ).not.toBeNull();
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

      const deBruno = await http()
        .get(`${PREFIX}/risk/limits`)
        .set(as(bruno))
        .expect(200);
      expect(String(deBruno.body.maxLeverage ?? '')).not.toBe('7');
    });

    it('el kill-switch de bruno no toca los bots de alicia', async () => {
      const antes = await db.bot.findMany({
        where: { user_id: alicia.id },
        select: { status: true },
      });
      await http()
        .post(`${PREFIX}/risk/kill-switch`)
        .set(as(bruno))
        .expect(200);
      const despues = await db.bot.findMany({
        where: { user_id: alicia.id },
        select: { status: true },
      });
      expect(despues.map((b) => b.status)).toEqual(antes.map((b) => b.status));
    });

    it('el código de Telegram nace con caducidad', async () => {
      // Lo que se comprueba es que NUNCA se emite un código sin fecha de
      // caducidad: un código eterno es una puerta abierta indefinidamente.
      const res = await http()
        .post(`${PREFIX}/telegram/link`)
        .set(as(alicia))
        .send({});

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
      const deAlicia = await http()
        .get(`${PREFIX}/users/me`)
        .set(as(alicia))
        .expect(200);
      const deBruno = await http()
        .get(`${PREFIX}/users/me`)
        .set(as(bruno))
        .expect(200);

      expect(deAlicia.body.email).toBe(alicia.email);
      expect(deBruno.body.email).toBe(bruno.email);
      expect(deAlicia.body.id).not.toBe(deBruno.body.id);
    });

    it('el perfil no devuelve la identidad de Google ni restos de credenciales', async () => {
      const res = await http()
        .get(`${PREFIX}/users/me`)
        .set(as(alicia))
        .expect(200);
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

      const res = await http()
        .get(`${PREFIX}/users/me`)
        .set(as(bruno))
        .expect(200);
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
      const estado = await http()
        .get(`${PREFIX}/auth/step-up`)
        .set(as(bruno))
        .expect(200);
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
      expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
        'email',
        'openid',
      ]);

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

      const state = (res: { body: unknown }) =>
        urlDe(res).searchParams.get('state');
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
        [
          '/auth/sign-up',
          { email: 'a@b.c', password: 'Contrasena123', name: 'a' },
        ],
        [
          '/auth/password',
          { currentPassword: 'a', newPassword: 'Contrasena123' },
        ],
        ['/auth/totp/setup', {}],
      ];

      for (const [ruta, cuerpo] of difuntas) {
        const res = await http()
          .post(`${PREFIX}${ruta}`)
          .set(as(bruno))
          .send(cuerpo);
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
      for (const filtracion of [
        'prisma',
        'PrismaClient',
        'invocation',
        'SELECT',
        'user_id',
      ]) {
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
