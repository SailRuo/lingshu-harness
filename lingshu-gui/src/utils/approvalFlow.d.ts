export interface ResumeApprovedTaskOptions {
  resume: (taskId: string) => Promise<unknown>;
  taskId?: string | null;
}

export interface ApprovalFlowOptions extends ResumeApprovedTaskOptions {
  approve: () => Promise<{ ok?: boolean; errorMessage?: string | null } | null | undefined>;
}

export interface ApprovalFlowResult {
  approved: boolean;
  resumeAttempted: boolean;
  resumeSucceeded: boolean;
  resumeNotRequired: boolean;
  errorMessage: string | null;
  resumeErrorMessage?: string | null;
}

export function resumeApprovedTask(options: ResumeApprovedTaskOptions): Promise<ApprovalFlowResult>;

export function runApprovalFlow(options: ApprovalFlowOptions): Promise<ApprovalFlowResult>;
