'use client';

import { useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { cn } from '@/lib/format';

type Tab = 'locations' | 'departments' | 'cost-centres';

interface Location {
  id: string;
  code: string;
  name: string;
  type: string;
  isOwned: boolean;
  permissionReference: string | null;
  parentId: string | null;
  timezone: string;
  isActive: boolean;
  parent?: { id: string; code: string; name: string } | null;
  children?: Array<{ id: string; code: string; name: string }>;
  _count: { users: number };
}

interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  parent?: { id: string; code: string; name: string } | null;
  children?: Array<{ id: string; code: string; name: string }>;
  _count: { users: number; costCentres: number };
}

interface CostCentre {
  id: string;
  code: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  isActive: boolean;
  department?: { id: string; code: string; name: string } | null;
}

interface MasterData {
  locations: Location[];
  departments: Department[];
  costCentres: CostCentre[];
}

export default function MasterDataPage({ initialData }: { initialData: MasterData }) {
  const [activeTab, setActiveTab] = useState<Tab>('locations');
  const [locations, setLocations] = useState<Location[]>(initialData.locations);
  const [departments, setDepartments] = useState<Department[]>(initialData.departments);
  const [costCentres, setCostCentres] = useState<CostCentre[]>(initialData.costCentres);

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'locations', label: 'Locations', count: locations.length },
    { id: 'departments', label: 'Departments', count: departments.length },
    { id: 'cost-centres', label: 'Cost Centres', count: costCentres.length },
  ];

  const typeBadges: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
    HEAD_OFFICE: 'info',
    OFFICE: 'neutral',
    LAB: 'info',
    WAREHOUSE: 'warning',
    PROJECT_SITE: 'info',
    UNIVERSITY_FACILITY: 'success',
    PERMITTED_USE: 'info',
    REMOTE: 'neutral',
    OTHER: 'neutral',
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Master Data"
        description="Organisational dimensions that every financial record carries. Changes require approval and are audited."
      />

      <div className="border-border-subtle rounded-lg border bg-white">
        <nav className="border-border-subtle border-b px-5" aria-label="Master data tabs">
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
          {activeTab === 'locations' && (
            <Card>
              <CardHeader
                title="Locations"
                description="Physical and logical sites including university facilities and permitted-use locations."
                actions={
                  <Button size="sm" variant="outline">
                    Add location
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {locations.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No locations yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first location to begin tracking where transactions occur.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Type</Th>
                        <Th>Parent</Th>
                        <Th>Owned</Th>
                        <Th>Permission Ref</Th>
                        <Th>Timezone</Th>
                        <Th>Status</Th>
                        <Th className="text-right">Users</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {locations.map((loc) => (
                        <tr key={loc.id}>
                          <Td className="mono text-xs">{loc.code}</Td>
                          <Td>
                            <span className="font-medium">{loc.name}</span>
                            {loc.parent && (
                              <p className="text-muted-foreground mt-0.5 max-w-xl text-xs">
                                Child of {loc.parent.name}
                              </p>
                            )}
                          </Td>
                          <Td>
                            <Badge tone={typeBadges[loc.type] ?? 'neutral'}>{loc.type}</Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {loc.parent?.name ?? '-'}
                          </Td>
                          <Td>
                            {loc.isOwned ? (
                              <Badge tone="success">Owned</Badge>
                            ) : (
                              <Badge tone="neutral">Leased</Badge>
                            )}
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-xs truncate">
                            {loc.permissionReference ?? '-'}
                          </Td>
                          <Td className="text-muted-foreground text-xs">{loc.timezone}</Td>
                          <Td>
                            {loc.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="warning">Inactive</Badge>
                            )}
                          </Td>
                          <Td className="tabular text-right">{loc._count.users}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {activeTab === 'departments' && (
            <Card>
              <CardHeader
                title="Departments"
                description="Organisational units that group users, cost centres and budgets."
                actions={
                  <Button size="sm" variant="outline">
                    Add department
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {departments.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No departments yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first department to organise users and cost centres.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Parent</Th>
                        <Th>Status</Th>
                        <Th className="text-right">Users</Th>
                        <Th className="text-right">Cost Centres</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {departments.map((dept) => (
                        <tr key={dept.id}>
                          <Td className="mono text-xs">{dept.code}</Td>
                          <Td>
                            <span className="font-medium">{dept.name}</span>
                            {dept.parent && (
                              <p className="text-muted-foreground mt-0.5 max-w-xl text-xs">
                                Child of {dept.parent.name}
                              </p>
                            )}
                          </Td>
                          <Td className="text-muted-foreground text-xs">{dept.parent?.name ?? '-'}</Td>
                          <Td>
                            {dept.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="warning">Inactive</Badge>
                            )}
                          </Td>
                          <Td className="tabular text-right">{dept._count.users}</Td>
                          <Td className="tabular text-right">{dept._count.costCentres}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {activeTab === 'cost-centres' && (
            <Card>
              <CardHeader
                title="Cost Centres"
                description="Granular cost tracking units linked to departments and budgets."
                actions={
                  <Button size="sm" variant="outline">
                    Add cost centre
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {costCentres.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No cost centres yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first cost centre to track costs at a granular level.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Department</Th>
                        <Th>Description</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {costCentres.map((cc) => (
                        <tr key={cc.id}>
                          <Td className="mono text-xs">{cc.code}</Td>
                          <Td><span className="font-medium">{cc.name}</span></Td>
                          <Td className="text-muted-foreground text-xs">{cc.department?.name ?? '-'}</Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">{cc.description ?? '-'}</Td>
                          <Td>
                            {cc.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="warning">Inactive</Badge>
                            )}
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