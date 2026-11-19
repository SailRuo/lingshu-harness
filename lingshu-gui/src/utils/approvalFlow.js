function isResumeNotRequiredError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Only interrupted tasks can be resumed/i.test(message);
}

export async function resumeApprovedTask({ resume, taskId }) {
  if (!taskId) {
    return {
      approved: true,
      resumeAttempted: false,
      resumeSucceeded: false,
      resumeNotRequired: false,
      errorMessage: null,
      resumeErrorMessage: null,
    };
  }

  try {
    await resume(taskId);
    return {
      approved: true,
      resumeAttempted: true,
      resumeSucceeded: true,
      resumeNotRequired: false,
      errorMessage: null,
      resumeErrorMessage: null,
    };
  } catch (error) {
    if (isResumeNotRequiredError(error)) {
      return {
        approved: true,
        resumeAttempted: true,
        resumeSucceeded: false,
        resumeNotRequired: true,
        errorMessage: null,
        resumeErrorMessage: null,
      };
    }
    return {
      approved: true,
      resumeAttempted: true,
      resumeSucceeded: false,
      resumeNotRequired: false,
      errorMessage: null,
      resumeErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runApprovalFlow({ approve, resume, taskId }) {
  const approvalResult = await approve();
  if (!approvalResult?.ok) {
    return {
      approved: false,
      resumeAttempted: false,
      resumeSucceeded: false,
      resumeNotRequired: false,
      errorMessage: approvalResult?.errorMessage || '批准执行失败',
    };
  }

  return resumeApprovedTask({ resume, taskId });
}
