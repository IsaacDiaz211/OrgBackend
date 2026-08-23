import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore } from '../container';
import { applyRateLimit } from '../plugins/rateLimit';
import { ChallengeBodySchema } from '../schemas';
import { createNonce } from '../utils/crypto';
import { createId } from '../utils/id';
import { getClientIp } from '../utils/network';
import { hashInstallId } from '../utils/crypto';
import { HttpError } from '../utils/errors';
import type { Platform } from '../types';

export const challengeRoutes = new Elysia().post(
  '/challenge',
  async ({ body, headers }) => {
    const clientIp = getClientIp(headers as Record<string, string | undefined>);
    const installHash = hashInstallId(body.installId);

    await applyRateLimit(
      `challenge:${clientIp}:${installHash}`,
      config.rateLimit.challengePerMinute,
    );

    const now = Date.now();
    const challengeId = createId();
    const nonce = createNonce();

    if (body.platform !== 'android') {
      throw new HttpError(403, 'Challenge platform mismatch');
    }

    await brokerStore.createChallenge({
      id: challengeId,
      nonce,
      installHash,
      platform: body.platform as Platform,
      appVersion: body.appVersion,
      createdAt: now,
      expiresAt: now + config.security.challengeTtlSeconds * 1000,
    });

    return {
      challengeId,
      nonce,
      expiresInSec: config.security.challengeTtlSeconds,
    };
  },
  {
    body: ChallengeBodySchema,
  },
);
