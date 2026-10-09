'use client';

import { useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { cn } from '@/lib/format';

type Tab = 'locations' | 'departments' | 'cost-centres' | 'projects' | 'funding-sources' | 'currencies' | 'exchange-rates';

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

interface Project {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
}

interface FundingSource {
  id: string;
  code: string;
  name: string;
  type: string;
  description: string | null;
  isRestricted: boolean;
  restrictions: Record<string, unknown> | null;
  isActive: boolean;
}

interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string | null;
  type: string;
  decimalPlaces: number;
  isBase: boolean;
  isActive: boolean;
}

interface ExchangeRate {
  id: string;
  baseCurrencyId: string;
  quoteCurrencyId: string;
  rateDate: string;
  rate: string;
  source: string | null;
  differenceTreatment: string;
  createdAt: string;
  baseCurrency: { id: string; code: string; name: string };
  quoteCurrency: { id: string; code: string; name: string };
}

interface MasterData {
  locations: Location[];
  departments: Department[];
  costCentres: CostCentre[];
  projects: Project[];
  fundingSources: FundingSource[];
  currencies: Currency[];
  exchangeRates: ExchangeRate[];
}

export default function MasterDataPage({ initialData }: { initialData: MasterData }) {
  const [activeTab, setActiveTab] = useState<Tab>('locations');
  const [locations, setLocations] = useState<Location[]>(initialData.locations);
  const [departments, setDepartments] = useState<Department[]>(initialData.departments);
  const [costCentres, setCostCentres] = useState<CostCentre[]>(initialData.costCentres);
  const [projects, setProjects] = useState<Project[]>(initialData.projects);
  const [fundingSources, setFundingSources] = useState<FundingSource[]>(initialData.fundingSources);
  const [currencies, setCurrencies] = useState<Currency[]>(initialData.currencies);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>(initialData.exchangeRates);

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'locations', label: 'Locations', count: locations.length },
    { id: 'departments', label: 'Departments', count: departments.length },
    { id: 'cost-centres', label: 'Cost Centres', count: costCentres.length },
    { id: 'projects', label: 'Projects', count: projects.length },
    { id: 'funding-sources', label: 'Funding Sources', count: fundingSources.length },
    { id: 'currencies', label: 'Currencies', count: currencies.length },
    { id: 'exchange-rates', label: 'Exchange Rates', count: exchangeRates.length },
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

  const projectStatusBadges: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
    DRAFT: 'neutral',
    ACTIVE: 'success',
    ON_HOLD: 'warning',
    COMPLETED: 'info',
    CANCELLED: 'danger',
    ARCHIVED: 'neutral',
  };

  const fundingSourceTypeBadges: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
    UNRESTRICTED: 'success',
    RESTRICTED_GRANT: 'warning',
    DESIGNATED: 'info',
    ENDOWMENT: 'info',
    CONTRACT_REVENUE: 'success',
    INTERNAL_ALLOCATION: 'neutral',
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

          {activeTab === 'projects' && (
            <Card>
              <CardHeader
                title="Projects"
                description="Active projects including Iventika and Uzanite. Projects serve as a dimension for financial tracking."
                actions={
                  <Button size="sm" variant="outline">
                    Add project
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {projects.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No projects yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first project to track financial activity by project dimension.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Status</Th>
                        <Th>Start Date</Th>
                        <Th>End Date</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((proj) => (
                        <tr key={proj.id}>
                          <Td className="mono text-xs">{proj.code}</Td>
                          <Td><span className="font-medium">{proj.name}</span></Td>
                          <Td>
                            <Badge tone={projectStatusBadges[proj.status] ?? 'neutral'}>{proj.status}</Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs">{proj.startDate ? new Date(proj.startDate).toISOString().split('T')[0] : '-'}</Td>
                          <Td className="text-muted-foreground text-xs">{proj.endDate ? new Date(proj.endDate).toISOString().split('T')[0] : '-'}</Td>
                          <Td>
                            {proj.isActive ? (
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

          {activeTab === 'funding-sources' && (
            <Card>
              <CardHeader
                title="Funding Sources"
                description="Sources of funding including unrestricted, restricted grants, and internal allocations. Restricted sources enforce scope constraints."
                actions={
                  <Button size="sm" variant="outline">
                    Add funding source
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {fundingSources.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No funding sources yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first funding source to track financial activity by funding dimension.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Type</Th>
                        <Th>Restricted</Th>
                        <Th>Description</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {fundingSources.map((fs) => (
                        <tr key={fs.id}>
                          <Td className="mono text-xs">{fs.code}</Td>
                          <Td><span className="font-medium">{fs.name}</span></Td>
                          <Td>
                            <Badge tone={fundingSourceTypeBadges[fs.type] ?? 'neutral'}>{fs.type}</Badge>
                          </Td>
                          <Td>
                            {fs.isRestricted ? (
                              <Badge tone="warning">Yes</Badge>
                            ) : (
                              <Badge tone="success">No</Badge>
                            )}
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">{fs.description ?? '-'}</Td>
                          <Td>
                            {fs.isActive ? (
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
          {activeTab === 'currencies' && (
            <Card>
              <CardHeader
                title="Currencies"
                description="Currency definitions including base currency (TZS) and supported foreign currencies."
                actions={
                  <Button size="sm" variant="outline">
                    Add currency
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {currencies.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No currencies yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first currency to enable multi-currency transactions.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Symbol</Th>
                        <Th>Type</Th>
                        <Th>Decimals</Th>
                        <Th>Base</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {currencies.map((cur) => (
                        <tr key={cur.id}>
                          <Td className="mono text-xs">{cur.code}</Td>
                          <Td><span className="font-medium">{cur.name}</span></Td>
                          <Td className="text-muted-foreground text-xs">{cur.symbol ?? '-'}</Td>
                          <Td>
                            <Badge tone={cur.type === 'FIAT' ? 'success' : cur.type === 'CRYPTO' ? 'warning' : 'neutral'}>{cur.type}</Badge>
                          </Td>
                          <Td className="tabular text-right">{cur.decimalPlaces}</Td>
                          <Td>
                            {cur.isBase ? (
                              <Badge tone="info">Base</Badge>
                            ) : (
                              <Badge tone="neutral">Quote</Badge>
                            )}
                          </Td>
                          <Td>
                            {cur.isActive ? (
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

          {activeTab === 'exchange-rates' && (
            <Card>
              <CardHeader
                title="Exchange Rates"
                description="Historical exchange rates for currency conversion. Rates are looked up by transaction date."
                actions={
                  <Button size="sm" variant="outline">
                    Add exchange rate
                  </Button>
                }
              />
              <CardBody className="px-0 py-0">
                {exchangeRates.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No exchange rates yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create your first exchange rate to enable currency conversion.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Base / Quote</Th>
                        <Th>Rate</Th>
                        <Th>Date</Th>
                        <Th>Source</Th>
                        <Th>FX Diff Treatment</Th>
                        <Th>Created</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {exchangeRates.map((er) => (
                        <tr key={er.id}>
                          <Td>
                            <span className="mono text-xs">{er.baseCurrency.code}</span> /
                            <span className="mono text-xs">{er.quoteCurrency.code}</span>
                          </Td>
                          <Td className="mono text-xs">{Number(er.rate).toFixed(6)}</Td>
                          <Td className="text-muted-foreground text-xs">
                            {new Date(er.rateDate).toISOString().split('T')[0]}
                          </Td>
                          <Td className="text-muted-foreground text-xs">{er.source}</Td>
                          <Td>
                            <Badge tone={er.differenceTreatment === 'EXPENSE' ? 'danger' : er.differenceTreatment === 'INCOME' ? 'success' : 'warning'}>
                              {er.differenceTreatment}
                            </Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs">
                            {new Date(er.createdAt).toISOString().split('T')[0]}
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