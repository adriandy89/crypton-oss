import type {
  AccountStatus,
  BotStatus,
  Direction,
  MarginMode,
  Role,
  StrategyKind,
  Venue,
} from '@crypton/db';

/**
 * Lo que la consola de administracion deja salir.
 *
 * Estos tipos son la SEGUNDA de las dos puertas que protegen los datos de los
 * usuarios. La primera es el `select` de Prisma, que decide lo que llega a
 * entrar en el proceso; esta enumera lo que sale de el. Con una sola de las dos
 * bastaria hoy; con las dos, ningun descuido futuro basta solo.
 *
 * NUNCA sale de aqui, y no es una lista de buenas intenciones sino de campos
 * que un test comprueba que no aparecen en la respuesta:
 *
 * - `users.google_sub` — la identidad de la persona ante Google.
 * - `enc_payload`, `enc_dek`, `enc_iv`, `enc_tag`, `enc_key_id` — el sobre
 *   AES-GCM de la clave de firma (invariante 8). Ni entero ni troceado.
 * - `telegram_links.link_code` — quien acierte un codigo vivo recibe las
 *   operaciones y los avisos de liquidacion de la victima. Sale `linked`.
 * - `telegram_links.chat_id` — dato personal sin utilidad para el panel.
 *
 * Y todo importe viaja como `string` (invariante 1), todo `BigInt` convertido:
 * el parche de `BigInt.prototype.toJSON` vive en `main.ts`, que el e2e no
 * ejecuta, asi que un id sin convertir funciona en produccion y revienta en la
 * suite. Convertirlo en el mapper es lo correcto de todas formas: por encima de
 * 2^53 un `number` pierde precision en silencio.
 */

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  emailVerified: boolean;
  country: string | null;
  language: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** Recuentos, para no obligar a abrir la ficha solo para ver si tiene algo. */
  bots: { total: number; live: number };
  exchangeAccounts: number;
}

export interface AdminExchangeAccountRow {
  id: string;
  venue: Venue;
  label: string;
  status: AccountStatus;
  /** Dato PUBLICO por definicion del esquema: wallet o indice de cuenta. */
  publicRef: string;
  testnet: boolean;
  paper: boolean;
  builderApproved: boolean;
  lastVerifiedAt: string | null;
  agentValidUntil: string | null;
  lastError: string | null;
}

export interface AdminUserDetail extends AdminUserRow {
  bio: string | null;
  timezone: string | null;
  displayCurrency: string | null;
  updatedAt: string | null;
  riskLimits: {
    maxNotionalPerBot: string | null;
    maxTotalNotional: string | null;
    maxLeverage: number | null;
    maxOpenBots: number | null;
    maxDailyLoss: string | null;
    killSwitchDrawdownPct: string | null;
    liquidationAlertPct: string | null;
  } | null;
  accounts: AdminExchangeAccountRow[];
  botsByStatus: Partial<Record<BotStatus, number>>;
  /** Vinculado o no. Ni `chat_id` ni `link_code`, jamas. */
  telegram: { linked: boolean; verifiedAt: string | null };
}

export interface AdminBotRow {
  id: string;
  name: string;
  owner: { id: string; email: string; name: string; disabled: boolean };
  venue: Venue;
  symbol: string;
  strategy: StrategyKind;
  status: BotStatus;
  direction: Direction;
  leverage: number;
  marginMode: MarginMode;
  dryRun: boolean;
  paper: boolean;
  testnet: boolean;
  /** Decimal → string. Invariante 1. */
  totalInvestment: string;
  lastError: string | null;
  startedAt: string | null;
  lastTickAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}
