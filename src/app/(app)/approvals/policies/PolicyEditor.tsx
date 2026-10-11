'use client';

import { useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select, SelectOption, Card, CardHeader, CardBody, Alert } from '@/components/ui';
import { createPolicyAction, updatePolicyAction } from './actions';

interface PolicyStep {
  id: string;
  stepOrder: number;
  name: string;
  type: string;
  assigneeType: string;
  assigneeRoleId: string | null;
  assigneeUserId: string | null;
  resolutionMode: string;
  quorum: number | null;
  conditionOperator: string | null;
  conditionValue: unknown;
  isRequired: boolean;
  isFinalApprover: boolean;
  assigneeRole: { id: string; code: string } | null;
  assigneeUser: { id: string; fullName: string } | null;
}

interface PolicyEditorStep {
  id: string;
  stepOrder: number;
  name: string;
  type: typeof stepTypeOptions[number];
  assigneeType: typeof assigneeTypeOptions[number];
  assigneeRoleId: string | null;
  assigneeUserId: string | null;
  resolutionMode: typeof resolutionModeOptions[number];
  quorum: number | undefined;
  conditionOperator: typeof conditionOperatorOptions[number] | null;
  conditionValue: unknown;
  isRequired: boolean;
  isFinalApprover: boolean;
}

interface PolicyEditorProps {
  policy: {
    id: string;
    name: string;
    description: string | null;
    entityType: string;
    isActive: boolean;
    priority: number;
    steps: PolicyStep[];
  };
}

const stepTypeOptions = ['APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF'] as const;
const assigneeTypeOptions = ['ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER'] as const;
const resolutionModeOptions = ['ANY', 'ALL', 'QUORUM'] as const;
const conditionOperatorOptions = [
  'ALWAYS',
  'AMOUNT_GREATER_THAN',
  'AMOUNT_GREATER_OR_EQUAL',
  'AMOUNT_LESS_THAN',
  'AMOUNT_BETWEEN',
  'PERCENT_OF_BUDGET',
  'OVER_BUDGET',
  'NEW_COUNTERPARTY',
  'SUPPLIER_BANK_DETAIL_CHANGED',
  'FUNDING_RESTRICTED',
  'CROSS_PROJECT',
  'CURRENCY_NOT_BASE',
  'MANUAL_FLAG',
] as const;

