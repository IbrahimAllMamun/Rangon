import { z } from 'zod';

/**
 * Configuration, read once from the environment and validated at startup.
 *
 * The names are the Django API's own (`docker-compose.yml`'s `x-api-env`), so
 * one environment block configures both processes and they cannot disagree
 * about the signing key, the hosts, the time zone or the tax default.
 *
 * `DJANGO_SETTINGS_MODULE` picks the profile, exactly as it picks Django's
 * settings module: `config.settings.prod` is production, anything else is
 * development. `config.settings.parity` additionally turns rate limits off.
 */
const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
    );

/** `env_list`: comma-separated, blanks dropped. */
const list = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? fallback)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DJANGO_SETTINGS_MODULE: z.string().default('config.settings.dev'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),

  // Tokens are signed with JWT_SIGNING_KEY when set, else DJANGO_SECRET_KEY --
  // `SIMPLE_JWT["SIGNING_KEY"]` in config/settings/base.py. Both APIs must
  // agree, or a token one issues is refused by the other.
  DJANGO_SECRET_KEY: z.string().min(1, 'DJANGO_SECRET_KEY is required'),
  JWT_SIGNING_KEY: z.string().default(''),
  JWT_ACCESS_TOKEN_MINUTES: z.coerce.number().int().positive().default(30),
  JWT_REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(14),

  DJANGO_ALLOWED_HOSTS: list('localhost,127.0.0.1,api'),
  DJANGO_CORS_ALLOWED_ORIGINS: list('http://localhost:3000'),
  DJANGO_SECURE_SSL_REDIRECT: flag(true),
  // Proxy hops whose X-Forwarded-For entries are believed (core/ip.py).
  DJANGO_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  // The one rate read from the environment (config/settings/base.py).
  DJANGO_THROTTLE_ANON: z.string().default('60/min'),

  DJANGO_TIME_ZONE: z.string().default('Asia/Dhaka'),
  RANGON_DEFAULT_TAX_RATE: z.string().default('0.00'),
  RANGON_CURRENCY: z.string().default('BDT'),
  // The origin customers reach the shop on; the product feed refuses to render
  // without it rather than publish links nothing can follow.
  RANGON_PUBLIC_URL: z.string().default(''),

  // Media is served root-relative from one origin (core/media.py).
  MEDIA_URL: z.string().default('/media/'),
  USE_S3: flag(false),
});

type Parsed = z.infer<typeof schema>;

export interface Env extends Parsed {
  production: boolean;
  /** `config.settings.parity`: rate limits off, as `REST_FRAMEWORK` there. */
  throttlingDisabled: boolean;
  jwtSigningKey: string;
  allowedHosts: string[];
  corsAllowAllOrigins: boolean;
  /** `SECURE_PROXY_SSL_HEADER`: believe X-Forwarded-Proto for `is_secure()`. */
  trustForwardedProto: boolean;
  sslRedirect: boolean;
  referrerPolicy: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const env = parsed.data;
  const production = env.DJANGO_SETTINGS_MODULE.endsWith('.prod');

  if (production) {
    // config/settings/prod.py refuses these; so does this.
    if (/^(insecure|dev-|build-|test-)/.test(env.DJANGO_SECRET_KEY)) {
      throw new Error('DJANGO_SECRET_KEY must be a real secret in production.');
    }
    if (env.DJANGO_ALLOWED_HOSTS.length === 0) {
      throw new Error('DJANGO_ALLOWED_HOSTS must be set in production.');
    }
    if (env.DJANGO_ALLOWED_HOSTS.includes('*')) {
      throw new Error("DJANGO_ALLOWED_HOSTS must not contain '*' in production.");
    }
  }
  if (env.USE_S3) {
    // django-storages builds S3 URLs from the bucket, endpoint and addressing
    // style; that is not ported yet, and a wrong image URL is worse than a
    // refusal to start. See docs/architecture/nest-port.md.
    throw new Error('USE_S3=1 is not supported by the NestJS API yet.');
  }

  return {
    ...env,
    production,
    throttlingDisabled: env.DJANGO_SETTINGS_MODULE.endsWith('.parity'),
    jwtSigningKey: env.JWT_SIGNING_KEY || env.DJANGO_SECRET_KEY,
    // dev.py: ALLOWED_HOSTS = ["*"] and CORS_ALLOW_ALL_ORIGINS = True.
    allowedHosts: production ? env.DJANGO_ALLOWED_HOSTS : ['*'],
    corsAllowAllOrigins: !production,
    trustForwardedProto: production,
    sslRedirect: production && env.DJANGO_SECURE_SSL_REDIRECT,
    referrerPolicy: production ? 'strict-origin-when-cross-origin' : 'same-origin',
  };
}

export const ENV = Symbol('ENV');
