import type { LimitReset } from './types';

const readNumber = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var: ${name}`);
  }

  return parsed;
};

const readBoolean = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  throw new Error(`Invalid boolean env var: ${name}`);
};

const readString = (name: string, fallback = ''): string => {
  return process.env[name]?.trim() ?? fallback;
};

const parseLimitReset = (raw: string): LimitReset => {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === 'null' || normalized === 'none') {
    return null;
  }

  if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') {
    return normalized;
  }

  throw new Error('OPENROUTER_KEY_LIMIT_RESET must be daily, weekly, monthly, or empty');
};

const parseObject = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OPENROUTER_EXTRA_CREATE_PAYLOAD must be a JSON object');
  }

  return parsed as Record<string, unknown>;
};

const parseCorsOrigins = (raw: string): string[] | '*' => {
  const normalized = raw.trim();
  if (!normalized || normalized === '*') {
    return '*';
  }

  return normalized
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const PLAY_INTEGRITY_DEVICE_VERDICTS = [
  'MEETS_BASIC_INTEGRITY',
  'MEETS_DEVICE_INTEGRITY',
  'MEETS_STRONG_INTEGRITY',
  'MEETS_VIRTUAL_INTEGRITY',
] as const;

type PlayIntegrityDeviceVerdict = (typeof PLAY_INTEGRITY_DEVICE_VERDICTS)[number];

const parsePlayIntegrityVerdicts = (raw: string): PlayIntegrityDeviceVerdict[] => {
  const fallback = ['MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY'] as const;

  const parsed = raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);

  const source = parsed.length > 0 ? parsed : Array.from(fallback);
  const uniqueValues = Array.from(new Set(source));

  const allowed = new Set<string>(PLAY_INTEGRITY_DEVICE_VERDICTS);
  for (const value of uniqueValues) {
    if (!allowed.has(value)) {
      throw new Error(`Invalid PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS value: ${value}`);
    }
  }

  return uniqueValues as PlayIntegrityDeviceVerdict[];
};

const normalizeOpenRouterBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'https://openrouter.ai/api/v1';
  }

  // Accept accidental '/keys' suffix in env values and normalize to base endpoint.
  if (trimmed.endsWith('/keys')) {
    return trimmed.slice(0, -'/keys'.length);
  }

  return trimmed;
};

export const config = {
  nodeEnv: readString('NODE_ENV', 'development'),
  port: readNumber('PORT', 3000),
  apiPrefix: readString('API_PREFIX', '/api/v1'),

  security: {
    // Dev fallback keeps local runs simple; use a strong value in production.
    jwtSigningSecret: readString('JWT_SIGNING_SECRET', 'dev-only-change-me'),
    cronSecret: readString('CRON_SECRET', 'dev-only-change-me'),
    challengeTtlSeconds: readNumber('CHALLENGE_TTL_SECONDS', 60),
    sessionTtlSeconds: readNumber('SESSION_TTL_SECONDS', 900),
    enableStrictAttestation: readBoolean('ENABLE_STRICT_ATTESTATION', true),
    attestationVerifierUrl: readString('ATTESTATION_VERIFIER_URL', ''),
    playIntegrity: {
      packageName: readString('PLAY_INTEGRITY_PACKAGE_NAME', ''),
      serviceAccountJson: readString('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON', ''),
      serviceAccountJsonPath: readString('PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON_PATH', ''),
      allowedDeviceVerdicts: parsePlayIntegrityVerdicts(
        readString(
          'PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS',
          'MEETS_DEVICE_INTEGRITY,MEETS_STRONG_INTEGRITY',
        ),
      ),
      requireLicensed: readBoolean('PLAY_INTEGRITY_REQUIRE_LICENSED', true),
      maxTokenAgeMs: readNumber('PLAY_INTEGRITY_MAX_TOKEN_AGE_MS', 120000),
      maxClockSkewMs: readNumber('PLAY_INTEGRITY_MAX_CLOCK_SKEW_MS', 30000),
    },
  },

  openRouter: {
    managementBaseUrl: normalizeOpenRouterBaseUrl(
      readString('OPENROUTER_MANAGEMENT_BASE_URL', 'https://openrouter.ai/api/v1'),
    ),
    managementKey: readString('OPENROUTER_MANAGEMENT_KEY', ''),
    keyNamePrefix: readString('OPENROUTER_KEY_NAME_PREFIX', 'r2p'),
    keyLimit: readNumber('OPENROUTER_KEY_LIMIT', 10),
    keyLimitReset: parseLimitReset(readString('OPENROUTER_KEY_LIMIT_RESET', 'daily')),
    includeByokInLimit: readBoolean('OPENROUTER_INCLUDE_BYOK_IN_LIMIT', false),
    requestTimeoutMs: readNumber('OPENROUTER_REQUEST_TIMEOUT_MS', 7000),
    keyRotateAfterSeconds: readNumber('KEY_ROTATE_AFTER_SECONDS', 21600),
    keyHardExpiresSeconds: readNumber('KEY_HARD_EXPIRES_SECONDS', 86400),
    extraCreatePayload: parseObject(readString('OPENROUTER_EXTRA_CREATE_PAYLOAD', '')),
  },

  rateLimit: {
    challengePerMinute: readNumber('RATE_LIMIT_CHALLENGE_PER_MIN', 20),
    sessionPerMinute: readNumber('RATE_LIMIT_SESSION_PER_MIN', 20),
    leasePerMinute: readNumber('RATE_LIMIT_LEASE_PER_MIN', 30),
    adminPerMinute: readNumber('RATE_LIMIT_ADMIN_PER_MIN', 60),
  },

  storage: {
    upstashUrl: readString('UPSTASH_REDIS_REST_URL', ''),
    upstashToken: readString('UPSTASH_REDIS_REST_TOKEN', ''),
    redisUrl: readString('REDIS_URL', ''),
    databaseUrl: readString('DATABASE_URL', ''),
  },

  org: {
    adminSecret: readString('ORG_ADMIN_SECRET', ''),
    orgId: readString('ORG_ID', 'default'),
    orgName: readString('ORG_NAME', ''),
    defaultTtlDays: readNumber('ORG_DEFAULT_TTL_DAYS', 30),
    defaultBudgetCents: readNumber('ORG_DEFAULT_BUDGET_CENTS', 100),
    costPerGenerationCents: readNumber('ORG_COST_PER_GENERATION_CENTS', 5),
    maxChars: readNumber('ORG_MAX_CHARS', 2000),
    inviteTtlDays: readNumber('ORG_INVITE_TTL_DAYS', 7),
  },
};

// Fail-fast: ORG_ADMIN_SECRET is required in all envs except test (keeps `bun test` green without real secret)
if (!config.org.adminSecret.trim() && config.nodeEnv !== 'test') {
  throw new Error(
    'ORG_ADMIN_SECRET is required — set a long random secret in .env (e.g. `openssl rand -hex 32`). ' +
      'This secret authenticates POST /admin/* and gates membership enforcement. ' +
      'For local dev, set any non-empty value; for prod, use a strong random string.',
  );
}

export type AppConfig = typeof config;
