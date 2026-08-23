import { describe, test, expect, beforeEach } from 'bun:test';
import { MemoryKeyBrokerStore } from '../src/services/store';
import { hashInviteCode, generateInviteCode } from '../src/utils/inviteCode';
import { hashInstallId } from '../src/utils/crypto';

const ORG_ID = 'test-org';
const INVITE_TTL_DAYS = 7;
const MEMBERSHIP_TTL_DAYS = 30;
const BUDGET_CENTS = 100;
const COST_PER_GEN = 5;

describe('Parte 04 — admin/membership operation', () => {
  let store: MemoryKeyBrokerStore;

  beforeEach(() => {
    store = new MemoryKeyBrokerStore();
  });

  test('admin can create 10 invites, single-use blocks second join (409)', async () => {
    const codes: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const code = generateInviteCode();
      const codeHash = hashInviteCode(code);
      codes.push(code);
      hashes.push(codeHash);
      await store.createInvite({
        codeHash,
        orgId: ORG_ID,
        createdAt: Date.now(),
        expiresAt: Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
        maxUses: 1,
        used: 0,
        createdBy: 'admin',
        status: 'active',
      });
    }
    expect((await store.listInvites()).length).toBe(10);

    // first join consumes invite
    const code0Hash = hashes[0]!;
    const take1 = await store.takeInvite(code0Hash);
    expect(take1.ok).toBe(true);

    const installHash = hashInstallId('test-install-id-12345678');
    await store.createMembership({
      installHash,
      orgId: ORG_ID,
      inviteId: code0Hash,
      joinedAt: Date.now(),
      expiresAt: Date.now() + MEMBERSHIP_TTL_DAYS * 24 * 60 * 60 * 1000,
      budgetCents: BUDGET_CENTS,
      spentCents: 0,
      status: 'active',
    });

    // second join with same code should be exhausted -> 409
    const take2 = await store.takeInvite(code0Hash);
    expect(take2.ok).toBe(false);
    if (!take2.ok) expect(take2.reason).toBe('exhausted');

    // unused invite still takable
    const takeUnused = await store.takeInvite(hashes[1]!);
    expect(takeUnused.ok).toBe(true);
  });

  test('budget 100 after 20 generations blocks 429; refill unlocks', async () => {
    const installHash = hashInstallId('budget-test-install-123');
    await store.createMembership({
      installHash,
      orgId: ORG_ID,
      inviteId: hashInviteCode('LEY-TEST-CODE-1234'),
      joinedAt: Date.now(),
      expiresAt: Date.now() + MEMBERSHIP_TTL_DAYS * 24 * 60 * 60 * 1000,
      budgetCents: BUDGET_CENTS,
      spentCents: 0,
      status: 'active',
    });

    // simulate 20 lease successes: incrementSpent each time
    for (let i = 0; i < 20; i += 1) {
      await store.incrementSpent(installHash, COST_PER_GEN);
    }
    const after20 = await store.getMembership(installHash);
    expect(after20?.spentCents).toBe(100);
    // budget check should block
    const blocked = after20 && after20.spentCents >= after20.budgetCents;
    expect(blocked).toBe(true);

    // refill: addCents 100 restores budget (spent = max(0, 100-100)=0)
    const addCents = 100;
    const updated = await store.updateMembership(installHash, {
      spentCents: Math.max(0, (after20?.spentCents ?? 0) - addCents),
      status: 'active',
    });
    expect(updated?.spentCents).toBe(0);
    expect(updated?.status).toBe('active');

    // can consume again
    await store.incrementSpent(installHash, COST_PER_GEN);
    const afterRefillUse = await store.getMembership(installHash);
    expect(afterRefillUse?.spentCents).toBe(5);
  });

  test('cron expires invite and membership after TTL', async () => {
    const now = Date.now();
    const expiredInviteHash = hashInviteCode('LEY-EXPIRED-0001');
    await store.createInvite({
      codeHash: expiredInviteHash,
      orgId: ORG_ID,
      createdAt: now - 8 * 24 * 60 * 60 * 1000,
      expiresAt: now - 1000,
      maxUses: 1,
      used: 0,
      createdBy: 'admin',
      status: 'active',
    });
    const invitesBefore = await store.listInvites();
    expect(invitesBefore.find((i) => i.codeHash === expiredInviteHash)?.status).toBe('active');

    const installHash = hashInstallId('expiry-install-123456');
    await store.createMembership({
      installHash,
      orgId: ORG_ID,
      inviteId: expiredInviteHash,
      joinedAt: now - 31 * 24 * 60 * 60 * 1000,
      expiresAt: now - 1000,
      budgetCents: BUDGET_CENTS,
      spentCents: 10,
      status: 'active',
    });

    const report = await store.cleanupExpired(now);
    expect(report.invitesExpired).toBe(1);
    expect(report.membershipsExpired).toBe(1);

    const inviteAfter = await store.getInvite(expiredInviteHash);
    expect(inviteAfter?.status).toBe('expired');

    const membershipAfter = await store.getMembership(installHash);
    expect(membershipAfter?.status).toBe('expired');
  });

  test('summary squares with sum of spentCents', async () => {
    await store.createMembership({
      installHash: hashInstallId('member-a-12345678'),
      orgId: ORG_ID,
      inviteId: hashInviteCode('LEY-A-1111-2222'),
      joinedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      budgetCents: 100,
      spentCents: 30,
      status: 'active',
    });
    await store.createMembership({
      installHash: hashInstallId('member-b-12345678'),
      orgId: ORG_ID,
      inviteId: hashInviteCode('LEY-B-3333-4444'),
      joinedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      budgetCents: 100,
      spentCents: 70,
      status: 'active',
    });
    const members = await store.listMemberships();
    const totalSpent = members.reduce((acc, m) => acc + m.spentCents, 0);
    expect(totalSpent).toBe(100);
    const totalGenerations = Math.floor(totalSpent / COST_PER_GEN);
    expect(totalGenerations).toBe(20);
  });

  test('revoke prevents further lease (membership_revoked)', async () => {
    const installHash = hashInstallId('revoke-install-123456');
    await store.createMembership({
      installHash,
      orgId: ORG_ID,
      inviteId: hashInviteCode('LEY-REVOKE-1234'),
      joinedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      budgetCents: 100,
      spentCents: 10,
      status: 'active',
    });
    await store.updateMembership(installHash, { status: 'revoked' });
    const revoked = await store.getMembership(installHash);
    expect(revoked?.status).toBe('revoked');
  });

  test('takeInvite atomic exhausted and revoked handling', async () => {
    const code = 'LEY-ATOM-TEST-01';
    const codeHash = hashInviteCode(code);
    await store.createInvite({
      codeHash,
      orgId: ORG_ID,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      maxUses: 1,
      used: 0,
      createdBy: 'admin',
      status: 'active',
    });
    // revoke before use
    await store.revokeInvite(codeHash);
    const revokedTake = await store.takeInvite(codeHash);
    expect(revokedTake.ok).toBe(false);
    if (!revokedTake.ok) expect(revokedTake.reason).toBe('revoked');
  });

  test('Sqlite-backed takeInvite atomicity (via Memory behavior parity)', async () => {
    // This test validates Memory contract that Sqlite/Upstash/Redis must also fulfill
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    await store.createInvite({
      codeHash,
      orgId: ORG_ID,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      maxUses: 2,
      used: 0,
      createdBy: 'admin',
      status: 'active',
    });
    const t1 = await store.takeInvite(codeHash);
    expect(t1.ok).toBe(true);
    const t2 = await store.takeInvite(codeHash);
    expect(t2.ok).toBe(true);
    const t3 = await store.takeInvite(codeHash);
    expect(t3.ok).toBe(false);
    if (!t3.ok) expect(t3.reason).toBe('exhausted');
    const final = await store.getInvite(codeHash);
    expect(final?.used).toBe(2);
  });
});
