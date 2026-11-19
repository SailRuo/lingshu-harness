function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeSseEventBlock(block) {
  const lines = block.split('\n');
  const dataLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith(':')) continue; // SSE comment
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join('\n').trim();
}

export function consumeSseBuffer(buffer) {
  const normalized = normalizeLineEndings(buffer);
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() || '';
  const payloads = [];

  for (const block of blocks) {
    const payload = decodeSseEventBlock(block);
    if (payload) {
      payloads.push(payload);
    }
  }

  return { payloads, rest };
}

export function flushTrailingSseBuffer(buffer) {
  const payload = decodeSseEventBlock(normalizeLineEndings(buffer));
  return payload ? [payload] : [];
}