function SubmitButton({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" size="sm" disabled={pending}>{pending ? pendingLabel : children}</Button>;
}

function ActionFeedback({ state }: { state: { ok: boolean; message?: string } | null }) {
  if (!state?.message) return null;
  return <div className="mt-3"><Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert></div>;
}

export function PolicyEditor({ policy }: PolicyEditorProps) {
  const isNew = !policy.id || policy.id === 'new';
  const router = useRouter();
  const [steps, setSteps] = useState<PolicyEditorStep[]>(
    policy.steps.length > 0
      ? policy.steps.map((s) => ({
          id: s.id,
          stepOrder: s.stepOrder,
          name: s.name,
          type: s.type as typeof stepTypeOptions[number],
          assigneeType: s.assigneeType as typeof assigneeTypeOptions[number],
          assigneeRoleId: s.assigneeRoleId,
          assigneeUserId: s.assigneeUserId,
          resolutionMode: s.resolutionMode as typeof resolutionModeOptions[number],
          quorum: s.quorum ?? undefined,
          conditionOperator: s.conditionOperator as typeof conditionOperatorOptions[number] | null,
          conditionValue: s.conditionValue,
          isRequired: s.isRequired,
          isFinalApprover: s.isFinalApprover,
        }))
      : [
          {
            id: '',
            stepOrder: 1,
            name: '',
            type: 'APPROVAL' as const,
            assigneeType: 'ROLE' as const,
            assigneeRoleId: '',
            assigneeUserId: '',
            resolutionMode: 'ANY' as const,
            quorum: undefined,
            conditionOperator: 'ALWAYS' as const,
            conditionValue: null,
            isRequired: true,
            isFinalApprover: false,
          },
        ]
  );

  const [name, setName] = useState(policy.name);
  const [description, setDescription] = useState(policy.description ?? '');
  const [isActive, setIsActive] = useState(policy.isActive);
  const [priority, setPriority] = useState(policy.priority);
  const [entityType, setEntityType] = useState(policy.entityType);

  const entityTypeOptions = [
    'TRANSACTION',
    'JOURNAL_ENTRY',
    'INVOICE',
    'PAYMENT',
    'RECEIPT',
    'QUOTATION',
    'CREDIT_NOTE',
    'DEBIT_NOTE',
    'REFUND',
    'BUDGET',
    'BUDGET_REVISION',
    'BUDGET_TRANSFER',
    'COMMITMENT',
    'PERIOD_REOPEN',
    'FINANCIAL_CLOSE',
    'ADJUSTMENT',
    'REVERSAL',
    'MASTER_DATA_CHANGE',
    'SUPPLIER_BANK_DETAIL_CHANGE',
    'CUSTOMER_CREDIT_LIMIT',
    'DOCUMENT',
    'IMPORT_BATCH',
    'RECONCILIATION',
    'RECONCILIATION_ADJUSTMENT',
    'TAX_FILING',
  ] as const;

  const action = isNew ? createPolicyAction : updatePolicyAction;
  const [state, formAction] = useActionState(action, null);

  const handleStepChange = (index: number, field: string, value: unknown) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  const addStep = () => {
    const maxOrder = Math.max(...steps.map((s) => s.stepOrder), 0);
    setSteps((prev) => [
      ...prev,
      {
        id: '',
        stepOrder: maxOrder + 1,
        name: '',
        type: 'APPROVAL' as const,
        assigneeType: 'ROLE' as const,
        assigneeRoleId: '',
        assigneeUserId: '',
        resolutionMode: 'ANY' as const,
        quorum: undefined,
        conditionOperator: 'ALWAYS' as const,
        conditionValue: null,
        isRequired: true,
        isFinalApprover: false,
      },
    ]);
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStep = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= steps.length) return;
    setSteps((prev) => {
      const newSteps = [...prev];
      const moved = newSteps[fromIndex];
      if (!moved) return prev;
      newSteps.splice(fromIndex, 1);
      newSteps.splice(toIndex, 0, moved);
      return newSteps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
    });
  };

  const getConditionValueFields = (operator: string) => {
    switch (operator) {
      case 'AMOUNT_GREATER_THAN':
      case 'AMOUNT_GREATER_OR_EQUAL':
      case 'AMOUNT_LESS_THAN':
        return <Input name="conditionValueAmount" type="number" step="0.01" placeholder="Threshold amount" className="w-48" />;
      case 'AMOUNT_BETWEEN':
        return (
          <div className="flex gap-2">
            <Input name="conditionValueMin" type="number" step="0.01" placeholder="Min" className="w-36" />
            <span>to</span>
            <Input name="conditionValueMax" type="number" step="0.01" placeholder="Max" className="w-36" />
          </div>
        );
      case 'PERCENT_OF_BUDGET':
        return <Input name="conditionValuePercent" type="number" step="1" min="1" max="100" placeholder="Percent" className="w-36" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{isNew ? 'Create policy' : `Edit: ${policy.name}`}</h1>
        <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/approvals/policies')}>
          ← Back to list
        </Button>
      </div>

      <Card>
        <CardHeader title="Policy basics" />
        <CardBody className="space-y-4">
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="policyId" value={isNew ? '' : policy.id} />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="entityType">Entity type</Label>
                <Select
                  id="entityType"
                  name="entityType"
                  required
                  value={entityType}
                  onChange={(e) => setEntityType(e.target.value as typeof entityTypeOptions[number])}
                >
                  {['TRANSACTION', 'JOURNAL_ENTRY', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION', 'CREDIT_NOTE', 'DEBIT_NOTE', 'REFUND', 'BUDGET', 'BUDGET_REVISION', 'BUDGET_TRANSFER', 'COMMITMENT', 'PERIOD_REOPEN', 'FINANCIAL_CLOSE', 'ADJUSTMENT', 'REVERSAL', 'MASTER_DATA_CHANGE', 'SUPPLIER_BANK_DETAIL_CHANGE', 'CUSTOMER_CREDIT_LIMIT', 'DOCUMENT', 'IMPORT_BATCH', 'RECONCILIATION', 'RECONCILIATION_ADJUSTMENT', 'TAX_FILING'].map((t) => (
                    <SelectOption key={t} value={t}>{t.replace(/_/g, ' ')}</SelectOption>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="priority">Priority (lower = evaluated first)</Label>
                <Input id="priority" name="priority" type="number" value={priority} onChange={(e) => setPriority(parseInt(e.target.value, 10))} />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer w-full">
                  <input
                    type="checkbox"
                    name="isActive"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="border-border-strong h-4 w-4 rounded"
                  />
                  <span className="text-sm">Active</span>
                </label>
              </div>
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <Input id="description" name="description" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="flex gap-2 pt-4 border-t border-border-subtle">
              <SubmitButton pendingLabel={isNew ? 'Creating...' : 'Saving...'}>{isNew ? 'Create policy' : 'Save policy'}</SubmitButton>
              <Button type="button" variant="outline" size="sm" onClick={() => router.push('/approvals/policies')}>Cancel</Button>
            </div>

            <ActionFeedback state={state} />
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Steps"
          description="Steps are evaluated in order. Only steps with matching conditions are included in the workflow."
        />
        <CardBody className="space-y-4">
          {steps.map((step, index) => (
            <div key={step.id || index} className="border-border-subtle border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">Step {step.stepOrder}</span>
                <div className="flex items-center gap-2">
                  {index > 0 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => moveStep(index, index - 1)}>↑</Button>
                  )}
                  {index < steps.length - 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => moveStep(index, index + 1)}>↓</Button>
                  )}
                  {steps.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" className="text-negative" onClick={() => removeStep(index)}>Remove</Button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <Label htmlFor={`step-${index}-name`}>Name</Label>
                  <Input
                    id={`step-${index}-name`}
                    name={`steps[${index}].name`}
                    required
                    value={step.name}
                    onChange={(e) => handleStepChange(index, 'name', e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor={`step-${index}-type`}>Type</Label>
                  <Select
                    id={`step-${index}-type`}
                    name={`steps[${index}].type`}
                    value={step.type}
                    onChange={(e) => handleStepChange(index, 'type', e.target.value)}
                  >
                    {stepTypeOptions.map((t) => (
                      <SelectOption key={t} value={t}>{t}</SelectOption>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`step-${index}-assigneeType`}>Assignee type</Label>
                  <Select
                    id={`step-${index}-assigneeType`}
                    name={`steps[${index}].assigneeType`}
                    value={step.assigneeType}
                    onChange={(e) => handleStepChange(index, 'assigneeType', e.target.value)}
                  >
                    {assigneeTypeOptions.map((t) => (
                      <SelectOption key={t} value={t}>{t.replace(/_/g, ' ')}</SelectOption>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`step-${index}-resolutionMode`}>Resolution</Label>
                  <Select
                    id={`step-${index}-resolutionMode`}
                    name={`steps[${index}].resolutionMode`}
                    value={step.resolutionMode}
                    onChange={(e) => handleStepChange(index, 'resolutionMode', e.target.value)}
                  >
                    {resolutionModeOptions.map((t) => (
                      <SelectOption key={t} value={t}>{t}</SelectOption>
                    ))}
                  </Select>
                </div>

                {(step.assigneeType === 'ROLE' || step.assigneeType === 'USER_DELEGATED') && (
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Label htmlFor={`step-${index}-assigneeRoleId`}>Assignee role</Label>
                    <Select
                      id={`step-${index}-assigneeRoleId`}
                      name={`steps[${index}].assigneeRoleId`}
                      value={step.assigneeRoleId ?? ''}
                      onChange={(e) => handleStepChange(index, 'assigneeRoleId', e.target.value || null)}
                    >
                      <SelectOption value="">Select role</SelectOption>
                      <SelectOption value="CEO">CEO</SelectOption>
                      <SelectOption value="FINANCE_OFFICER">Finance Officer</SelectOption>
                      <SelectOption value="ACCOUNTANT">Accountant</SelectOption>
                    </Select>
                  </div>
                )}

                {(step.assigneeType === 'USER' || step.assigneeType === 'SPECIFIC_USER') && (
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Label htmlFor={`step-${index}-assigneeUserId`}>Assignee user</Label>
                    <Input
                      id={`step-${index}-assigneeUserId`}
                      name={`steps[${index}].assigneeUserId`}
                      value={step.assigneeUserId ?? ''}
                      onChange={(e) => handleStepChange(index, 'assigneeUserId', e.target.value || null)}
                      placeholder="User ID"
                    />
                  </div>
                )}

                {step.resolutionMode === 'QUORUM' && (
                  <div>
                    <Label htmlFor={`step-${index}-quorum`}>Quorum</Label>
                    <Input
                      id={`step-${index}-quorum`}
                      name={`steps[${index}].quorum`}
                      type="number"
                      min="1"
                      value={step.quorum ?? ''}
                      onChange={(e) => handleStepChange(index, 'quorum', parseInt(e.target.value, 10) || undefined)}
                    />
                  </div>
                )}

                <div className="sm:col-span-2 lg:col-span-4">
                  <Label htmlFor={`step-${index}-conditionOperator`}>Condition</Label>
                  <Select
                    id={`step-${index}-conditionOperator`}
                    name={`steps[${index}].conditionOperator`}
                    value={step.conditionOperator ?? 'ALWAYS'}
                    onChange={(e) => handleStepChange(index, 'conditionOperator', e.target.value || 'ALWAYS')}
                  >
                    {conditionOperatorOptions.map((t) => (
                      <SelectOption key={t} value={t}>{t.replace(/_/g, ' ')}</SelectOption>
                    ))}
                  </Select>
                  {getConditionValueFields(step.conditionOperator ?? 'ALWAYS')}
                </div>

                <div className="flex items-end gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      name={`steps[${index}].isRequired`}
                      checked={step.isRequired}
                      onChange={(e) => handleStepChange(index, 'isRequired', e.target.checked)}
                      className="border-border-strong h-4 w-4 rounded"
                    />
                    <span className="text-sm">Required</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      name={`steps[${index}].isFinalApprover`}
                      checked={step.isFinalApprover}
                      onChange={(e) => handleStepChange(index, 'isFinalApprover', e.target.checked)}
                      className="border-border-strong h-4 w-4 rounded"
                    />
                    <span className="text-sm">Final approver</span>
                  </label>
                </div>
              </div>
            </div>
          ))}

          <Button type="button" variant="outline" size="sm" onClick={addStep} className="w-full">+ Add step</Button>
        </CardBody>
      </Card>
    </div>
  );
}