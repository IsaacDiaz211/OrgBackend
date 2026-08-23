export type Platform = 'android' | 'ios';

export type RiskLevel = 'low' | 'medium' | 'high';

export type LeaseStatus = 'active' | 'revoked' | 'expired';

export type LeaseReason = 'bootstrap' | 'refresh';

export type LimitReset = 'daily' | 'weekly' | 'monthly' | null;

export type ChallengeRecord = {
  id: string;
  nonce: string;
  installHash: string;
  platform: Platform;
  appVersion?: string;
  createdAt: number;
  expiresAt: number;
};

export type SessionRecord = {
  jti: string;
  installHash: string;
  platform: Platform;
  riskLevel: RiskLevel;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  hasLeased?: boolean;
};

export type LeaseRecord = {
  installHash: string;
  keyHash: string;
  upstreamHash: string;
  label?: string;
  name: string;
  status: LeaseStatus;
  reason: LeaseReason;
  createdAt: number;
  expiresAt: number;
  rotateAfterSec: number;
  revokedAt?: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export type CleanupReport = {
  challengesDeleted: number;
  sessionsDeleted: number;
  rateBucketsDeleted: number;
  leasesExpired: number;
  invitesExpired?: number;
  membershipsExpired?: number;
};

export type InviteStatus = 'active' | 'revoked' | 'expired';

export type InviteRecord = {
  codeHash: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  used: number;
  createdBy: string;
  status: InviteStatus;
  note?: string;
};

export type MembershipStatus = 'active' | 'revoked' | 'expired';

export type MembershipRecord = {
  installHash: string;
  orgId: string;
  inviteId: string;
  joinedAt: number;
  expiresAt: number;
  budgetCents: number;
  spentCents: number;
  status: MembershipStatus;
};
