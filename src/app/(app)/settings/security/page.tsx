import type { Metadata } from 'next';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { loadAuthPolicy } from '@/lib/auth/policy';
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Security settings' };

/**
 * Read-only view of the authentication policy (PDF 4).
 *
 * Every threshold on this screen is configuration in the auth_policies table, not
 * a constant in code. That is why it can be changed deliberately and reverted,
 * and why an emergency tightening does not require a deploy. Editing arrives in
 * M6 alongside the configuration-change approval flow; M1 shows the values so
 * they can be checked against intent.
 */
export default async function SecuritySettingsPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW' });

  const [policy, sessions, mfaDevices] = await Promise.all([
    loadAuthPolicy(true),
    prisma.session.count({ where: { revokedAt: null, absoluteExpiresAt: { gt: new Date() } } }),
    prisma.mfaDevice.groupBy({ by: ['status'], _count: { status: true } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security policy"
        description="These thresholds are configuration, not code. Changing one is recorded in the audit trail."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Account lockout" description="Applies per account." />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Row label="Failed attempts before lock" value={String(policy.maxFailedAttempts)} />
              <Row label="Lockout duration" value={`${policy.lockoutDurationMinutes} minutes`} />
              <Row
                label="Attempt window"
                value={`${policy.rateLimitWindowSeconds}s, max ${policy.maxAttemptsPerWindow}`}
              />
              <Row label="Per-IP limit" value={`${policy.ipRateLimitPerMinute} per minute`} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Sessions"
            description="Resolved at issue time and stored per session."
          />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Row label="Idle timeout" value={`${policy.sessionIdleTimeoutMinutes} minutes`} />
              <Row label="Absolute timeout" value={`${policy.sessionAbsoluteTimeoutHours} hours`} />
              <Row
                label="MFA challenge window"
                value={`${policy.mfaChallengeTimeoutMinutes} minutes`}
              />
              <Row
                label="Step-up grant lifetime"
                value={`${policy.stepUpTimeoutMinutes} minutes`}
              />
              <Row label="Live sessions" value={String(sessions)} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Password policy" description="Enforced on every write path." />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Row label="Minimum length" value={String(policy.passwordMinLength)} />
              <Row
                label="Uppercase"
                value={policy.passwordRequireUppercase ? 'Required' : 'Not required'}
              />
              <Row
                label="Lowercase"
                value={policy.passwordRequireLowercase ? 'Required' : 'Not required'}
              />
              <Row
                label="Number"
                value={policy.passwordRequireNumber ? 'Required' : 'Not required'}
              />
              <Row
                label="Symbol"
                value={policy.passwordRequireSymbol ? 'Required' : 'Not required'}
              />
              <Row label="Hashing" value="Argon2id" />
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Multi-factor authentication"
          description="Required by role. A role on this list cannot complete a sign-in without a verified second factor."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {policy.mfaRequiredRoleCodes.map((code) => (
              <Badge key={code} tone="info">
                {code}
              </Badge>
            ))}
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Status</Th>
                <Th className="text-right">Devices</Th>
              </tr>
            </thead>
            <tbody>
              {mfaDevices.map((row) => (
                <tr key={row.status}>
                  <Td>
                    <Badge
                      tone={
                        row.status === 'ACTIVE'
                          ? 'success'
                          : row.status === 'PENDING'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {row.status}
                    </Badge>
                  </Td>
                  <Td className="tabular text-right">{row._count.status}</Td>
                </tr>
              ))}
              {mfaDevices.length === 0 ? (
                <tr>
                  <Td colSpan={2} className="text-muted-foreground text-sm">
                    No MFA devices enrolled yet. The CEO is required to enrol at first sign-in.
                  </Td>
                </tr>
              ) : null}
            </tbody>
          </Table>
          <p className="text-muted-foreground text-xs">
            Your own MFA state: {actor.roleCodes.join(', ')}. TOTP seeds are stored encrypted with
            AES-256-GCM and are never returned by any endpoint.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Encryption and key material"
          description="Secrets live in environment variables. None of these values is readable from the application."
        />
        <CardBody>
          <dl className="space-y-2 text-sm">
            <Row
              label="Password hashing"
              value="Argon2id (memory 19456 KiB, time cost 2, parallelism 1)"
            />
            <Row label="Secrets at rest" value="AES-256-GCM, authenticated encryption" />
            <Row label="Audit signatures" value="HMAC-SHA256 over the entry hash" />
            <Row label="In transit" value="TLS only; secure cookies in production" />
            <Row label="Policy last updated" value={formatDateTime(policy.updatedAt)} />
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular text-right font-medium">{value}</dd>
    </div>
  );
}
