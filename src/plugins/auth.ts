import { brokerStore } from '../container';
import { verifySessionToken } from '../auth/sessionToken';
import { getBearerToken } from '../utils/network';
import { config } from '../config';
import { HttpError } from '../utils/errors';
import { hashInstallId, safeStringEqual } from '../utils/crypto';

export const requireSession = async (headers: Record<string, string | undefined>) => {
  const token = getBearerToken(headers.authorization);
  if (!token) {
    throw new HttpError(401, 'Missing bearer token');
  }

  let claims;
  try {
    claims = await verifySessionToken(token, config.security.jwtSigningSecret);
  } catch {
    throw new HttpError(401, 'Invalid or expired session token');
  }

  const sessionRecord = await brokerStore.getSession(claims.jti);
  if (!sessionRecord || sessionRecord.revokedAt) {
    throw new HttpError(401, 'Session revoked or not found');
  }

  return {
    claims,
    sessionRecord,
  };
};

export const validateInstallOwnership = (sessionInstallHash: string, installId: string): string => {
  const installHash = hashInstallId(installId);
  if (!safeStringEqual(sessionInstallHash, installHash)) {
    throw new HttpError(403, 'installId does not belong to this session');
  }
  return installHash;
};

export const requireAdmin = (headers: Record<string, string | undefined>): void => {
  const secret = config.org.adminSecret.trim();
  if (!secret) {
    throw new HttpError(503, 'Organization admin is not configured');
  }
  const token = getBearerToken(headers.authorization);
  if (!token || !safeStringEqual(token, secret)) {
    throw new HttpError(401, 'Invalid admin token');
  }
};

export const requireMembership = async (
  installHash: string,
): Promise<import('../types').MembershipRecord> => {
  const membership = await brokerStore.getMembership(installHash);
  if (!membership) {
    throw new HttpError(403, 'membership_required');
  }
  if (membership.status === 'revoked') {
    throw new HttpError(403, 'membership_revoked');
  }
  if (membership.status === 'expired' || membership.expiresAt <= Date.now()) {
    throw new HttpError(403, 'membership_expired');
  }
  if (membership.status !== 'active') {
    throw new HttpError(403, 'membership_inactive');
  }
  if (membership.spentCents >= membership.budgetCents) {
    throw new HttpError(429, 'budget_exhausted');
  }
  return membership;
};

export const membershipEnforced = (): boolean => {
  return config.org.adminSecret.trim().length > 0;
};
