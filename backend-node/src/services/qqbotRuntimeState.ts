export type QqBotConnectionState = "disconnected" | "connecting" | "connected";

const states = new Map<number, QqBotConnectionState>();

export function setQqBotConnectionState(bindingId: number, state: QqBotConnectionState) {
  states.set(bindingId, state);
}

export function getQqBotConnectionState(bindingId: number): QqBotConnectionState {
  return states.get(bindingId) || "disconnected";
}

export function clearQqBotConnectionState(bindingId: number) {
  states.delete(bindingId);
}

/** 网关 runner 进程存活登记（区别于连接状态：runner 活着但可能还在重连）。 */
const activeRunners = new Set<number>();

export function setQqBotRunnerActive(bindingId: number, active: boolean) {
  if (active) activeRunners.add(bindingId);
  else activeRunners.delete(bindingId);
}

export function isQqBotRunnerActive(bindingId: number): boolean {
  return activeRunners.has(bindingId);
}
