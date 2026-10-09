'use client';

import { useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Table, Td, Th, Input } from '@/components/ui';
import { cn } from '@/lib/format';

type Tab = 'requests' | 'versions';

interface ChangeRequest {
  id: string;
  entityType: string;
  entityId: string | null;
  proposedChanges: Record<string, unknown>;
  reason: string;
  status: string;
  requestedById: string;
  approvedById: string | null;
  approvedAt: string | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  requestedBy: { id: string; fullName: string; email: string };
  approvedBy: { id: string; fullName: string; email: string } | null;
}

interface Version {
  id: string;
  changeRequestId: string;
  entityType: string;
  entityId: string | null;
  versionNumber: number;
  snapshot: Record<string, unknown>;
  changedFields: Record<string, unknown> | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  changeRequest: {
    id: string;
    entityType: string;
    status: string;
    reason: string;
    requestedBy: { fullName: string };
  };
}

interface MasterDataHistory {
  changeRequests: ChangeRequest[];
  versions: Version[];
}

const statusBadges: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

const entityTypeBadges: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  LOCATION: 'info',
  DEPARTMENT: 'success',
  COST_CENTRE: 'warning',
  PROJECT: 'info',
  FUNDING_SOURCE: 'success',
  CURRENCY: 'info',
  EXCHANGE_RATE: 'neutral',
};

export default function MasterDataHistoryPage({ initialData }: { initialData: MasterDataHistory }) {
  const [activeTab, setActiveTab] = useState<Tab>('requests');
  const [search, setSearch] = useState('');

  const { changeRequests, versions } = initialData;

  const filteredRequests = changeRequests.filter((cr) =>
    cr.entityType.toLowerCase().includes(search.toLowerCase()) ||
    (cr.entityId && cr.entityId.toLowerCase().includes(search.toLowerCase())) ||
    cr.reason.toLowerCase().includes(search.toLowerCase()) ||
    cr.status.toLowerCase().includes(search.toLowerCase()) ||
    cr.requestedBy.fullName.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredVersions = versions.filter((v) =>
    v.entityType.toLowerCase().includes(search.toLowerCase()) ||
    (v.entityId && v.entityId.toLowerCase().includes(search.toLowerCase())) ||
    v.changeRequest.entityType.toLowerCase().includes(search.toLowerCase()) ||
    v.changeRequest.reason.toLowerCase().includes(search.toLowerCase()),
  );

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'requests', label: 'Change Requests', count: filteredRequests.length },
    { id: 'versions', label: 'Version History', count: filteredVersions.length },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Master Data Change History"
        description="Track all master data change requests and version snapshots. Every change requires approval and is fully audited."
      />

      <div className="mb-4">
        <Input
          placeholder="Search requests, versions, entities, reasons..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md"
        />
      </div>

      <div className="border-border-subtle rounded-lg border bg-white">
        <nav className="border-border-subtle border-b px-5" aria-label="History tabs">
          <ul className="flex gap-1">
            {tabs.map((tab) => (
              <li key={tab.id} role="presentation">
                <button
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                    activeTab === tab.id
                      ? 'border-navy-600 text-navy-800'
                      : 'border-transparent text-muted-foreground hover:text-navy-600 hover:border-navy-200',
                  )}
                >
                  {tab.label} <Badge tone="neutral" className="ml-2">{tab.count}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-5">
          {activeTab === 'requests' && (
            <Card>
              <CardHeader title="Change Requests" />
              <CardBody className="px-0 py-0">
                {filteredRequests.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No change requests found</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first change request to begin tracking master data changes.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>ID</Th>
                        <Th>Entity</Th>
                        <Th>Status</Th>
                        <Th>Reason</Th>
                        <Th>Requested By</Th>
                        <Th>Approved By</Th>
                        <Th>Effective Date</Th>
                        <Th>Created</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRequests.map((cr) => (
                        <tr key={cr.id}>
                          <Td className="mono text-xs max-w-xs truncate">{cr.id.slice(0, 12)}...</Td>
                          <Td>
                            <Badge tone={entityTypeBadges[cr.entityType] ?? 'neutral'}>{cr.entityType}</Badge>
                            {cr.entityId && (
                              <p className="text-muted-foreground mt-0.5 mono text-xs max-w-xs truncate">{cr.entityId}</p>
                            )}
                          </Td>
                          <Td>
                            <Badge tone={statusBadges[cr.status] ?? 'neutral'}>{cr.status}</Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">{cr.reason}</Td>
                          <Td className="text-muted-foreground text-xs">{cr.requestedBy.fullName}</Td>
                          <Td className="text-muted-foreground text-xs">
                            {cr.approvedBy?.fullName ?? '-'}
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {cr.effectiveDate ? new Date(cr.effectiveDate).toISOString().split('T')[0] : '-'}
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {new Date(cr.createdAt).toISOString().split('T')[0]}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {activeTab === 'versions' && (
            <Card>
              <CardHeader title="Version History" />
              <CardBody className="px-0 py-0">
                {filteredVersions.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No versions yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Approved change requests create version snapshots here.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Version</Th>
                        <Th>Entity</Th>
                        <Th>Change Request</Th>
                        <Th>Changed Fields</Th>
                        <Th>Effective From</Th>
                        <Th>Effective To</Th>
                        <Th>Created</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVersions.map((v) => (
                        <tr key={v.id}>
                          <Td className="mono text-xs">v{v.versionNumber}</Td>
                          <Td>
                            <Badge tone={entityTypeBadges[v.entityType] ?? 'neutral'}>{v.entityType}</Badge>
                            {v.entityId && (
                              <p className="text-muted-foreground mt-0.5 mono text-xs max-w-xs truncate">{v.entityId}</p>
                            )}
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">
                            {v.changeRequest.reason}
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">
                            {v.changedFields ? Object.keys(v.changedFields).join(', ') : '-'}
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {new Date(v.effectiveFrom).toISOString().split('T')[0]}
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {v.effectiveTo ? new Date(v.effectiveTo).toISOString().split('T')[0] : '∞'}
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {new Date(v.createdAt).toISOString().split('T')[0]}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}