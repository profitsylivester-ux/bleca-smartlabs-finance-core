import type { Metadata } from 'next';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import {
  CreateUserForm,
  AssignRoleForm,
  RevokeSessionButton,
} from '@/modules/users-roles/components/forms';

export const metadata: Metadata = { title: 'Users and roles' };

/**
 * Users and roles (PDF 4, PDF 5).
 *
 * Read paths go through authorize() exactly like mutations do. A page that
 * renders a list the actor may not see is still a disclosure, so the check is not
 * optional on the way in.
 */
export default async function UsersPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW' });

  const [users, roles, liveSessions] = await Promise.all([
    prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        emailNormalized: true,
        status: true,
        isActive: true,
        lastLoginAt: true,
        mfaEnforced: true,
        mfaVerifiedAt: true,
        deactivationReason: true,
        mfaDevices: { select: { status: true, confirmedAt: true } },
        userRoles: {
          where: { revokedAt: null },
          select: {
            isTemporary: true,
            expiresAt: true,
            role: { select: { code: true, name: true, isFinalApprover: true } },
          },
        },
      },
    }),
    prisma.role.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        isFinalApprover: true,
        _count: { select: { rolePermissions: true } },
      },
    }),
    prisma.session.findMany({
      where: { revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        userId: true,
        deviceLabel: true,
        ipAddress: true,
        lastActiveAt: true,
        absoluteExpiresAt: true,
        mfaSatisfiedAt: true,
        user: { select: { emailNormalized: true } },
      },
    }),
  ]);

  const isAdmin = actor.roleCodes.includes('CEO');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users and roles"
        description="Accounts, role grants, temporary access and live sessions. Every change here is written to the audit trail."
      />

      <Card>
        <CardHeader
          title="Roles"
          description="Roles are data, not code. Adding one is an insert, not a deploy."
        />
        <CardBody className="px-0 py-0">
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th className="text-right">Permissions</Th>
                <Th>Final approver</Th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <Td className="mono text-xs">{role.code}</Td>
                  <Td>
                    <span className="font-medium">{role.name}</span>
                    {role.description ? (
                      <p className="text-muted-foreground mt-0.5 max-w-xl text-xs">
                        {role.description}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="tabular text-right">{role._count.rolePermissions}</Td>
                  <Td>
                    {role.isFinalApprover ? (
                      <Badge tone="info">CEO final authority</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">-</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Accounts"
          description={`${users.length} account(s) in this organisation.`}
        />
        <CardBody className="px-0 py-0">
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Roles</Th>
                <Th>Status</Th>
                <Th>MFA</Th>
                <Th>Last sign-in</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const activeMfa = user.mfaDevices.find((d) => d.status === 'ACTIVE');
                const expiredGrant = user.userRoles.some(
                  (r) => r.expiresAt && r.expiresAt < new Date(),
                );
                return (
                  <tr key={user.id} className={user.isActive ? '' : 'opacity-60'}>
                    <Td>
                      <span className="font-medium">{user.fullName}</span>
                      {user.id === actor.userId ? (
                        <Badge tone="info" className="ml-2">
                          You
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="mono text-xs">{user.emailNormalized}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {user.userRoles.length === 0 ? (
                          <span className="text-muted-foreground text-xs">None</span>
                        ) : (
                          user.userRoles.map((ur, i) => (
                            <Badge key={i} tone={ur.role.isFinalApprover ? 'info' : 'neutral'}>
                              {ur.role.code}
                              {ur.isTemporary ? ' (temp)' : ''}
                              {expiredGrant && ur.expiresAt && ur.expiresAt < new Date()
                                ? ' - expired'
                                : ''}
                            </Badge>
                          ))
                        )}
                      </div>
                    </Td>
                    <Td>
                      {user.isActive ? (
                        <Badge tone={user.status === 'ACTIVE' ? 'success' : 'warning'}>
                          {user.status}
                        </Badge>
                      ) : (
                        <Badge tone="danger">DEACTIVATED</Badge>
                      )}
                    </Td>
                    <Td>
                      {user.mfaEnforced ? (
                        activeMfa ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge tone="warning">Not enrolled</Badge>
                        )
                      ) : (
                        <Badge tone="neutral">Not required</Badge>
                      )}
                    </Td>
                    <Td className="text-muted-foreground text-xs">
                      {formatDateTime(user.lastLoginAt)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      {isAdmin ? (
        <>
          <Card>
            <CardHeader
              title="Create an account"
              description="New accounts start with no password. The first sign-in requires a reset and MFA enrolment."
            />
            <CardBody>
              <CreateUserForm roles={roles.map((r) => ({ code: r.code, name: r.name }))} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Grant or revoke a role"
              description="Requires step-up re-authentication. The affected account's sessions end immediately."
            />
            <CardBody>
              <AssignRoleForm
                users={users.map((u) => ({ id: u.id, emailNormalized: u.emailNormalized }))}
                roles={roles.map((r) => ({ code: r.code }))}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Live sessions"
              description="Revocation takes effect on the target's next request, not when their token expires."
            />
            <CardBody className="px-0 py-0">
              {liveSessions.length === 0 ? (
                <p className="text-muted-foreground px-5 py-6 text-sm">No live sessions.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Account</Th>
                      <Th>Device</Th>
                      <Th>Origin</Th>
                      <Th>Last active</Th>
                      <Th>MFA</Th>
                      <Th>Ends</Th>
                      <Th>Revoke</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveSessions.map((session) => (
                      <tr key={session.id}>
                        <Td className="mono text-xs">{session.user.emailNormalized}</Td>
                        <Td>{session.deviceLabel ?? 'Unknown'}</Td>
                        <Td className="text-xs">{session.ipAddress ?? 'local'}</Td>
                        <Td className="text-xs">{formatDateTime(session.lastActiveAt)}</Td>
                        <Td>
                          {session.mfaSatisfiedAt ? (
                            <Badge tone="success">Verified</Badge>
                          ) : (
                            <Badge tone="warning">Outstanding</Badge>
                          )}
                        </Td>
                        <Td className="text-xs">{formatDateTime(session.absoluteExpiresAt)}</Td>
                        <Td>
                          <RevokeSessionButton
                            sessionId={session.id}
                            email={session.user.emailNormalized}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
