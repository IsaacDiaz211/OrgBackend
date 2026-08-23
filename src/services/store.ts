import type {
  ChallengeRecord,
  CleanupReport,
  InviteRecord,
  LeaseRecord,
  MembershipRecord,
  RateLimitDecision,
  SessionRecord,
} from '../types';

type RateBucket = {
  count: number;
  resetAt: number;
};

export type InviteTakeResult =
  | { ok: true; invite: InviteRecord }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'exhausted' };

export type KeyBrokerStore = {
  createChallenge(record: ChallengeRecord): Promise<void>;
  takeChallenge(challengeId: string): Promise<ChallengeRecord | null>;

  saveSession(record: SessionRecord): Promise<void>;
  getSession(jti: string): Promise<SessionRecord | null>;
  revokeSession(jti: string, revokedAt?: number): Promise<void>;

  putLease(record: LeaseRecord): Promise<void>;
  getLeaseByInstall(installHash: string): Promise<LeaseRecord | null>;
  getLeaseByKeyHash(keyHash: string): Promise<LeaseRecord | null>;
  markLeaseRevoked(keyHash: string, revokedAt?: number): Promise<void>;
  markLeaseExpired(keyHash: string): Promise<void>;
  listLeases(): Promise<LeaseRecord[]>;
  markSessionLeased(jti: string): Promise<void>;
  checkRateLimit(bucketKey: string, maxCount: number, windowSeconds: number): Promise<RateLimitDecision>;
  cleanupExpired(now?: number): Promise<CleanupReport>;
  ping(): Promise<boolean>;

  createInvite(record: InviteRecord): Promise<void>;
  getInvite(codeHash: string): Promise<InviteRecord | null>;
  takeInvite(codeHash: string): Promise<InviteTakeResult>;
  revokeInvite(codeHash: string): Promise<boolean>;
  listInvites(): Promise<InviteRecord[]>;

  createMembership(record: MembershipRecord): Promise<void>;
  getMembership(installHash: string): Promise<MembershipRecord | null>;
  updateMembership(
    installHash: string,
    updates: Partial<Pick<MembershipRecord, 'expiresAt' | 'spentCents' | 'budgetCents' | 'status'>>,
  ): Promise<MembershipRecord | null>;
  incrementSpent(installHash: string, deltaCents: number): Promise<MembershipRecord | null>;
  listMemberships(): Promise<MembershipRecord[]>;
};

export class MemoryKeyBrokerStore implements KeyBrokerStore {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly leasesByInstall = new Map<string, LeaseRecord>();
  private readonly leasesByKeyHash = new Map<string, LeaseRecord>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly invites = new Map<string, InviteRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();

  async createChallenge(record: ChallengeRecord): Promise<void> {
    this.challenges.set(record.id, record);
  }

