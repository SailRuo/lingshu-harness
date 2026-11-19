export interface PlanHardFailureSummary {
  kind: string;
  message: string;
}

export function derivePlanHardFailureSummary(
  events: Record<string, any>[] | null | undefined,
): PlanHardFailureSummary | null;
