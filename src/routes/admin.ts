import { Elysia } from 'elysia';
import { config } from '../config';
import { brokerStore, openRouterClient } from '../container';
import { requireAdmin } from '../plugins/auth';
import { applyRateLimit } from '../plugins/rateLimit';
import { InviteCreateSchema, MembershipRefillSchema, MembershipRevokeSchema } from '../schemas';
import { generateInviteCode, hashInviteCode } from '../utils/inviteCode';
import { HttpError } from '../utils/errors';
import { getClientIp } from '../utils/network';

const adminRateLimit = async (headers: Record<string, string | undefined>) => {
  const clientIp = getClientIp(headers);
  await applyRateLimit(`admin:${clientIp}`, config.rateLimit.adminPerMinute);
};

export const adminRoutes = new Elysia()
  .post(
    '/admin/invites',
    async ({ body, headers, query, set }) => {
      requireAdmin(headers as Record<string, string | undefined>);
      await adminRateLimit(headers as Record<string, string | undefined>);
      const ttlDays = body.ttlDays ?? config.org.inviteTtlDays;
      const maxUses = body.maxUses ?? 1;
      // batch support: ?count=5 or body.count (1..10)
      const rawCount = (query as Record<string, string | undefined>)?.count ?? (body as Record<string, unknown>).count;
      let count = 1;
      if (rawCount !== undefined) {
        const parsed = Number(rawCount);
        if (Number.isFinite(parsed)) count = Math.min(10, Math.max(1, Math.trunc(parsed)));
      }
      const now = Date.now();
      const results: Array<{ code: string; codeHash: string; expiresAt: string; maxUses: number }> = [];
      for (let i = 0; i < count; i += 1) {
        const code = generateInviteCode();
        const codeHash = hashInviteCode(code);
        const record = {
          codeHash,
          orgId: config.org.orgId,
          createdAt: now,
          expiresAt: now + ttlDays * 24 * 60 * 60 * 1000,
          maxUses,
          used: 0,
          createdBy: 'admin',
          status: 'active' as const,
          note: body.note,
        };
        await brokerStore.createInvite(record);
        console.log(`[org] invite_created codeHash=${codeHash.slice(0, 10)} ttlDays=${ttlDays} maxUses=${maxUses} note=${body.note ?? ''}`);
        results.push({
          code,
          codeHash: `${codeHash.slice(0, 10)}…`,
          expiresAt: new Date(record.expiresAt).toISOString(),
          maxUses,
        });
      }
      set.status = 201;
      if (count === 1) return results[0]!;
      return { invites: results, count };
    },
    { body: InviteCreateSchema },
  )
  .get('/admin/invites', async ({ headers, query }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const statusFilter = (query as Record<string, string | undefined>)?.status;
    const limitRaw = (query as Record<string, string | undefined>)?.limit;
    const cursor = (query as Record<string, string | undefined>)?.cursor;
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50;
    let invites = await brokerStore.listInvites();
    if (statusFilter) {
      invites = invites.filter((i) => i.status === statusFilter);
    }
    // cursor pagination: cursor is codeHash prefix or full hash to start after
    let startIdx = 0;
    if (cursor) {
      const idx = invites.findIndex((i) => i.codeHash === cursor || i.codeHash.startsWith(cursor));
      if (idx >= 0) startIdx = idx + 1;
    }
    const sliced = invites.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < invites.length ? sliced[sliced.length - 1]?.codeHash : undefined;
    return {
      invites: sliced.map((i) => ({
        codeHash: `${i.codeHash.slice(0, 10)}…`,
        codeHashFull: i.codeHash,
        orgId: i.orgId,
        createdAt: new Date(i.createdAt).toISOString(),
        expiresAt: new Date(i.expiresAt).toISOString(),
        maxUses: i.maxUses,
        used: i.used,
        status: i.status,
        note: i.note,
      })),
      total: invites.length,
      nextCursor,
    };
  })
  .delete('/admin/invites/:codeHash', async ({ headers, params }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const codeHash = (params as { codeHash: string }).codeHash;
    const normalizedHash = codeHash.length === 64 ? codeHash.toLowerCase() : hashInviteCode(codeHash);
    const raw = await brokerStore.getInvite(normalizedHash);
    if (!raw) throw new HttpError(404, 'invite_not_found');
    if (raw.used > 0) throw new HttpError(409, 'invite_already_used');
    await brokerStore.revokeInvite(normalizedHash);
    console.log(`[org] invite_revoked codeHash=${normalizedHash.slice(0, 10)} reason=admin_delete`);
    return { ok: true, codeHash: `${normalizedHash.slice(0, 10)}…` };
  })
  .get('/admin/members', async ({ headers, query }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const statusFilter = (query as Record<string, string | undefined>)?.status;
    const limitRaw = (query as Record<string, string | undefined>)?.limit;
    const cursor = (query as Record<string, string | undefined>)?.cursor;
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50;
    let members = await brokerStore.listMemberships();
    // stable sort by joinedAt ascending for cursor determinism
    members = [...members].sort((a, b) => a.joinedAt - b.joinedAt);
    if (statusFilter) {
      members = members.filter((m) => m.status === statusFilter);
    }
    let startIdx = 0;
    if (cursor) {
      const idx = members.findIndex((m) => m.installHash === cursor);
      if (idx >= 0) startIdx = idx + 1;
    }
    const sliced = members.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < members.length ? sliced[sliced.length - 1]?.installHash : undefined;
    return {
      members: sliced.map((m) => ({
        installHash: `${m.installHash.slice(0, 10)}…`,
        installHashFull: m.installHash,
        orgId: m.orgId,
        joinedAt: new Date(m.joinedAt).toISOString(),
        expiresAt: new Date(m.expiresAt).toISOString(),
        budgetCents: m.budgetCents,
        spentCents: m.spentCents,
        remainingCents: Math.max(0, m.budgetCents - m.spentCents),
        status: m.status,
        inviteId: `${m.inviteId.slice(0, 10)}…`,
        inviteIdFull: m.inviteId,
      })),
      total: members.length,
      nextCursor,
    };
  })
  .get('/admin/members/:hash/usage', async ({ headers, params }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const hash = (params as { hash: string }).hash;
    const membership = await brokerStore.getMembership(hash);
    if (!membership) throw new HttpError(404, 'membership_not_found');
    const generations = Math.floor(membership.spentCents / Math.max(1, config.org.costPerGenerationCents));
    const today = new Date().toISOString().slice(0, 10);
    return {
      installHash: `${membership.installHash.slice(0, 10)}…`,
      installHashFull: membership.installHash,
      budgetCents: membership.budgetCents,
      spentCents: membership.spentCents,
      remainingCents: Math.max(0, membership.budgetCents - membership.spentCents),
      status: membership.status,
      expiresAt: new Date(membership.expiresAt).toISOString(),
      // history per date — for now single bucket (today) since per-generation tracking is aggregated
      history: [
        {
          date: today,
          generations,
          spentCents: membership.spentCents,
        },
      ],
    };
  })
  // single membership detail (useful for admin drill-down)
  .get('/admin/members/:hash', async ({ headers, params }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const hash = (params as { hash: string }).hash;
    const m = await brokerStore.getMembership(hash);
    if (!m) throw new HttpError(404, 'membership_not_found');
    return {
      installHash: `${m.installHash.slice(0, 10)}…`,
      installHashFull: m.installHash,
      orgId: m.orgId,
      joinedAt: new Date(m.joinedAt).toISOString(),
      expiresAt: new Date(m.expiresAt).toISOString(),
      budgetCents: m.budgetCents,
      spentCents: m.spentCents,
      remainingCents: Math.max(0, m.budgetCents - m.spentCents),
      status: m.status,
      inviteId: `${m.inviteId.slice(0, 10)}…`,
      inviteIdFull: m.inviteId,
    };
  })
  .post(
    '/admin/members/:hash/refill',
    async ({ headers, params, body }) => {
      requireAdmin(headers as Record<string, string | undefined>);
      await adminRateLimit(headers as Record<string, string | undefined>);
      const hash = (params as { hash: string }).hash;
      const membership = await brokerStore.getMembership(hash);
      if (!membership) throw new HttpError(404, 'membership_not_found');
      const addCents = body.addCents;
      const extendDays = body.extendDays ?? 0;
      const now = Date.now();
      const baseExpiry = Math.max(membership.expiresAt, now);
      const newExpiresAt = extendDays > 0 ? baseExpiry + extendDays * 24 * 60 * 60 * 1000 : membership.expiresAt;
      const newSpent = Math.max(0, membership.spentCents - addCents);
      const updated = await brokerStore.updateMembership(hash, {
        spentCents: newSpent,
        expiresAt: newExpiresAt,
        status: 'active',
      });
      if (!updated) throw new HttpError(404, 'membership_not_found');
      console.log(`[org] membership_refill install=${hash.slice(0, 10)} addCents=${addCents} extendDays=${extendDays} newSpent=${updated.spentCents} newExpiresAt=${new Date(updated.expiresAt).toISOString()}`);
      return {
        ok: true,
        installHash: `${updated.installHash.slice(0, 10)}…`,
        installHashFull: updated.installHash,
        spentCents: updated.spentCents,
        budgetCents: updated.budgetCents,
        remainingCents: Math.max(0, updated.budgetCents - updated.spentCents),
        expiresAt: new Date(updated.expiresAt).toISOString(),
        status: updated.status,
      };
    },
    { body: MembershipRefillSchema },
  )
  .post(
    '/admin/members/:hash/revoke',
    async ({ headers, params, body }) => {
      requireAdmin(headers as Record<string, string | undefined>);
      await adminRateLimit(headers as Record<string, string | undefined>);
      const hash = (params as { hash: string }).hash;
      const membership = await brokerStore.getMembership(hash);
      if (!membership) throw new HttpError(404, 'membership_not_found');
      const updated = await brokerStore.updateMembership(hash, { status: 'revoked' });
      const lease = await brokerStore.getLeaseByInstall(hash);
      if (lease && lease.status === 'active') {
        // Best-effort upstream delete: the leased key must not stay valid.
        if (openRouterClient.isConfigured()) {
          try {
            await openRouterClient.deleteKey(lease.upstreamHash);
          } catch (error) {
            console.log(
              `[org] membership_revoke_upstream_failed install=${hash.slice(0, 10)} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
            );
          }
        }
        await brokerStore.markLeaseRevoked(lease.keyHash);
      }
      console.log(`[org] membership_revoked install=${hash.slice(0, 10)} reason=${body.reason ?? ''} leaseRevoked=${Boolean(lease && lease.status === 'active')}`);
      return {
        ok: true,
        installHash: `${updated?.installHash.slice(0, 10) ?? hash.slice(0, 10)}…`,
        installHashFull: updated?.installHash ?? hash,
        status: updated?.status ?? 'revoked',
      };
    },
    { body: MembershipRevokeSchema },
  )
  .get('/admin/usage/summary', async ({ headers }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const members = await brokerStore.listMemberships();
    const invites = await brokerStore.listInvites();
    const totalSpent = members.reduce((acc, m) => acc + m.spentCents, 0);
    const totalBudget = members.reduce((acc, m) => acc + m.budgetCents, 0);
    return {
      totalMembers: members.length,
      active: members.filter((m) => m.status === 'active').length,
      expired: members.filter((m) => m.status === 'expired').length,
      revoked: members.filter((m) => m.status === 'revoked').length,
      totalSpentCents: totalSpent,
      totalBudgetCents: totalBudget,
      totalRemainingCents: Math.max(0, totalBudget - totalSpent),
      totalGenerationsApprox: Math.floor(totalSpent / Math.max(1, config.org.costPerGenerationCents)),
      invitesPending: invites.filter((i) => i.status === 'active').length,
      invitesTotal: invites.length,
      costPerGenerationCents: config.org.costPerGenerationCents,
      orgId: config.org.orgId,
      orgName: config.org.orgName,
    };
  })
  .get('/admin/export.csv', async ({ headers, set }) => {
    requireAdmin(headers as Record<string, string | undefined>);
    await adminRateLimit(headers as Record<string, string | undefined>);
    const members = await brokerStore.listMemberships();
    const header = 'installHash,orgId,joinedAt,expiresAt,budgetCents,spentCents,remainingCents,status,inviteId';
    const rows = members
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => {
        const remaining = Math.max(0, m.budgetCents - m.spentCents);
        return [
          m.installHash,
          m.orgId,
          new Date(m.joinedAt).toISOString(),
          new Date(m.expiresAt).toISOString(),
          String(m.budgetCents),
          String(m.spentCents),
          String(remaining),
          m.status,
          m.inviteId,
        ].join(',');
      });
    const csv = [header, ...rows].join('\n');
    set.headers['content-type'] = 'text/csv; charset=utf-8';
    set.headers['content-disposition'] = 'attachment; filename="org-members.csv"';
    console.log(`[org] export_csv rows=${members.length}`);
    return csv;
  });
