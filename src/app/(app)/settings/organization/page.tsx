import type { Metadata } from 'next';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Organisation settings' };

export default async function OrganisationSettingsPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

  if (!ctx.actor.organizationId) {
    return <div>No organization context</div>;
  }

  const org = await prisma.organization.findFirst({
    where: { id: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      legalName: true,
      type: true,
      registrationStatus: true,
      registrationNumber: true,
      tin: true,
      baseCurrency: true,
      fiscalYearStartMonth: true,
      fiscalYearEndDay: true,
      defaultLocationId: true,
      isActive: true,
      settings: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const defaultLocation = org?.defaultLocationId
    ? await prisma.location.findUnique({
        where: { id: org.defaultLocationId },
        select: { id: true, code: true, name: true },
      })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organisation settings"
        description="Core organisation identity and fiscal configuration. Registration status reflects legal reality (PDF 2)."
      />

      <Card>
        <CardHeader title="Identity" />
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">Code</dt>
              <dd className="mono text-sm font-medium">{org?.code}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Name</dt>
              <dd className="font-medium">{org?.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Legal name</dt>
              <dd className="text-sm">{org?.legalName ?? <span className="text-muted-foreground">Not set</span>}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Type</dt>
              <dd className="mono text-sm">{org?.type}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Registration status"
          description="BLECA is not yet officially registered. This field must reflect legal reality."
        />
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">Status</dt>
              <dd>
                <Badge
                  tone={
                    org?.registrationStatus === 'REGISTERED'
                      ? 'success'
                      : org?.registrationStatus === 'PENDING'
                        ? 'warning'
                        : 'info'
                  }
                >
                  {org?.registrationStatus}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Registration number</dt>
              <dd className="mono text-sm">{org?.registrationNumber ?? <span className="text-muted-foreground">Not set</span>}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Tax Identification Number (TIN)</dt>
              <dd className="mono text-sm">{org?.tin ?? <span className="text-muted-foreground">Not set — nullable until registered</span>}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Fiscal configuration" />
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">Base currency</dt>
              <dd className="mono text-sm font-medium">{org?.baseCurrency}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Fiscal year start</dt>
              <dd className="text-sm">Month {org?.fiscalYearStartMonth ?? 1} (January = 1)</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Fiscal year end</dt>
              <dd className="text-sm">
                Day {org?.fiscalYearEndDay ?? 31} of month {org?.fiscalYearStartMonth === 1 ? 12 : (org?.fiscalYearStartMonth ?? 1) - 1}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Default location"
          description="The default location used when none is specified on a transaction."
        />
        <CardBody className="space-y-4">
          {defaultLocation ? (
            <dl className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div>
                <dt className="text-muted-foreground text-xs">Code</dt>
                <dd className="mono text-sm">{defaultLocation.code}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Name</dt>
                <dd className="font-medium">{defaultLocation.name}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">No default location set. Configure one in Master Data → Locations.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Status" />
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">Active</dt>
              <dd>
                {org?.isActive ? (
                  <Badge tone="success">Yes</Badge>
                ) : (
                  <Badge tone="danger">No</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Created</dt>
              <dd className="text-sm">{org?.createdAt.toISOString().split('T')[0]}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Last updated</dt>
              <dd className="text-sm">{org?.updatedAt.toISOString().split('T')[0]}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}