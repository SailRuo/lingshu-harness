export interface ProcessPlanActivity {
  id: string;
  type: string;
  label: string;
  node?: any;
}

export interface ProcessPlanStepInput {
  id: string;
  label: string;
  actionType: string;
  status: string;
}

export interface ProcessPlanSummaryInput {
  currentStepIndex?: number;
  steps?: ProcessPlanStepInput[];
}

export interface ProcessPlanStep extends ProcessPlanStepInput {
  children: ProcessPlanActivity[];
}

export function buildPlanStepTree(
  summary: ProcessPlanSummaryInput | null | undefined,
  activities: ProcessPlanActivity[] | null | undefined,
): ProcessPlanStep[];
