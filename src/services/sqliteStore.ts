import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

const parseDatabasePath = (databaseUrl: string): string => {
  const trimmed = databaseUrl.trim();
  if (!trimmed.startsWith('sqlite:')) {
    throw new Error('DATABASE_URL must start with sqlite:');
  }
  const path = trimmed.slice('sqlite:'.length).trim();
  if (!path || path === ':memory:') {
    return ':memory:';
  }
  return path;
};

export class SqliteKeyBrokerStore implements KeyBrokerStore {
  private readonly db: Database;

  constructor(databaseUrl: string) {
    const dbPath = parseDatabasePath(databaseUrl);
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        installHash TEXT NOT NULL,
        platform TEXT NOT NULL,
        appVersion TEXT,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        jti TEXT PRIMARY KEY,
        installHash TEXT NOT NULL,
        platform TEXT NOT NULL,
        riskLevel TEXT NOT NULL,
        issuedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        revokedAt INTEGER,
        hasLeased INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS leases (
        keyHash TEXT PRIMARY KEY,
        installHash TEXT NOT NULL,
        upstreamHash TEXT NOT NULL,
        label TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        rotateAfterSec INTEGER NOT NULL,
        revokedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_leases_install ON leases(installHash);
      CREATE TABLE IF NOT EXISTS rate_buckets (
        bucketKey TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        resetAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        codeHash TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        maxUses INTEGER NOT NULL,
        used INTEGER NOT NULL,
        createdBy TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS memberships (
        installHash TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        inviteId TEXT NOT NULL,
        joinedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        budgetCents INTEGER NOT NULL,
        spentCents INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(orgId);
    `);
  }

  async createChallenge(record: ChallengeRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO challenges (id, nonce, installHash, platform, appVersion, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.nonce,
        record.installHash,
        record.platform,
        record.appVersion ?? null,
        record.createdAt,
        record.expiresAt,
      );
  }

  async takeChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    const row = this.db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId) as
      | ChallengeRow
      | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeId);
    return mapChallengeRow(row);
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (jti, installHash, platform, riskLevel, issuedAt, expiresAt, revokedAt, hasLeased) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.jti,
        record.installHash,
        record.platform,
        record.riskLevel,
        record.issuedAt,
        record.expiresAt,
        record.revokedAt ?? null,
        record.hasLeased ? 1 : 0,
      );
  }

  async getSession(jti: string): Promise<SessionRecord | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE jti = ?').get(jti) as SessionRow | undefined;
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE jti = ?').run(jti);
      return null;
    }
    return mapSessionRow(row);
  }

  async revokeSession(jti: string, revokedAt = Date.now()): Promise<void> {
    const existing = await this.getSession(jti);
    if (!existing) return;
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE jti = ?').run(revokedAt, jti);
  }

  async putLease(record: LeaseRecord): Promise<void> {
    const current = await this.getLeaseByInstall(record.installHash);
    if (current && current.keyHash !== record.keyHash) {
      this.db.prepare('DELETE FROM leases WHERE keyHash = ?').run(current.keyHash);
    }
    this.db
      .prepare(
        'INSERT OR REPLACE INTO leases (keyHash, installHash, upstreamHash, label, name, status, reason, createdAt, expiresAt, rotateAfterSec, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.keyHash,
        record.installHash,
        record.upstreamHash,
        record.label ?? null,
        record.name,
        record.status,
        record.reason,
        record.createdAt,
        record.expiresAt,
        record.rotateAfterSec,
        record.revokedAt ?? null,
      );
  }

  async getLeaseByInstall(installHash: string): Promise<LeaseRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM leases WHERE installHash = ? ORDER BY createdAt DESC LIMIT 1')
      .get(installHash) as LeaseRow | undefined;
    if (!row) return null;
    if (row.status === 'active' && row.expiresAt <= Date.now()) {
      await this.markLeaseExpired(row.keyHash);
      const updated = this.db.prepare('SELECT * FROM leases WHERE keyHash = ?').get(row.keyHash) as
        | LeaseRow
        | undefined;
      return updated ? mapLeaseRow(updated) : null;
    }
    return mapLeaseRow(row);
  }

  async getLeaseByKeyHash(keyHash: string): Promise<LeaseRecord | null> {
    const row = this.db.prepare('SELECT * FROM leases WHERE keyHash = ?').get(keyHash) as
      | LeaseRow
      | undefined;
    if (!row) return null;
    if (row.status === 'active' && row.expiresAt <= Date.now()) {
      await this.markLeaseExpired(keyHash);
      const updated = this.db.prepare('SELECT * FROM leases WHERE keyHash = ?').get(keyHash) as
        | LeaseRow
        | undefined;
      return updated ? mapLeaseRow(updated) : null;
    }
    return mapLeaseRow(row);
  }

  async markLeaseRevoked(keyHash: string, revokedAt = Date.now()): Promise<void> {
    this.db.prepare("UPDATE leases SET status = 'revoked', revokedAt = ? WHERE keyHash = ?").run(revokedAt, keyHash);
  }

  async markLeaseExpired(keyHash: string): Promise<void> {
    this.db.prepare("UPDATE leases SET status = 'expired' WHERE keyHash = ?").run(keyHash);
  }

  async listLeases(): Promise<LeaseRecord[]> {
    const rows = this.db.prepare('SELECT * FROM leases').all() as LeaseRow[];
    const now = Date.now();
    const result: LeaseRecord[] = [];
    for (const row of rows) {
      if (row.status === 'active' && row.expiresAt <= now) {
        await this.markLeaseExpired(row.keyHash);
        const updated = this.db.prepare('SELECT * FROM leases WHERE keyHash = ?').get(row.keyHash) as
          | LeaseRow
          | undefined;
        if (updated) result.push(mapLeaseRow(updated));
      } else {
        result.push(mapLeaseRow(row));
      }
    }
    return result;
  }

  async markSessionLeased(jti: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET hasLeased = 1 WHERE jti = ?').run(jti);
  }

  async checkRateLimit(bucketKey: string, maxCount: number, windowSeconds: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM rate_buckets WHERE bucketKey = ?').get(bucketKey) as
      | RateBucketRow
      | undefined;

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowSeconds * 1000;
      this.db
        .prepare('INSERT OR REPLACE INTO rate_buckets (bucketKey, count, resetAt) VALUES (?, ?, ?)')
        .run(bucketKey, 1, resetAt);
      return { allowed: true, remaining: Math.max(0, maxCount - 1), resetAt };
    }

    const nextCount = existing.count + 1;
    this.db.prepare('UPDATE rate_buckets SET count = ? WHERE bucketKey = ?').run(nextCount, bucketKey);
    return {
      allowed: nextCount <= maxCount,
      remaining: Math.max(0, maxCount - nextCount),
      resetAt: existing.resetAt,
    };
  }

  async cleanupExpired(now = Date.now()): Promise<CleanupReport> {
    const challengesDeleted = this.db.prepare('DELETE FROM challenges WHERE expiresAt <= ?').run(now).changes;
    const sessionsDeleted = this.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now).changes;
    const rateBucketsDeleted = this.db.prepare('DELETE FROM rate_buckets WHERE resetAt <= ?').run(now).changes;
    let leasesExpired = 0;
    const activeLeases = this.db.prepare("SELECT keyHash FROM leases WHERE status = 'active' AND expiresAt <= ?").all(now) as {
      keyHash: string;
    }[];
    for (const { keyHash } of activeLeases) {
      await this.markLeaseExpired(keyHash);
      leasesExpired += 1;
    }
    let invitesExpired = 0;
    const activeInvites = this.db
      .prepare("SELECT codeHash FROM invites WHERE status = 'active' AND expiresAt <= ?")
      .all(now) as { codeHash: string }[];
    for (const { codeHash } of activeInvites) {
      this.db.prepare("UPDATE invites SET status = 'expired' WHERE codeHash = ?").run(codeHash);
      invitesExpired += 1;
    }
    let membershipsExpired = 0;
    const activeMemberships = this.db
      .prepare("SELECT installHash FROM memberships WHERE status = 'active' AND expiresAt <= ?")
      .all(now) as { installHash: string }[];
    for (const { installHash } of activeMemberships) {
      this.db.prepare("UPDATE memberships SET status = 'expired' WHERE installHash = ?").run(installHash);
      membershipsExpired += 1;
    }
    return { challengesDeleted, sessionsDeleted, rateBucketsDeleted, leasesExpired, invitesExpired, membershipsExpired };
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  // --- Invites ---
  async createInvite(record: InviteRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO invites (codeHash, orgId, createdAt, expiresAt, maxUses, used, createdBy, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.codeHash,
        record.orgId,
        record.createdAt,
        record.expiresAt,
        record.maxUses,
        record.used,
        record.createdBy,
        record.status,
        record.note ?? null,
      );
  }

  async getInvite(codeHash: string): Promise<InviteRecord | null> {
    const row = this.db.prepare('SELECT * FROM invites WHERE codeHash = ?').get(codeHash) as InviteRow | undefined;
    if (!row) return null;
    if (row.status === 'active' && row.expiresAt <= Date.now()) {
      this.db.prepare("UPDATE invites SET status = 'expired' WHERE codeHash = ?").run(codeHash);
      return { ...mapInviteRow(row), status: 'expired' };
    }
    return mapInviteRow(row);
  }

  async takeInvite(codeHash: string): Promise<InviteTakeResult> {
    // Atomic via BEGIN IMMEDIATE transaction
    const result = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM invites WHERE codeHash = ?').get(codeHash) as InviteRow | undefined;
      if (!row) return { ok: false, reason: 'not_found' } as InviteTakeResult;
      if (row.status === 'revoked') return { ok: false, reason: 'revoked' } as InviteTakeResult;
      if (row.status === 'expired' || row.expiresAt <= Date.now()) {
        this.db.prepare("UPDATE invites SET status = 'expired' WHERE codeHash = ?").run(codeHash);
        return { ok: false, reason: 'expired' } as InviteTakeResult;
      }
      if (row.used >= row.maxUses) return { ok: false, reason: 'exhausted' } as InviteTakeResult;
      const nextUsed = row.used + 1;
      this.db.prepare('UPDATE invites SET used = ? WHERE codeHash = ?').run(nextUsed, codeHash);
      const updated = this.db.prepare('SELECT * FROM invites WHERE codeHash = ?').get(codeHash) as InviteRow;
      return { ok: true, invite: mapInviteRow(updated) } as InviteTakeResult;
    })();
    return result;
  }

  async revokeInvite(codeHash: string): Promise<boolean> {
    const existing = this.db.prepare('SELECT codeHash FROM invites WHERE codeHash = ?').get(codeHash) as
      | { codeHash: string }
      | undefined;
    if (!existing) return false;
    this.db.prepare("UPDATE invites SET status = 'revoked' WHERE codeHash = ?").run(codeHash);
    return true;
  }

  async listInvites(): Promise<InviteRecord[]> {
    const rows = this.db.prepare('SELECT * FROM invites').all() as InviteRow[];
    return rows.map(mapInviteRow);
  }

  // --- Memberships ---
  async createMembership(record: MembershipRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memberships (installHash, orgId, inviteId, joinedAt, expiresAt, budgetCents, spentCents, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.installHash,
        record.orgId,
        record.inviteId,
        record.joinedAt,
        record.expiresAt,
        record.budgetCents,
        record.spentCents,
        record.status,
      );
  }

  async getMembership(installHash: string): Promise<MembershipRecord | null> {
    const row = this.db.prepare('SELECT * FROM memberships WHERE installHash = ?').get(installHash) as
      | MembershipRow
      | undefined;
    if (!row) return null;
    if (row.status === 'active' && row.expiresAt <= Date.now()) {
      this.db.prepare("UPDATE memberships SET status = 'expired' WHERE installHash = ?").run(installHash);
      return { ...mapMembershipRow(row), status: 'expired' };
    }
    return mapMembershipRow(row);
  }

  async updateMembership(
    installHash: string,
    updates: Partial<Pick<MembershipRecord, 'expiresAt' | 'spentCents' | 'budgetCents' | 'status'>>,
  ): Promise<MembershipRecord | null> {
    const current = this.db.prepare('SELECT * FROM memberships WHERE installHash = ?').get(installHash) as
      | MembershipRow
      | undefined;
    if (!current) return null;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.expiresAt !== undefined) {
      fields.push('expiresAt = ?');
      values.push(updates.expiresAt);
    }
    if (updates.spentCents !== undefined) {
      fields.push('spentCents = ?');
      values.push(updates.spentCents);
    }
    if (updates.budgetCents !== undefined) {
      fields.push('budgetCents = ?');
      values.push(updates.budgetCents);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (fields.length === 0) return mapMembershipRow(current);
    values.push(installHash);
    this.db.prepare(`UPDATE memberships SET ${fields.join(', ')} WHERE installHash = ?`).run(...(values as unknown as string[]));
    const updated = this.db.prepare('SELECT * FROM memberships WHERE installHash = ?').get(installHash) as MembershipRow;
    return mapMembershipRow(updated);
  }

  async incrementSpent(installHash: string, deltaCents: number): Promise<MembershipRecord | null> {
    const current = this.db.prepare('SELECT * FROM memberships WHERE installHash = ?').get(installHash) as
      | MembershipRow
      | undefined;
    if (!current) return null;
    if (current.status !== 'active' && current.status !== 'expired') {
      // revoked: still increment is not needed; return as-is
      return mapMembershipRow(current);
    }
    this.db.prepare('UPDATE memberships SET spentCents = spentCents + ? WHERE installHash = ?').run(deltaCents, installHash);
    const updated = this.db.prepare('SELECT * FROM memberships WHERE installHash = ?').get(installHash) as MembershipRow;
    return mapMembershipRow(updated);
  }

  async listMemberships(): Promise<MembershipRecord[]> {
    const rows = this.db.prepare('SELECT * FROM memberships').all() as MembershipRow[];
    // reflect expiry lazily
    const now = Date.now();
    for (const row of rows) {
      if (row.status === 'active' && row.expiresAt <= now) {
        this.db.prepare("UPDATE memberships SET status = 'expired' WHERE installHash = ?").run(row.installHash);
        row.status = 'expired';
      }
    }
    return rows.map(mapMembershipRow);
  }
}

type ChallengeRow = {
  id: string;
  nonce: string;
  installHash: string;
  platform: string;
  appVersion: string | null;
  createdAt: number;
  expiresAt: number;
};

type SessionRow = {
  jti: string;
  installHash: string;
  platform: string;
  riskLevel: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  hasLeased: number;
};

type LeaseRow = {
  keyHash: string;
  installHash: string;
  upstreamHash: string;
  label: string | null;
  name: string;
  status: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  rotateAfterSec: number;
  revokedAt: number | null;
};

type RateBucketRow = {
  bucketKey: string;
  count: number;
  resetAt: number;
};

type InviteRow = {
  codeHash: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  used: number;
  createdBy: string;
  status: string;
  note: string | null;
};

type MembershipRow = {
  installHash: string;
  orgId: string;
  inviteId: string;
  joinedAt: number;
  expiresAt: number;
  budgetCents: number;
  spentCents: number;
  status: string;
};

const mapChallengeRow = (row: ChallengeRow): ChallengeRecord => ({
  id: row.id,
  nonce: row.nonce,
  installHash: row.installHash,
  platform: row.platform as ChallengeRecord['platform'],
  appVersion: row.appVersion ?? undefined,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

const mapSessionRow = (row: SessionRow): SessionRecord => ({
  jti: row.jti,
  installHash: row.installHash,
  platform: row.platform as SessionRecord['platform'],
  riskLevel: row.riskLevel as SessionRecord['riskLevel'],
  issuedAt: row.issuedAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt ?? undefined,
  hasLeased: Boolean(row.hasLeased),
});

const mapLeaseRow = (row: LeaseRow): LeaseRecord => ({
  installHash: row.installHash,
  keyHash: row.keyHash,
  upstreamHash: row.upstreamHash,
  label: row.label ?? undefined,
  name: row.name,
  status: row.status as LeaseRecord['status'],
  reason: row.reason as LeaseRecord['reason'],
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  rotateAfterSec: row.rotateAfterSec,
  revokedAt: row.revokedAt ?? undefined,
});

const mapInviteRow = (row: InviteRow): InviteRecord => ({
  codeHash: row.codeHash,
  orgId: row.orgId,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  maxUses: row.maxUses,
  used: row.used,
  createdBy: row.createdBy,
  status: row.status as InviteRecord['status'],
  note: row.note ?? undefined,
});

const mapMembershipRow = (row: MembershipRow): MembershipRecord => ({
  installHash: row.installHash,
  orgId: row.orgId,
  inviteId: row.inviteId,
  joinedAt: row.joinedAt,
  expiresAt: row.expiresAt,
  budgetCents: row.budgetCents,
  spentCents: row.spentCents,
  status: row.status as MembershipRecord['status'],
});
