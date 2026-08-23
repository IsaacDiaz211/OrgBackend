import { t } from 'elysia';

export const PlatformSchema = t.Union([t.Literal('android'), t.Literal('ios')]);
export const LeaseReasonSchema = t.Union([t.Literal('bootstrap'), t.Literal('refresh')]);

export const ChallengeBodySchema = t.Object({
  installId: t.String({ minLength: 8, maxLength: 128 }),
  platform: PlatformSchema,
  appVersion: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

export const SessionIssueBodySchema = t.Object({
  challengeId: t.String({ minLength: 1, maxLength: 80 }),
  installId: t.String({ minLength: 8, maxLength: 128 }),
  platform: PlatformSchema,
  attestationToken: t.String({ minLength: 8, maxLength: 8192 }),
});

export const LeaseBodySchema = t.Object({
  installId: t.String({ minLength: 8, maxLength: 128 }),
  reason: LeaseReasonSchema,
});

export const RevokeBodySchema = t.Object({
  keyHash: t.String({ minLength: 8, maxLength: 256 }),
  reason: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
});

export const InviteCreateSchema = t.Object({
  ttlDays: t.Optional(t.Number({ minimum: 1, maximum: 30 })),
  maxUses: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
  note: t.Optional(t.String({ maxLength: 120 })),
  count: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
});

export const OrganizationJoinSchema = t.Object({
  inviteCode: t.String({ minLength: 6, maxLength: 64 }),
  installId: t.String({ minLength: 8, maxLength: 128 }),
  platform: t.Optional(PlatformSchema),
});

export const MembershipRefillSchema = t.Object({
  addCents: t.Number({ minimum: 1, maximum: 10000 }),
  extendDays: t.Optional(t.Number({ minimum: 1, maximum: 365 })),
});

export const MembershipRevokeSchema = t.Object({
  reason: t.Optional(t.String({ maxLength: 200 })),
});
