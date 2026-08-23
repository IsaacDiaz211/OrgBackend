import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { SignJWT, importPKCS8 } from 'jose';
import type { Platform, RiskLevel } from '../types';

const GOOGLE_PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_PLAY_INTEGRITY_BASE_URL = 'https://playintegrity.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 10000;
const OAUTH_REFRESH_MARGIN_MS = 60000;

type PlayIntegrityDeviceVerdict =
  | 'MEETS_BASIC_INTEGRITY'
  | 'MEETS_DEVICE_INTEGRITY'
  | 'MEETS_STRONG_INTEGRITY'
  | 'MEETS_VIRTUAL_INTEGRITY';

export type PlayIntegrityConfig = {
  packageName: string;
  serviceAccountJson: string;
  serviceAccountJsonPath: string;
  allowedDeviceVerdicts: PlayIntegrityDeviceVerdict[];
  requireLicensed: boolean;
  maxTokenAgeMs: number;
  maxClockSkewMs: number;
};

export type VerifyAttestationInput = {
  token: string;
  nonce: string;
  platform: Platform;
  strictMode: boolean;
  verifierUrl: string;
  playIntegrity: PlayIntegrityConfig;
};

export type VerifyAttestationResult = {
  ok: boolean;
  riskLevel: RiskLevel;
  reason?: string;
};

type RemoteVerifierResponse = {
  ok: boolean;
  riskLevel?: RiskLevel;
  reason?: string;
};

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type TokenPayloadExternal = {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    nonce?: string;
    timestampMillis?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
    legacyDeviceRecognitionVerdict?: string[];
  };
  accountDetails?: {
    appLicensingVerdict?: string;
  };
  testingDetails?: {
    isTestingResponse?: boolean;
  };
};

type DecodeIntegrityTokenResponse = {
  tokenPayloadExternal?: TokenPayloadExternal;
};

let credentialsCache:
  | {
      cacheKey: string;
      credentials: ServiceAccountCredentials;
    }
  | null = null;

let accessTokenCache:
  | {
      accessToken: string;
      expiresAtMs: number;
    }
  | null = null;

let accessTokenInFlight: Promise<string> | null = null;

const parseRiskLevel = (value: unknown): RiskLevel => {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
};

const withTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const readServiceAccountJson = async (config: PlayIntegrityConfig): Promise<string> => {
  const inlineJson = config.serviceAccountJson.trim();
  if (inlineJson) {
    return inlineJson;
  }

  const jsonPath = config.serviceAccountJsonPath.trim();
  if (!jsonPath) {
    throw new Error('missing Play Integrity service account credentials');
  }

  let absolutePath = jsonPath.startsWith('/') ? jsonPath : resolvePath(process.cwd(), jsonPath);
  const pathStats = await stat(absolutePath);

  if (pathStats.isDirectory()) {
    const entries = await readdir(absolutePath);
    const jsonFile = entries
      .filter((entry) => entry.toLowerCase().endsWith('.json'))
      .sort((left, right) => left.localeCompare(right))[0];

    if (!jsonFile) {
      throw new Error('service account directory does not contain a JSON file');
    }

    absolutePath = resolvePath(absolutePath, jsonFile);
  }

  return readFile(absolutePath, 'utf8');
};

const parseServiceAccount = (rawJson: string): ServiceAccountCredentials => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('invalid Play Integrity service account JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid Play Integrity service account payload');
  }

  const candidate = parsed as Partial<ServiceAccountCredentials>;
  const clientEmail = typeof candidate.client_email === 'string' ? candidate.client_email.trim() : '';
  const privateKeyRaw = typeof candidate.private_key === 'string' ? candidate.private_key : '';
  const tokenUri =
    typeof candidate.token_uri === 'string' && candidate.token_uri.trim()
      ? candidate.token_uri.trim()
      : GOOGLE_OAUTH_TOKEN_URL;

  if (!clientEmail || !privateKeyRaw) {
    throw new Error('Play Integrity service account JSON missing client_email/private_key');
  }

  const normalizedPrivateKey = privateKeyRaw.replace(/\\n/g, '\n');

  return {
    client_email: clientEmail,
    private_key: normalizedPrivateKey,
    token_uri: tokenUri,
  };
};

