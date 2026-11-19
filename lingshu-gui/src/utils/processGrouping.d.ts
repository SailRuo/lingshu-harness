export interface ProcessGroupingEventLike {
  eventId?: string;
  eventSequence?: number;
  type?: string;
  attemptNo?: number;
  attemptGroupId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProcessGroupingNodeLike<TEvent = ProcessGroupingEventLike> {
  event: TEvent;
  children?: ProcessGroupingNodeLike<TEvent>[];
}

export interface AttemptGroup<TNode = ProcessGroupingNodeLike> {
  id: string;
  attemptNo: number;
  retryReason: string | null;
  nodes: TNode[];
}

export function attemptGroupKey(event: ProcessGroupingEventLike): string;
export function buildAttemptGroups<TNode extends ProcessGroupingNodeLike>(nodes: TNode[]): AttemptGroup<TNode>[];
export function retryReasonGroupLabel(retryReason: string | null): string | null;
export function isMeaningfulAttemptReason(retryReason: string | null): boolean;
export function shouldUseAttemptGroupLayout(groups: AttemptGroup[]): boolean;
export function shouldShowAttemptGroupHeader(groups: AttemptGroup[], group: AttemptGroup | null | undefined): boolean;
export function attemptGroupTone(group: { retryReason: string | null }): string;
