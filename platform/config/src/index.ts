import { z } from 'zod';

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(16),
  COOKIE_SECURE: boolFromEnv.default('false'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUSTED_PROXIES: z.string().default(''),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  FEATURE_LIVE_BILLING: boolFromEnv.default('false'),
  FEATURE_PROMOTIONAL_GRANTS: boolFromEnv.default('false'),
  FEATURE_STRIPE_LIVE: boolFromEnv.default('false'),
  FEATURE_PAYROLL_LIVE: boolFromEnv.default('false'),
  FEATURE_AI_CONSEQUENTIAL: boolFromEnv.default('false'),
  FEATURE_OFFLINE_COMPLETION: boolFromEnv.default('false'),
  FEATURE_TRIP_GPS_LIVE: boolFromEnv.default('false'),
  FEATURE_MARKETPLACE_LIVE: boolFromEnv.default('false'),
  FEATURE_DAYSWAP: boolFromEnv.default('false'),
  FEATURE_DAYSALE: boolFromEnv.default('false'),
  FEATURE_SUPPORT_BREAK_GLASS: boolFromEnv.default('false'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./.data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('eu-west-2'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  UPLOAD_ALLOWED_MIME: z.string().default('application/pdf,image/jpeg,image/png,text/plain'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  allowedHosts: string[];
  trustedProxies: string[];
  uploadAllowedMime: string[];
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = envSchema.parse(env);
  const config: AppConfig = {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedHosts: parsed.ALLOWED_HOSTS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    trustedProxies: parsed.TRUSTED_PROXIES.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    uploadAllowedMime: parsed.UPLOAD_ALLOWED_MIME.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (env === process.env) cached = config;
  return config;
}

export function resetConfigCache(): void {
  cached = null;
}