const getServiceAccountCredentials = async (
  config: PlayIntegrityConfig,
): Promise<ServiceAccountCredentials> => {
  const cacheKey = `${config.serviceAccountJson.length}:${config.serviceAccountJsonPath}`;
  if (credentialsCache && credentialsCache.cacheKey === cacheKey) {
    return credentialsCache.credentials;
  }

  const rawJson = await readServiceAccountJson(config);
  const credentials = parseServiceAccount(rawJson);

  credentialsCache = {
    cacheKey,
    credentials,
  };

  return credentials;
};

const fetchGoogleAccessToken = async (credentials: ServiceAccountCredentials): Promise<string> => {
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || GOOGLE_OAUTH_TOKEN_URL;
  const privateKey = await importPKCS8(credentials.private_key, 'RS256');

  const assertion = await new SignJWT({ scope: GOOGLE_PLAY_INTEGRITY_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(credentials.client_email)
    .setSubject(credentials.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(privateKey);

  const payload = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await withTimeout(tokenUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: payload.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`oauth token request failed (${response.status}) ${detail.slice(0, 240)}`.trim());
  }

  const tokenPayload = (await response.json()) as OAuthTokenResponse;
  const accessToken = tokenPayload.access_token?.trim() ?? '';
  if (!accessToken) {
    throw new Error('oauth token response missing access_token');
  }

  const expiresInSec =
    typeof tokenPayload.expires_in === 'number' && tokenPayload.expires_in > 0
      ? tokenPayload.expires_in
      : 3600;

  accessTokenCache = {
    accessToken,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  };

  return accessToken;
};

const getGoogleAccessToken = async (credentials: ServiceAccountCredentials): Promise<string> => {
  if (accessTokenCache && accessTokenCache.expiresAtMs - Date.now() > OAUTH_REFRESH_MARGIN_MS) {
    return accessTokenCache.accessToken;
  }

  if (accessTokenInFlight) {
    return accessTokenInFlight;
  }

  accessTokenInFlight = fetchGoogleAccessToken(credentials).finally(() => {
    accessTokenInFlight = null;
  });

  return accessTokenInFlight;
};

const decodeIntegrityToken = async (
  packageName: string,
  integrityToken: string,
  accessToken: string,
): Promise<TokenPayloadExternal> => {
  const endpoint = `${GOOGLE_PLAY_INTEGRITY_BASE_URL}/${encodeURIComponent(
    packageName,
  )}:decodeIntegrityToken`;

  const response = await withTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      integrityToken,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    accessTokenCache = null;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`decodeIntegrityToken failed (${response.status}) ${detail.slice(0, 240)}`.trim());
  }

  const payload = (await response.json()) as DecodeIntegrityTokenResponse;
  if (!payload.tokenPayloadExternal) {
    throw new Error('decodeIntegrityToken returned an empty payload');
  }

  return payload.tokenPayloadExternal;
};

const resolveDeviceVerdicts = (payload: TokenPayloadExternal): string[] => {
  const modern = payload.deviceIntegrity?.deviceRecognitionVerdict;
  if (Array.isArray(modern) && modern.length > 0) {
    return modern;
  }

  const legacy = payload.deviceIntegrity?.legacyDeviceRecognitionVerdict;
  if (Array.isArray(legacy)) {
    return legacy;
  }

  return [];
};

