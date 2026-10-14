'use client';

import { useState } from 'react';
import RowActions from './RowActions';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { cn } from '@/lib/format';
import AddLocationButton from './AddLocationButton';
import AddRecordButton, {
  DEPARTMENTS_CONFIG,
  COST_CENTRES_CONFIG,
  PROJECTS_CONFIG,
  FUNDING_SOURCES_CONFIG,
  CURRENCIES_CONFIG,
  EXCHANGE_RATES_CONFIG,
  REASON_CODES_CONFIG,
  PRODUCTS_SERVICES_CONFIG,
} from './AddRecordButton';

type Tab = 'locations' | 'departments' | 'cost-centres' | 'projects' | 'funding-sources' | 'currencies' | 'exchange-rates' | 'reason-codes' | 'products-services';

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

interface ReasonCode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProductService {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  unit: string | null;
  unitPrice: string | null;
  currency: { id: string; code: string; name: string; symbol: string | null } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MasterData {
  locations: Location[];
  departments: Department[];
  costCentres: CostCentre[];
  projects: Project[];
  fundingSources: FundingSource[];
  currencies: Currency[];
  exchangeRates: ExchangeRate[];
  reasonCodes: ReasonCode[];
  productsServices: ProductService[];
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
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>(initialData.reasonCodes);
  const [productsServices, setProductsServices] = useState<ProductService[]>(initialData.productsServices);

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'locations', label: 'Locations', count: locations.length },
    { id: 'departments', label: 'Departments', count: departments.length },
    { id: 'cost-centres', label: 'Cost Centres', count: costCentres.length },
    { id: 'projects', label: 'Projects', count: projects.length },
    { id: 'funding-sources', label: 'Funding Sources', count: fundingSources.length },
    { id: 'currencies', label: 'Currencies', count: currencies.length },
    { id: 'exchange-rates', label: 'Exchange Rates', count: exchangeRates.length },
    { id: 'reason-codes', label: 'Reason Codes', count: reasonCodes.length },
    { id: 'products-services', label: 'Products/Services', count: productsServices.length },
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
        title="Business Setup"
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
                  <AddLocationButton />
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
                          <Td><RowActions
                            entityType="LOCATION"
                            entityId={loc.id}
                            entityLabel={loc.name}
                            endpoint="/api/v1/locations"
                            initial={{ name: loc.name, type: loc.type, isOwned: loc.isOwned }}
                            fields={[
                              { name: "name", label: "Name" },
                              { name: "type", label: "Type", options: [
                                { value: "HEAD_OFFICE", label: "Head Office" },
                                { value: "OFFICE", label: "Office" },
                                { value: "LAB", label: "Lab" },
                                { value: "WAREHOUSE", label: "Warehouse" },
                                { value: "PROJECT_SITE", label: "Project Site" },
                                { value: "UNIVERSITY_FACILITY", label: "University Facility" },
                                { value: "PERMITTED_USE", label: "Permitted Use" },
                                { value: "REMOTE", label: "Remote" },
                                { value: "OTHER", label: "Other" },
                              ] },
                              { name: "isOwned", label: "Owned", type: "checkbox" },
                            ]}
                          /></Td>
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
                  <AddRecordButton config={DEPARTMENTS_CONFIG} />
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
                          <Td className="tabular text-right">{dept._count.costCentres}</Td>                          <Td><RowActions
                            entityType="DEPARTMENT"
                            entityId={dept.id}
                            entityLabel={dept.name}
                            endpoint="/api/v1/departments"
                            initial={{ name: dept.name }}
                            fields={[{"name":"name","label":"Name"}]}
                          /></Td>
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
                  <AddRecordButton config={COST_CENTRES_CONFIG} lookup={{ departmentId: departments.map((d) => ({ value: d.id, label: d.code + " \u00b7 " + d.name })) }} />
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
                          </Td>                          <Td><RowActions
                            entityType="COST_CENTRE"
                            entityId={cc.id}
                            entityLabel={cc.name}
                            endpoint="/api/v1/cost-centres"
                            initial={{ name: cc.name, description: cc.description }}
                            fields={[{"name":"name","label":"Name"},{"name":"description","label":"Description"}]}
                          /></Td>
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
                  <AddRecordButton config={PROJECTS_CONFIG} />
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
                          </Td>                          <Td><RowActions
                            entityType="PROJECT"
                            entityId={proj.id}
                            entityLabel={proj.name}
                            endpoint="/api/v1/projects"
                            initial={{ name: proj.name, description: proj.description, status: proj.status }}
                            fields={[{"name":"name","label":"Name"},{"name":"description","label":"Description"},{"name":"status","label":"Status","options":[{"value":"DRAFT","label":"Draft"},{"value":"ACTIVE","label":"Active"},{"value":"ON_HOLD","label":"On Hold"},{"value":"COMPLETED","label":"Completed"},{"value":"CANCELLED","label":"Cancelled"},{"value":"ARCHIVED","label":"Archived"}]}]}
                          /></Td>
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
                  <AddRecordButton config={FUNDING_SOURCES_CONFIG} />
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
                          </Td>                          <Td><RowActions
                            entityType="FUNDING_SOURCE"
                            entityId={fs.id}
                            entityLabel={fs.name}
                            endpoint="/api/v1/funding-sources"
                            initial={{ name: fs.name, description: fs.description }}
                            fields={[{"name":"name","label":"Name"},{"name":"description","label":"Description"}]}
                          /></Td>
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
                  <AddRecordButton config={CURRENCIES_CONFIG} />
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
                          </Td>                          <Td><RowActions
                            entityType="CURRENCY"
                            entityId={cur.id}
                            entityLabel={cur.name}
                            endpoint="/api/v1/currencies"
                            initial={{ name: cur.name, symbol: cur.symbol }}
                            fields={[{"name":"name","label":"Name"},{"name":"symbol","label":"Symbol"}]}
                          /></Td>
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
                  <AddRecordButton config={EXCHANGE_RATES_CONFIG} lookup={{ baseCurrencyId: currencies.map((c) => ({ value: c.id, label: c.code + " \u00b7 " + c.name })), quoteCurrencyId: currencies.map((c) => ({ value: c.id, label: c.code + " \u00b7 " + c.name })) }} />
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
                          </Td>                          <Td><RowActions
                            entityType="EXCHANGE_RATE"
                            entityId={er.id}
                            entityLabel={er.name}
                            endpoint="/api/v1/exchange-rates"
                            initial={{ rate: er.rate }}
                            fields={[{"name":"rate","label":"Rate"}]}
                          /></Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {activeTab === 'reason-codes' && (
            <Card>
              <CardHeader
                title="Reason Codes"
                description="Standardized reason codes for transaction categorization across revenue, expenses, transfers, and adjustments."
                actions={
                  <AddRecordButton config={REASON_CODES_CONFIG} />
                }
              />
              <CardBody className="px-0 py-0">
                {reasonCodes.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No reason codes yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create reason codes to categorize transactions consistently.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Category</Th>
                        <Th>Description</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {reasonCodes.map((rc) => (
                        <tr key={rc.id}>
                          <Td className="mono text-xs">{rc.code}</Td>
                          <Td><span className="font-medium">{rc.name}</span></Td>
                          <Td>
                            <Badge tone={
                              rc.category === 'REVENUE' ? 'success' :
                              rc.category === 'EXPENSE' ? 'danger' :
                              rc.category === 'TRANSFER' ? 'info' :
                              rc.category === 'ADJUSTMENT' ? 'warning' : 'neutral'
                            }>{rc.category}</Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs max-w-md truncate">{rc.description ?? '-'}</Td>
                          <Td>
                            {rc.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="warning">Inactive</Badge>
                            )}
                          </Td>                          <Td><RowActions
                            entityType="REASON_CODE"
                            entityId={rc.id}
                            entityLabel={rc.name}
                            endpoint="/api/v1/reason-codes"
                            initial={{ name: rc.name, description: rc.description }}
                            fields={[{"name":"name","label":"Name"},{"name":"description","label":"Description"}]}
                          /></Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}

          {activeTab === 'products-services' && (
            <Card>
              <CardHeader
                title="Products & Services"
                description="Product and service catalogue for revenue linkage and invoicing."
                actions={
                  <AddRecordButton config={PRODUCTS_SERVICES_CONFIG} />
                }
              />
              <CardBody className="px-0 py-0">
                {productsServices.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-foreground text-sm font-medium">No products or services yet</p>
                    <p className="text-muted-foreground mt-1 max-w-md text-xs">
                      Create products and services to enable revenue tracking and invoicing.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Name</Th>
                        <Th>Type</Th>
                        <Th>Unit</Th>
                        <Th>Unit Price</Th>
                        <Th>Currency</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {productsServices.map((ps) => (
                        <tr key={ps.id}>
                          <Td className="mono text-xs">{ps.code}</Td>
                          <Td><span className="font-medium">{ps.name}</span></Td>
                          <Td>
                            <Badge tone={ps.type === 'SERVICE' ? 'info' : 'success'}>{ps.type}</Badge>
                          </Td>
                          <Td className="text-muted-foreground text-xs">{ps.unit}</Td>
                          <Td className="mono text-xs">{ps.unitPrice ? Number(ps.unitPrice).toFixed(2) : '-'}</Td>
                          <Td className="text-muted-foreground text-xs">{ps.currency?.code ?? '-'}</Td>
                          <Td>
                            {ps.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="warning">Inactive</Badge>
                            )}
                          </Td>                          <Td><RowActions
                            entityType="PRODUCT_SERVICE"
                            entityId={ps.id}
                            entityLabel={ps.name}
                            endpoint="/api/v1/products-services"
                            initial={{ name: ps.name, unit: ps.unit, unitPrice: ps.unitPrice }}
                            fields={[{"name":"name","label":"Name"},{"name":"unit","label":"Unit"},{"name":"unitPrice","label":"Unit price"}]}
                          /></Td>
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