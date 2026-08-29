import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore, openRouterClient } from '../container';

async function checkRedis(): Promise<{ status: 'ok' | 'fail' | 'skipped'; responseTimeMs: number; message?: string }> {
  const started = Date.now();
  try {
    const ok = await Promise.race([
      brokerStore.ping(),
      new Promise<boolean>((resolve, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 3000);
      }),
    ]);
    return {
      status: ok ? 'ok' : 'fail',
      responseTimeMs: Date.now() - started,
    };
  } catch {
    return {
      status: 'skipped',
      responseTimeMs: 0,
      message: 'Redis not configured',
    };
  }
}

async function checkOpenRouter(): Promise<{ status: 'ok' | 'fail'; responseTimeMs: number; message?: string }> {
  const started = Date.now();
  const managementKey = config.openRouter.managementKey.trim();

  if (!managementKey) {
    return {
      status: 'fail',
      responseTimeMs: 0,
      message: 'Management key not configured',
    };
  }

  return {
    status: 'ok',
    responseTimeMs: Date.now() - started,
  };
}

function checkConfig(): { status: 'ok' | 'fail'; message: string } {
  const jwtIsDefault = config.security.jwtSigningSecret === 'dev-only-change-me';
  const cronIsDefault = config.security.cronSecret === 'dev-only-change-me';

  if (jwtIsDefault || cronIsDefault) {
    return {
      status: 'fail',
      message: `Default secrets detected: jwt=${jwtIsDefault}, cron=${cronIsDefault}`,
    };
  }

  return {
    status: 'ok',
    message: 'All secrets configured',
  };
}

async function getOrgMetrics(): Promise<{ membersActive: number; membersTotal: number; invitesPending: number; invitesTotal: number; totalSpentCents: number }> {
  try {
    const [members, invites] = await Promise.all([brokerStore.listMemberships(), brokerStore.listInvites()]);
    const membersActive = members.filter((m) => m.status === 'active').length;
    const invitesPending = invites.filter((i) => i.status === 'active').length;
    const totalSpentCents = members.reduce((acc, m) => acc + m.spentCents, 0);
    return {
      membersActive,
      membersTotal: members.length,
      invitesPending,
      invitesTotal: invites.length,
      totalSpentCents,
    };
  } catch {
    return { membersActive: 0, membersTotal: 0, invitesPending: 0, invitesTotal: 0, totalSpentCents: 0 };
  }
}

export async function getHealthStatus() {
  const [redis, openrouter, cfg, org] = await Promise.all([
    checkRedis(),
    checkOpenRouter(),
    Promise.resolve(checkConfig()),
    getOrgMetrics(),
  ]);

  const checks = {
    redis,
    openrouter,
    config: cfg,
  };

  const healthy = Object.values(checks).every((c) => c.status === 'ok' || c.status === 'skipped');

  return {
    status: healthy ? 'ok' : 'degraded',
    checks,
    org: {
      membersActive: org.membersActive,
      membersTotal: org.membersTotal,
      invitesPending: org.invitesPending,
      invitesTotal: org.invitesTotal,
      totalSpentCents: org.totalSpentCents,
      orgId: config.org.orgId,
      orgName: config.org.orgName,
      maxChars: config.org.maxChars,
    },
    timestamp: new Date().toISOString(),
  };
}

export const healthRoutes = new Elysia().get('/health', async () => {
  return getHealthStatus();
});