const verifyAndroidPlayIntegrity = async (
  input: VerifyAttestationInput,
): Promise<VerifyAttestationResult> => {
  const playConfig = input.playIntegrity;

  if (!playConfig.packageName) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'PLAY_INTEGRITY_PACKAGE_NAME is not configured',
    };
  }

  if (!playConfig.allowedDeviceVerdicts.length) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS is empty',
    };
  }

  let serviceAccount: ServiceAccountCredentials;
  try {
    serviceAccount = await getServiceAccountCredentials(playConfig);
  } catch (error) {
    return {
      ok: false,
      riskLevel: 'high',
      reason:
        error instanceof Error
          ? `failed to load service account (${error.message})`
          : 'failed to load service account',
    };
  }

  let decodedPayload: TokenPayloadExternal;
  try {
    let accessToken = await getGoogleAccessToken(serviceAccount);

    try {
      decodedPayload = await decodeIntegrityToken(playConfig.packageName, input.token, accessToken);
    } catch (decodeError) {
      const isAuthError =
        decodeError instanceof Error &&
        (decodeError.message.includes('decodeIntegrityToken failed (401)') ||
          decodeError.message.includes('decodeIntegrityToken failed (403)'));

      if (!isAuthError) {
        throw decodeError;
      }

      accessTokenCache = null;
      accessToken = await getGoogleAccessToken(serviceAccount);
      decodedPayload = await decodeIntegrityToken(playConfig.packageName, input.token, accessToken);
    }
  } catch (error) {
    return {
      ok: false,
      riskLevel: 'high',
      reason:
        error instanceof Error
          ? `play integrity verification request failed (${error.message})`
          : 'play integrity verification request failed',
    };
  }

  const requestDetails = decodedPayload.requestDetails;
  if (!requestDetails) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'play integrity payload missing requestDetails',
    };
  }

  if (requestDetails.requestPackageName !== playConfig.packageName) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'request package name does not match configured package',
    };
  }

  const requestBinding = requestDetails.requestHash ?? requestDetails.nonce;
  if (!requestBinding || requestBinding !== input.nonce) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'request hash/nonce mismatch',
    };
  }

  const timestampMs = Number(requestDetails.timestampMillis ?? Number.NaN);
  if (!Number.isFinite(timestampMs)) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'request timestamp is missing or invalid',
    };
  }

  const now = Date.now();
  if (timestampMs - now > playConfig.maxClockSkewMs) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'request timestamp is too far in the future',
    };
  }

  if (now - timestampMs > playConfig.maxTokenAgeMs) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'integrity token is too old',
    };
  }

  const appRecognitionVerdict = decodedPayload.appIntegrity?.appRecognitionVerdict;
  if (appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return {
      ok: false,
      riskLevel: 'high',
      reason: `app recognition verdict is ${appRecognitionVerdict ?? 'unknown'}`,
    };
  }

  const deviceVerdicts = resolveDeviceVerdicts(decodedPayload);
  const matchedVerdict = playConfig.allowedDeviceVerdicts.find((value) => deviceVerdicts.includes(value));
  if (!matchedVerdict) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: `device integrity verdict does not meet policy (${deviceVerdicts.join(',') || 'none'})`,
    };
  }

  const licensingVerdict = decodedPayload.accountDetails?.appLicensingVerdict;
  if (playConfig.requireLicensed && licensingVerdict !== 'LICENSED') {
    return {
      ok: false,
      riskLevel: 'high',
      reason: `licensing verdict is ${licensingVerdict ?? 'unknown'}`,
    };
  }

  const hasStrongIntegrity = deviceVerdicts.includes('MEETS_STRONG_INTEGRITY');
  let riskLevel: RiskLevel = hasStrongIntegrity ? 'low' : 'medium';

  if (decodedPayload.testingDetails?.isTestingResponse && riskLevel === 'low') {
    riskLevel = 'medium';
  }

  return {
    ok: true,
    riskLevel,
    reason: `play integrity verification passed (${matchedVerdict})`,
  };
};

const verifyWithRemoteVerifier = async (
  input: VerifyAttestationInput,
): Promise<VerifyAttestationResult> => {
  const response = await withTimeout(input.verifierUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token: input.token,
      nonce: input.nonce,
      platform: input.platform,
    }),
  });

  if (!response.ok) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: `remote attestation verifier failed with status ${response.status}`,
    };
  }

  const payload = (await response.json()) as RemoteVerifierResponse;
  return {
    ok: Boolean(payload.ok),
    riskLevel: parseRiskLevel(payload.riskLevel),
    reason: payload.reason,
  };
};

export const verifyAttestation = async (
  input: VerifyAttestationInput,
): Promise<VerifyAttestationResult> => {
  if (!input.token || input.token.trim().length < 8) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'attestation token is missing or too short',
    };
  }

  if (!input.strictMode) {
    return {
      ok: true,
      riskLevel: 'low',
      reason: 'strict attestation disabled',
    };
  }

  if (input.platform === 'android') {
    return verifyAndroidPlayIntegrity(input);
  }

  if (!input.verifierUrl) {
    return {
      ok: false,
      riskLevel: 'high',
      reason: 'strict attestation enabled but iOS remote verifier URL is not configured',
    };
  }

  return verifyWithRemoteVerifier(input);
};
