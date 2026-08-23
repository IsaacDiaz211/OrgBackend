import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore } from '../container';
import { applyRateLimit } from '../plugins/rateLimit';
import { SessionIssueBodySchema } from '../schemas';
import { createSessionToken } from '../auth/sessionToken';
import { verifyAttestation } from '../services/attestation';
import { getClientIp } from '../utils/network';
import { hashInstallId, safeStringEqual } from '../utils/crypto';
import { createId } from '../utils/id';
import { HttpError } from '../utils/errors';
import type { Platform, SessionRecord } from '../types';

export const sessionRoutes = new Elysia().post(
  '/session/issue',
  async ({ body, headers }) => {
    const clientIp = getClientIp(headers as Record<string, string | undefined>);
    const installHash = hashInstallId(body.installId);

    await applyRateLimit(
      `session:${clientIp}:${installHash}`,
      config.rateLimit.sessionPerMinute,
    );

    const challenge = await brokerStore.takeChallenge(body.challengeId);

    if (!challenge) {
      throw new HttpError(400, 'Challenge not found or already used');
    }

    if (challenge.platform !== body.platform || challenge.platform !== 'android') {
      throw new HttpError(403, 'Challenge platform mismatch');
    }

    const now = Date.now();
    if (challenge.expiresAt <= now) {
      throw new HttpError(400, 'Challenge has expired');
    }

    if (!safeStringEqual(challenge.installHash, installHash)) {
      throw new HttpError(403, 'Challenge does not match installId');
    }

    const attestation = await verifyAttestation({
      token: body.attestationToken,
      nonce: challenge.nonce,
      platform: body.platform as Platform,
      strictMode: config.security.enableStrictAttestation,
      verifierUrl: config.security.attestationVerifierUrl,
      playIntegrity: config.security.playIntegrity,
    });

    if (!attestation.ok) {
      throw new HttpError(401, 'Attestation verification failed', {
        reason: attestation.reason,
      });
    }

    const session: SessionRecord = {
      jti: createId(),
      installHash,
      platform: body.platform as Platform,
      riskLevel: attestation.riskLevel,
      issuedAt: now,
      expiresAt: now + config.security.sessionTtlSeconds * 1000,
      hasLeased: false,
    };

    await brokerStore.saveSession(session);

    const token = await createSessionToken({
      jti: session.jti,
      installHash: session.installHash,
      platform: session.platform,
      riskLevel: session.riskLevel,
      issuedAtMs: session.issuedAt,
      expiresAtMs: session.expiresAt,
      secret: config.security.jwtSigningSecret,
    });

    return {
      sessionToken: token,
      expiresInSec: config.security.sessionTtlSeconds,
      riskLevel: session.riskLevel,
    };
  },
  {
    body: SessionIssueBodySchema,
  },
);