  async takeChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    const challenge = this.challenges.get(challengeId) ?? null;
    if (challenge) {
      this.challenges.delete(challengeId);
    }
    return challenge;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.jti, record);
  }

  async getSession(jti: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(jti) ?? null;
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(jti);
      return null;
    }

    return session;
  }

  async revokeSession(jti: string, revokedAt = Date.now()): Promise<void> {
    const current = this.sessions.get(jti);
    if (!current) {
      return;
    }

    this.sessions.set(jti, {
      ...current,
      revokedAt,
    });
  }

  async putLease(record: LeaseRecord): Promise<void> {
    const currentLease = this.leasesByInstall.get(record.installHash);
    if (currentLease && currentLease.keyHash !== record.keyHash) {
      this.leasesByKeyHash.delete(currentLease.keyHash);
    }

    this.leasesByInstall.set(record.installHash, record);
    this.leasesByKeyHash.set(record.keyHash, record);
  }

  async getLeaseByInstall(installHash: string): Promise<LeaseRecord | null> {
    const lease = this.leasesByInstall.get(installHash) ?? null;
    if (!lease) {
      return null;
    }

    if (lease.status === 'active' && lease.expiresAt <= Date.now()) {
      await this.markLeaseExpired(lease.keyHash);
      return this.leasesByInstall.get(installHash) ?? null;
    }

    return lease;
  }

  async getLeaseByKeyHash(keyHash: string): Promise<LeaseRecord | null> {
    const lease = this.leasesByKeyHash.get(keyHash) ?? null;
    if (!lease) {
      return null;
    }

    if (lease.status === 'active' && lease.expiresAt <= Date.now()) {
      await this.markLeaseExpired(lease.keyHash);
      return this.leasesByKeyHash.get(keyHash) ?? null;
    }

    return lease;
  }

  async markLeaseRevoked(keyHash: string, revokedAt = Date.now()): Promise<void> {
    const lease = this.leasesByKeyHash.get(keyHash);
    if (!lease) {
      return;
    }

    const updated: LeaseRecord = {
      ...lease,
      status: 'revoked',
      revokedAt,
    };

    this.leasesByKeyHash.set(keyHash, updated);
    this.leasesByInstall.set(updated.installHash, updated);
  }

  async markLeaseExpired(keyHash: string): Promise<void> {
    const lease = this.leasesByKeyHash.get(keyHash);
    if (!lease) {
      return;
    }

    const updated: LeaseRecord = {
      ...lease,
      status: 'expired',
    };

    this.leasesByKeyHash.set(keyHash, updated);
    this.leasesByInstall.set(updated.installHash, updated);
  }

  async listLeases(): Promise<LeaseRecord[]> {
    return Array.from(this.leasesByKeyHash.values());
  }

  async checkRateLimit(
    bucketKey: string,
    maxCount: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const existing = this.rateBuckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowSeconds * 1000;
      this.rateBuckets.set(bucketKey, {
        count: 1,
        resetAt,
      });

      return {
        allowed: true,
        remaining: Math.max(0, maxCount - 1),
        resetAt,
      };
    }

    existing.count += 1;
    this.rateBuckets.set(bucketKey, existing);

    const allowed = existing.count <= maxCount;
    return {
      allowed,
      remaining: Math.max(0, maxCount - existing.count),
      resetAt: existing.resetAt,
    };
  }

  async cleanupExpired(now = Date.now()): Promise<CleanupReport> {
    let challengesDeleted = 0;
    let sessionsDeleted = 0;
    let rateBucketsDeleted = 0;
    let leasesExpired = 0;
    let invitesExpired = 0;
    let membershipsExpired = 0;

    for (const [challengeId, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(challengeId);
        challengesDeleted += 1;
      }
    }

    for (const [jti, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(jti);
        sessionsDeleted += 1;
      }
    }

    for (const [bucketKey, bucket] of this.rateBuckets.entries()) {
      if (bucket.resetAt <= now) {
        this.rateBuckets.delete(bucketKey);
        rateBucketsDeleted += 1;
      }
    }

    for (const [keyHash, lease] of this.leasesByKeyHash.entries()) {
      if (lease.status === 'active' && lease.expiresAt <= now) {
        await this.markLeaseExpired(keyHash);
        leasesExpired += 1;
      }
    }

    for (const [codeHash, invite] of this.invites.entries()) {
      if (invite.status === 'active' && invite.expiresAt <= now) {
        this.invites.set(codeHash, { ...invite, status: 'expired' });
        invitesExpired += 1;
      }
    }

    for (const [installHash, membership] of this.memberships.entries()) {
      if (membership.status === 'active' && membership.expiresAt <= now) {
        this.memberships.set(installHash, { ...membership, status: 'expired' });
        membershipsExpired += 1;
      }
    }

    return {
      challengesDeleted,
      sessionsDeleted,
      rateBucketsDeleted,
      leasesExpired,
      invitesExpired,
      membershipsExpired,
    };
  }

  async markSessionLeased(jti: string): Promise<void> {
    const session = this.sessions.get(jti);
    if (!session) return;
    this.sessions.set(jti, { ...session, hasLeased: true });
  }

  async ping(): Promise<boolean> {
    return true;
  }

  // --- Invites ---
  async createInvite(record: InviteRecord): Promise<void> {
    this.invites.set(record.codeHash, record);
  }

  async getInvite(codeHash: string): Promise<InviteRecord | null> {
    const invite = this.invites.get(codeHash) ?? null;
    if (!invite) return null;
    if (invite.status === 'active' && invite.expiresAt <= Date.now()) {
      const expired = { ...invite, status: 'expired' as const };
      this.invites.set(codeHash, expired);
      return expired;
    }
    return invite;
  }

  async takeInvite(codeHash: string): Promise<InviteTakeResult> {
    const invite = this.invites.get(codeHash) ?? null;
    if (!invite) return { ok: false, reason: 'not_found' };
    if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
    if (invite.status === 'expired' || invite.expiresAt <= Date.now()) {
      this.invites.set(codeHash, { ...invite, status: 'expired' });
      return { ok: false, reason: 'expired' };
    }
    if (invite.used >= invite.maxUses) return { ok: false, reason: 'exhausted' };
    const updated: InviteRecord = { ...invite, used: invite.used + 1 };
    if (updated.used >= updated.maxUses) {
      // keep active until maxUses exhausted but used marks it; leave status active for listing
    }
    this.invites.set(codeHash, updated);
    return { ok: true, invite: updated };
  }

  async revokeInvite(codeHash: string): Promise<boolean> {
    const invite = this.invites.get(codeHash);
    if (!invite) return false;
    if (invite.status === 'revoked') return true;
    this.invites.set(codeHash, { ...invite, status: 'revoked' });
    return true;
  }

  async listInvites(): Promise<InviteRecord[]> {
    return Array.from(this.invites.values());
  }

  // --- Memberships ---
  async createMembership(record: MembershipRecord): Promise<void> {
    this.memberships.set(record.installHash, record);
  }

  async getMembership(installHash: string): Promise<MembershipRecord | null> {
    const m = this.memberships.get(installHash) ?? null;
    if (!m) return null;
    if (m.status === 'active' && m.expiresAt <= Date.now()) {
      const expired = { ...m, status: 'expired' as const };
      this.memberships.set(installHash, expired);
      return expired;
    }
    return m;
  }

  async updateMembership(
    installHash: string,
    updates: Partial<Pick<MembershipRecord, 'expiresAt' | 'spentCents' | 'budgetCents' | 'status'>>,
  ): Promise<MembershipRecord | null> {
    const current = this.memberships.get(installHash);
    if (!current) return null;
    const updated: MembershipRecord = { ...current, ...updates };
    this.memberships.set(installHash, updated);
    return updated;
  }

  async incrementSpent(installHash: string, deltaCents: number): Promise<MembershipRecord | null> {
    const current = await this.getMembership(installHash);
    if (!current) return null;
    const updated: MembershipRecord = { ...current, spentCents: current.spentCents + deltaCents };
    this.memberships.set(installHash, updated);
    return updated;
  }

  async listMemberships(): Promise<MembershipRecord[]> {
    // Ensure expired status is reflected
    for (const [k, m] of this.memberships.entries()) {
      if (m.status === 'active' && m.expiresAt <= Date.now()) {
        this.memberships.set(k, { ...m, status: 'expired' });
      }
    }
    return Array.from(this.memberships.values());
  }
}
