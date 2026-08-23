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
  for (const lease of leasesToExpire) {
    if (openRouterClient.isConfigured()) {
      await openRouterClient.deleteKey(lease.upstreamHash);
      upstreamRevocations += 1;
    }
    await brokerStore.markLeaseExpired(lease.keyHash);
  }

  const cleanup = await brokerStore.cleanupExpired(now);

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
    cleanup,
    now: new Date(now).toISOString(),
  };
});
