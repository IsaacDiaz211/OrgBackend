import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore, openRouterClient } from '../container';
import { getBearerToken } from '../utils/network';
import { safeStringEqual } from '../utils/crypto';
import { HttpError } from '../utils/errors';

export const cronRoutes = new Elysia().get('/cron/reconcile', async ({ headers }) => {
  const authHeader = (headers as Record<string, string | undefined>).authorization;
  const token = getBearerToken(authHeader);
  if (!token || !safeStringEqual(token, config.security.cronSecret)) {
    throw new HttpError(401, 'Invalid cron token');
  }

  const now = Date.now();
  const leasesToExpire = (await brokerStore.listLeases())
    .filter((lease) => lease.status === 'active' && lease.expiresAt <= now);

  let upstreamRevocations = 0;
  let upstreamErrors = 0;
  for (const lease of leasesToExpire) {
    if (openRouterClient.isConfigured()) {
      try {
        await openRouterClient.deleteKey(lease.upstreamHash);
        upstreamRevocations += 1;
      } catch (error) {
        // One upstream failure must not abort the whole reconcile.
        upstreamErrors += 1;
        console.log(
          `[cron] upstream_delete_failed key=${lease.keyHash.slice(0, 10)} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
      }
    }
    await brokerStore.markLeaseExpired(lease.keyHash);
  }

  const cleanup = await brokerStore.cleanupExpired(now);

  // Reconcile gap: an expired/revoked membership must not keep an active
  // upstream lease. Revoke (best-effort upstream + local mark) any active
  // lease whose membership is missing, expired, or revoked.
  let membershipLeasesRevoked = 0;
  const activeLeases = (await brokerStore.listLeases()).filter((lease) => lease.status === 'active');
  for (const lease of activeLeases) {
    const membership = await brokerStore.getMembership(lease.installHash);
    const dead =
      !membership || membership.status !== 'active' || membership.expiresAt <= now;
    if (!dead) continue;
    if (openRouterClient.isConfigured()) {
      try {
        await openRouterClient.deleteKey(lease.upstreamHash);
        upstreamRevocations += 1;
      } catch (error) {
        upstreamErrors += 1;
        console.log(
          `[cron] membership_lease_delete_failed key=${lease.keyHash.slice(0, 10)} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
      }
    }
    await brokerStore.markLeaseRevoked(lease.keyHash);
    membershipLeasesRevoked += 1;
  }

  if (cleanup.invitesExpired || cleanup.membershipsExpired) {
    console.log(
      `[org] cron_cleanup invitesExpired=${cleanup.invitesExpired ?? 0} membershipsExpired=${cleanup.membershipsExpired ?? 0} leasesExpired=${cleanup.leasesExpired} challengesDeleted=${cleanup.challengesDeleted} sessionsDeleted=${cleanup.sessionsDeleted}`,
    );
  }
  if (leasesToExpire.length > 0) {
    console.log(`[cron] expired_leases count=${leasesToExpire.length} upstreamRevocations=${upstreamRevocations}`);
  }

  return {
    ok: true,
    expiredLeases: leasesToExpire.length,
    upstreamRevocations,
    upstreamErrors,
    membershipLeasesRevoked,
    cleanup,
    now: new Date(now).toISOString(),
  };
});
