import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore, openRouterClient } from '../container';
import { membershipEnforced, requireMembership, requireSession, validateInstallOwnership } from '../plugins/auth';
import { applyRateLimit } from '../plugins/rateLimit';
import { LeaseBodySchema, RevokeBodySchema } from '../schemas';
import { getClientIp } from '../utils/network';
import { safeStringEqual } from '../utils/crypto';
import { HttpError } from '../utils/errors';
import type { LeaseReason } from '../types';

export const openrouterRoutes = new Elysia()
  .post(
    '/openrouter/lease',
    async ({ body, headers }) => {
      const startedAt = Date.now();
      let stage = 'requireSession';
      let installHash = '';

      const session = await requireSession(headers as Record<string, string | undefined>);
      if (session.sessionRecord.hasLeased) {
        throw new HttpError(409, 'Session already has an active lease');
      }

      try {
        const sessionClaims = session.claims;

        stage = 'validateInstallOwnership';
        installHash = validateInstallOwnership(sessionClaims.sub, body.installId);

        if (membershipEnforced()) {
          stage = 'requireMembership';
          try {
            await requireMembership(installHash);
          } catch (error) {
            const msg = error instanceof HttpError ? error.message : String(error);
            const reason =
              msg === 'budget_exhausted'
                ? 'budget'
                : msg === 'membership_expired' || msg === 'membership_revoked'
                  ? msg
                  : 'membership';
            console.log(`[org] lease_blocked reason=${reason} install=${installHash.slice(0, 10)} msg=${msg}`);
            throw error;
          }
        }

        stage = 'applyRateLimit';
        const clientIp = getClientIp(headers as Record<string, string | undefined>);
        await applyRateLimit(`lease:${clientIp}:${installHash}`, config.rateLimit.leasePerMinute);

        if (!openRouterClient.isConfigured()) {
          throw new HttpError(503, 'OpenRouter management key is not configured');
        }

        stage = 'getLeaseByInstall';
        const activeLease = await brokerStore.getLeaseByInstall(installHash);
                if (activeLease?.status === 'active') {
                  stage = 'deletePreviousUpstreamKey';
                  await openRouterClient.deleteKey(activeLease.upstreamHash);

                  stage = 'markPreviousLeaseRevoked';
                  await brokerStore.markLeaseRevoked(activeLease.keyHash);
                }

        const now = Date.now();
        const reason = body.reason as LeaseReason;

        stage = 'createUpstreamKey';
        const managed = await openRouterClient.createKey({
          name: `${config.openRouter.keyNamePrefix}-${installHash.slice(0, 10)}-${now}`,
          limit: config.openRouter.keyLimit,
          limitReset: config.openRouter.keyLimitReset,
          includeByokInLimit: config.openRouter.includeByokInLimit,
          extraPayload: config.openRouter.extraCreatePayload,
        });

        const expiresAt = now + config.openRouter.keyHardExpiresSeconds * 1000;
        stage = 'persistLease';
        await brokerStore.putLease({
          installHash,
          keyHash: managed.hash,
          upstreamHash: managed.hash,
          label: managed.label,
          name: managed.name ?? `${config.openRouter.keyNamePrefix}-${installHash.slice(0, 10)}`,
          status: 'active',
          reason,
          createdAt: now,
          expiresAt,
          rotateAfterSec: config.openRouter.keyRotateAfterSeconds,
        });

        await brokerStore.markSessionLeased(session.claims.jti);

        if (membershipEnforced()) {
          try {
            const updated = await brokerStore.incrementSpent(installHash, config.org.costPerGenerationCents);
            if (updated) {
              console.log(
                `[org] spent_increment install=${installHash.slice(0, 10)} delta=${config.org.costPerGenerationCents} spent=${updated.spentCents}/${updated.budgetCents}`,
              );
            }
          } catch {
            // non-blocking
          }
        }

        console.log(
          `[lease] success durationMs=${Date.now() - startedAt} install=${installHash.slice(0, 10)}`,
        );

        return {
          apiKey: managed.key,
          keyHash: managed.hash,
          expiresAt: new Date(expiresAt).toISOString(),
          rotateAfterSec: config.openRouter.keyRotateAfterSeconds,
        };
      } catch (error) {
        console.log(
          `[lease] failed stage=${stage} durationMs=${Date.now() - startedAt} install=${installHash.slice(0, 10)}`,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        );
        throw error;
      }
    },
    {
      body: LeaseBodySchema,
    },
  )
  .post(
    '/openrouter/revoke',
    async ({ body, headers }) => {
      const session = await requireSession(headers as Record<string, string | undefined>);
      const sessionClaims = session.claims;
      const lease = await brokerStore.getLeaseByKeyHash(body.keyHash);
      if (!lease) {
        throw new HttpError(404, 'Key lease not found');
      }

      if (!safeStringEqual(lease.installHash, sessionClaims.sub)) {
        throw new HttpError(403, 'Cannot revoke lease from another installId');
      }

      if (lease.status !== 'active') {
        return {
          revoked: false,
          keyHash: lease.keyHash,
          status: lease.status,
        };
      }

              if (openRouterClient.isConfigured()) {
                await openRouterClient.deleteKey(lease.upstreamHash);
              }

      await brokerStore.markLeaseRevoked(lease.keyHash);

      return {
        revoked: true,
        keyHash: lease.keyHash,
        status: 'revoked',
      };
    },
    {
      body: RevokeBodySchema,
    },
  );
