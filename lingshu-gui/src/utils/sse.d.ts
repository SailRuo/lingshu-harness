export function consumeSseBuffer(buffer: string): { payloads: string[]; rest: string };
export function flushTrailingSseBuffer(buffer: string): string[];
