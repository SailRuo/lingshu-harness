export interface TimelineProcessItem {
  kind: 'process';
  id: string;
  events: unknown[];
}

export interface TimelineTextItem {
  kind: 'text';
  id: string;
  content: string;
  bubbleIndex?: number;
}

export type TimelineItem = TimelineProcessItem | TimelineTextItem;

export declare function hasProcessTimelineEvents(events: unknown[]): boolean;

export declare function buildTimelineItems(
  events: unknown[],
  fallbackContent?: string,
): TimelineItem[];

export declare function bucketTimelineItemsByBubble(items: TimelineItem[]): Map<number, TimelineItem[]>;

export declare function isCompanionChatTimeline(events: unknown[]): boolean;

export declare function buildCompanionDialogueDisplayItems(
  allEvents: unknown[],
  fallbackContent?: string,
): TimelineItem[];

export declare function joinCompanionDialogueText(textItems: TimelineItem[]): string;

export declare function buildCompanionLiveText(
  allEvents: unknown[],
  fallbackContent?: string,
): string;

export declare function shouldShowCompanionWorkingHint(
  events: unknown[],
  messageStatus?: string,
  liveText?: string,
): boolean;

export declare function reorderBubbleItemsForDisplay(
  items: TimelineItem[],
  events: unknown[],
): TimelineItem[];

export declare function timelineItemsForBubble(
  allEvents: unknown[],
  bubbleIndex: number,
  fallbackContent?: string,
): TimelineItem[];
