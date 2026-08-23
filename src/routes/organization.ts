import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore } from '../container';
import { hashInstallId } from '../utils/crypto';
import { hashInviteCode, normalizeInviteCode } from '../utils/inviteCode';
import { OrganizationJoinSchema } from '../schemas';
import { HttpError } from '../utils/errors';

export const organizationRoutes = new Elysia()
  .post(
    '/organization/join',
    async ({ body }) => {
      const code = normalizeInviteCode(body.inviteCode);
      const codeHash = hashInviteCode(code);
      const installHash = hashInstallId(body.installId);

      const existingMembership = await brokerStore.getMembership(installHash);
      if (existingMembership && existingMembership.status === 'active' && existingMembership.expiresAt > Date.now()) {
        throw new HttpError(409, 'already_member');
      }

      const result = await brokerStore.takeInvite(codeHash);
      if (!result.ok) {
        const status = result.reason === 'not_found' ? 404 : result.reason === 'expired' ? 410 : result.reason === 'revoked' ? 403 : 409;
        const message =
          result.reason === 'exhausted'
            ? 'invite_already_used'
            : result.reason === 'expired'
              ? 'invite_expired'
              : result.reason === 'revoked'
                ? 'invite_revoked'
                : 'invite_not_found';
        throw new HttpError(status, message);
      }

      const invite = result.invite;
      if (invite.orgId !== config.org.orgId) {
        // Roll back take is not trivial; treat as not_found for wrong org
        throw new HttpError(404, 'invite_not_found');
      }

      const now = Date.now();
      const membership = {
        installHash,
        orgId: config.org.orgId,
        inviteId: codeHash,
        joinedAt: now,
        expiresAt: now + config.org.defaultTtlDays * 24 * 60 * 60 * 1000,
        budgetCents: config.org.defaultBudgetCents,
        spentCents: 0,
        status: 'active' as const,
      };

      await brokerStore.createMembership(membership);

      console.log(
        `[org] membership_joined install=${installHash.slice(0, 10)} invite=${codeHash.slice(0, 10)} org=${config.org.orgId}`,
      );

      return {
        ok: true,
        installHash: `${installHash.slice(0, 10)}…`,
        orgId: membership.orgId,
        expiresAt: new Date(membership.expiresAt).toISOString(),
        budgetCents: membership.budgetCents,
      };
    },
    { body: OrganizationJoinSchema },
  )
  .get('/organization/status', async ({ headers, query }) => {
    const installId = (query as Record<string, string | undefined>).installId;
    if (!installId) {
      throw new HttpError(400, 'installId query param required');
    }
    const installHash = hashInstallId(installId);
    const membership = await brokerStore.getMembership(installHash);
    if (!membership) {
      throw new HttpError(404, 'membership_not_found');
    }
    const now = Date.now();
    const expiresInMs = Math.max(0, membership.expiresAt - now);
    return {
      installHash: `${membership.installHash.slice(0, 10)}…`,
      orgId: membership.orgId,
      status: membership.status,
      expiresAt: new Date(membership.expiresAt).toISOString(),
      expiresInDays: Math.ceil(expiresInMs / (24 * 60 * 60 * 1000)),
      budgetCents: membership.budgetCents,
      spentCents: membership.spentCents,
      remainingCents: Math.max(0, membership.budgetCents - membership.spentCents),
    };
  });
