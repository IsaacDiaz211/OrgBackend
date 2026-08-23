import { Redis } from '@upstash/redis';

import type {
  ChallengeRecord,
  CleanupReport,
  InviteRecord,
  LeaseRecord,
  MembershipRecord,
  RateLimitDecision,
  SessionRecord,
} from '../types';
import type { InviteTakeResult, KeyBrokerStore } from './store';

const LEASES_INDEX_KEY = 'leases:index';

const toSecondsUntil = (timestampMs: number, floorSeconds = 1): number => {
  const deltaSeconds = Math.ceil((timestampMs - Date.now()) / 1000);
  return Math.max(floorSeconds, deltaSeconds);
};

const decodeJson = <T>(value: unknown): T | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  if (typeof value === 'object') {
    return value as T;
  }

  return null;
};

export class UpstashKeyBrokerStore implements KeyBrokerStore {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({
      url,
      token,
    });
  }

  private challengeKey(challengeId: string): string {
    return `challenge:${challengeId}`;
  }

  private sessionKey(jti: string): string {
    return `session:${jti}`;
  }

  private leaseInstallKey(installHash: string): string {
    return `lease:install:${installHash}`;
  }

  private leaseHashKey(keyHash: string): string {
    return `lease:hash:${keyHash}`;
  }

  private inviteKey(codeHash: string): string {
    return `invite:${codeHash}`;
  }

  private membershipKey(installHash: string): string {
    return `membership:${installHash}`;
  }

  private async getLeaseByHashRaw(keyHash: string): Promise<LeaseRecord | null> {
    const raw = await this.redis.get(this.leaseHashKey(keyHash));
    return decodeJson<LeaseRecord>(raw);
  }

  async createChallenge(record: ChallengeRecord): Promise<void> {
    await this.redis.set(this.challengeKey(record.id), JSON.stringify(record), {
      ex: toSecondsUntil(record.expiresAt),
    });
  }

  async takeChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    const key = this.challengeKey(challengeId);
    const raw = await this.redis.get(key);
    await this.redis.del(key);
    return decodeJson<ChallengeRecord>(raw);
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.redis.set(this.sessionKey(record.jti), JSON.stringify(record), {
      ex: toSecondsUntil(record.expiresAt),
    });
  }

  async getSession(jti: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.sessionKey(jti));
    const session = decodeJson<SessionRecord>(raw);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      await this.redis.del(this.sessionKey(jti));
      return null;
    }

    return session;
  }

  async revokeSession(jti: string, revokedAt = Date.now()): Promise<void> {
    const current = await this.getSession(jti);
    if (!current) {
      return;
    }

    const updated: SessionRecord = {
      ...current,
      revokedAt,
    };

    await this.redis.set(this.sessionKey(jti), JSON.stringify(updated), {
      ex: toSecondsUntil(updated.expiresAt),
    });
  }

  private async persistLease(record: LeaseRecord): Promise<void> {
    const leaseTtl = toSecondsUntil(record.expiresAt, 60) + 86400;

    await this.redis.set(this.leaseInstallKey(record.installHash), JSON.stringify(record), {
      ex: leaseTtl,
    });

    await this.redis.set(this.leaseHashKey(record.keyHash), JSON.stringify(record), {
      ex: leaseTtl,
    });

    await this.redis.sadd(LEASES_INDEX_KEY, record.keyHash);
  }

  async putLease(record: LeaseRecord): Promise<void> {
    const currentLease = await this.getLeaseByInstall(record.installHash);
    if (currentLease && currentLease.keyHash !== record.keyHash) {
      await this.redis.del(this.leaseHashKey(currentLease.keyHash));
      await this.redis.srem(LEASES_INDEX_KEY, currentLease.keyHash);
    }

    await this.persistLease(record);
  }

  async getLeaseByInstall(installHash: string): Promise<LeaseRecord | null> {
    const raw = await this.redis.get(this.leaseInstallKey(installHash));
    const lease = decodeJson<LeaseRecord>(raw);
    if (!lease) {
      return null;
    }

    if (lease.status === 'active' && lease.expiresAt <= Date.now()) {
      const expiredLease: LeaseRecord = {
        ...lease,
        status: 'expired',
      };
      await this.persistLease(expiredLease);
      return expiredLease;
    }

    return lease;
  }

  async getLeaseByKeyHash(keyHash: string): Promise<LeaseRecord | null> {
    const lease = await this.getLeaseByHashRaw(keyHash);
    if (!lease) {
      return null;
    }

    if (lease.status === 'active' && lease.expiresAt <= Date.now()) {
      const expiredLease: LeaseRecord = {
        ...lease,
        status: 'expired',
      };
      await this.persistLease(expiredLease);
      return expiredLease;
    }

    return lease;
  }
  
  async markSessionLeased(jti: string): Promise<void> {
    const session = await this.getSession(jti);
    if (!session) return;
    await this.saveSession({ ...session, hasLeased: true });
  }

  async markLeaseRevoked(keyHash: string, revokedAt = Date.now()): Promise<void> {
    const lease = await this.getLeaseByHashRaw(keyHash);
    if (!lease) {
      return;
    }

    await this.persistLease({
      ...lease,
      status: 'revoked',
      revokedAt,
    });
  }

  async markLeaseExpired(keyHash: string): Promise<void> {
    const lease = await this.getLeaseByHashRaw(keyHash);
    if (!lease) {
      return;
    }

    await this.persistLease({
      ...lease,
      status: 'expired',
    });
  }

  async listLeases(): Promise<LeaseRecord[]> {
    const hashesRaw = await this.redis.smembers(LEASES_INDEX_KEY);
    const hashes = Array.isArray(hashesRaw) ? hashesRaw.map((value) => String(value)) : [];

    const leases: LeaseRecord[] = [];
    for (const hash of hashes) {
      const lease = await this.getLeaseByKeyHash(hash);
      if (!lease) {
        await this.redis.srem(LEASES_INDEX_KEY, hash);
      } else {
        leases.push(lease);
      }
    }

    return leases;
  }

  async checkRateLimit(
    bucketKey: string,
    maxCount: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const key = `rl:${bucketKey}`;
    const currentCount = Number(await this.redis.incr(key));
    if (currentCount === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    const ttlSeconds = Number(await this.redis.ttl(key));
    const ttlSafe = ttlSeconds > 0 ? ttlSeconds : windowSeconds;

    return {
      allowed: currentCount <= maxCount,
      remaining: Math.max(0, maxCount - currentCount),
      resetAt: Date.now() + ttlSafe * 1000,
    };
  }

  async ping(): Promise<boolean> {
    const response = await this.redis.ping();
    return response === 'PONG';
  }

  async cleanupExpired(now = Date.now()): Promise<CleanupReport> {
    let leasesExpired = 0;
    let invitesExpired = 0;
    let membershipsExpired = 0;

    const leases = await this.listLeases();
    for (const lease of leases) {
      if (lease.status === 'active' && lease.expiresAt <= now) {
        await this.markLeaseExpired(lease.keyHash);
        leasesExpired += 1;
      }
    }

    const invites = await this.listInvites();
    for (const invite of invites) {
      if (invite.status === 'active' && invite.expiresAt <= now) {
        await this.redis.set(this.inviteKey(invite.codeHash), JSON.stringify({ ...invite, status: 'expired' }), { ex: 86400 });
        invitesExpired += 1;
      }
    }

    const memberships = await this.listMemberships();
    for (const m of memberships) {
      if (m.status === 'active' && m.expiresAt <= now) {
        await this.redis.set(this.membershipKey(m.installHash), JSON.stringify({ ...m, status: 'expired' as const }), { ex: 86400 });
        membershipsExpired += 1;
      }
    }

    return {
      challengesDeleted: 0,
      sessionsDeleted: 0,
      rateBucketsDeleted: 0,
      leasesExpired,
      invitesExpired,
      membershipsExpired,
    };
  }

  // --- Invites ---
  async createInvite(record: InviteRecord): Promise<void> {
    const ttl = toSecondsUntil(record.expiresAt, 60) + 86400;
    await this.redis.set(this.inviteKey(record.codeHash), JSON.stringify(record), { ex: ttl });
    await this.redis.sadd('invites:index', record.codeHash);
  }

  async getInvite(codeHash: string): Promise<InviteRecord | null> {
    const raw = await this.redis.get(this.inviteKey(codeHash));
    const invite = decodeJson<InviteRecord>(raw);
    if (!invite) return null;
    if (invite.status === 'active' && invite.expiresAt <= Date.now()) {
      const expired = { ...invite, status: 'expired' as const };
      await this.redis.set(this.inviteKey(codeHash), JSON.stringify(expired), { ex: 86400 });
      return expired;
    }
    return invite;
  }

  async takeInvite(codeHash: string): Promise<InviteTakeResult> {
    const lua = `
      local key = KEYS[1]
      local raw = redis.call('GET', key)
      if not raw then return cjson.encode({ok=false, reason='not_found'}) end
      local invite = cjson.decode(raw)
      if invite.status == 'revoked' then return cjson.encode({ok=false, reason='revoked'}) end
      if invite.status == 'expired' then return cjson.encode({ok=false, reason='expired'}) end
      if invite.expiresAt <= tonumber(ARGV[1]) then
        invite.status = 'expired'
        redis.call('SET', key, cjson.encode(invite), 'EX', 86400)
        return cjson.encode({ok=false, reason='expired'})
      end
      if invite.used >= invite.maxUses then return cjson.encode({ok=false, reason='exhausted'}) end
      invite.used = invite.used + 1
      local ttl = math.max(60, math.ceil((invite.expiresAt - tonumber(ARGV[1]))/1000) + 86400)
      redis.call('SET', key, cjson.encode(invite), 'EX', ttl)
      return cjson.encode({ok=true, invite=invite})
    `;
    const raw = (await this.redis.eval(lua, [this.inviteKey(codeHash)], [String(Date.now())])) as unknown as string;
    const parsed = JSON.parse(raw) as InviteTakeResult;
    return parsed;
  }

  async revokeInvite(codeHash: string): Promise<boolean> {
    const invite = await this.getInvite(codeHash);
    if (!invite) return false;
    const updated: InviteRecord = { ...invite, status: 'revoked' };
    await this.redis.set(this.inviteKey(codeHash), JSON.stringify(updated), { ex: 86400 });
    return true;
  }

  async listInvites(): Promise<InviteRecord[]> {
    const hashesRaw = await this.redis.smembers('invites:index');
    const hashes = Array.isArray(hashesRaw) ? hashesRaw.map((v) => String(v)) : [];
    const result: InviteRecord[] = [];
    for (const h of hashes) {
      const raw = await this.redis.get(this.inviteKey(h));
      const invite = decodeJson<InviteRecord>(raw);
      if (!invite) {
        await this.redis.srem('invites:index', h);
      } else {
        if (invite.status === 'active' && invite.expiresAt <= Date.now()) {
          const expired = { ...invite, status: 'expired' as const };
          await this.redis.set(this.inviteKey(h), JSON.stringify(expired), { ex: 86400 });
          result.push(expired);
        } else {
          result.push(invite);
        }
      }
    }
    return result;
  }

  // --- Memberships ---
  async createMembership(record: MembershipRecord): Promise<void> {
    const ttl = toSecondsUntil(record.expiresAt, 60) + 86400;
    await this.redis.set(this.membershipKey(record.installHash), JSON.stringify(record), { ex: ttl });
    await this.redis.sadd('memberships:index', record.installHash);
  }

  async getMembership(installHash: string): Promise<MembershipRecord | null> {
    const raw = await this.redis.get(this.membershipKey(installHash));
    const m = decodeJson<MembershipRecord>(raw);
    if (!m) return null;
    if (m.status === 'active' && m.expiresAt <= Date.now()) {
      const expired = { ...m, status: 'expired' as const };
      await this.redis.set(this.membershipKey(installHash), JSON.stringify(expired), { ex: 86400 });
      return expired;
    }
    return m;
  }

  async updateMembership(
    installHash: string,
    updates: Partial<Pick<MembershipRecord, 'expiresAt' | 'spentCents' | 'budgetCents' | 'status'>>,
  ): Promise<MembershipRecord | null> {
    const current = await this.getMembership(installHash);
    if (!current) return null;
    const updated: MembershipRecord = { ...current, ...updates };
    const ttl = toSecondsUntil(updated.expiresAt, 60) + 86400;
    await this.redis.set(this.membershipKey(installHash), JSON.stringify(updated), { ex: ttl });
    return updated;
  }

  async incrementSpent(installHash: string, deltaCents: number): Promise<MembershipRecord | null> {
    // Upstash lacks Lua eval with cjson; use read-modify-write (acceptable for single-writer per installHash)
    const current = await this.getMembership(installHash);
    if (!current) return null;
    const updated: MembershipRecord = { ...current, spentCents: current.spentCents + deltaCents };
    const ttl = toSecondsUntil(updated.expiresAt, 60) + 86400;
    await this.redis.set(this.membershipKey(installHash), JSON.stringify(updated), { ex: ttl });
    return updated;
  }

  async listMemberships(): Promise<MembershipRecord[]> {
    const hashesRaw = await this.redis.smembers('memberships:index');
    const hashes = Array.isArray(hashesRaw) ? hashesRaw.map((v) => String(v)) : [];
    const result: MembershipRecord[] = [];
    for (const h of hashes) {
      const m = await this.getMembership(String(h));
      if (!m) {
        await this.redis.srem('memberships:index', String(h));
      } else {
        result.push(m);
      }
    }
    return result;
  }
}
