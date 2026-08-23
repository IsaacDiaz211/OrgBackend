import { SignJWT, jwtVerify } from 'jose';
import type { Platform, RiskLevel } from '../types';

const ISSUER = 'raven-to-pandas-key-broker';
const AUDIENCE = 'raven-to-pandas-mobile';

export type SessionTokenClaims = {
  jti: string;
  sub: string;
  platform: Platform;
  riskLevel: RiskLevel;
  iat: number;
  exp: number;
};

type CreateSessionTokenInput = {
  jti: string;
  installHash: string;
  platform: Platform;
  riskLevel: RiskLevel;
  issuedAtMs: number;
  expiresAtMs: number;
  secret: string;
};

const getSecret = (secret: string): Uint8Array => {
  return new TextEncoder().encode(secret);
};

export const createSessionToken = async (input: CreateSessionTokenInput): Promise<string> => {
  const issuedAtSeconds = Math.floor(input.issuedAtMs / 1000);
  const expiresAtSeconds = Math.floor(input.expiresAtMs / 1000);

  return new SignJWT({
    platform: input.platform,
    riskLevel: input.riskLevel,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(input.installHash)
    .setJti(input.jti)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(getSecret(input.secret));
};

export const verifySessionToken = async (token: string, secret: string): Promise<SessionTokenClaims> => {
  const { payload } = await jwtVerify(token, getSecret(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (!payload.jti || !payload.sub) {
    throw new Error('Session token is missing jti/sub');
  }

  const platform = payload.platform;
  const riskLevel = payload.riskLevel;
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error('Session token has invalid platform');
  }

  if (riskLevel !== 'low' && riskLevel !== 'medium' && riskLevel !== 'high') {
    throw new Error('Session token has invalid riskLevel');
  }

  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new Error('Session token is missing iat/exp');
  }

  return {
    jti: payload.jti,
    sub: payload.sub,
    platform,
    riskLevel,
    iat: payload.iat,
    exp: payload.exp,
  };
};
