const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const START_MARKER_LINE_RE = /^.*__COMMAND_START_[a-f0-9]{8}__.*\s*$/gim;
const EXIT_MARKER_LINE_RE = /^.*__EXIT_CODE_[a-f0-9]{8}__.*(?:\r?\n[+-]?\d+)?\s*$/gim;
const POWERSHELL_PROMPT_RE = /^PS [A-Za-z]:\\[^>\r\n]*>\s*$/gm;
const CMD_PROMPT_RE = /^[A-Za-z]:\\[^>\r\n]*>\s*$/gm;

const NOISE_PATTERNS = [
  /^Windows PowerShell$/i,
  /^Copyright \(C\) Microsoft Corporation\. All rights reserved\.$/i,
  /^Try the new cross-platform PowerShell .+$/i,
  /^Loading personal and system profiles took \d+ms\.$/i,
  /^管理员: .*powershell\.exe$/i,
];

function isNoiseLine(line) {
  const normalized = line.trim();
  if (!normalized) return false;
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function sanitizeTerminalDisplayOutput(raw) {
  if (!raw) return '';

  const normalized = String(raw)
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\0/g, '')
    .replace(/\r/g, '');

  const withoutMarkers = normalized
    .replace(START_MARKER_LINE_RE, '')
    .replace(EXIT_MARKER_LINE_RE, '')
    .replace(POWERSHELL_PROMPT_RE, '')
    .replace(CMD_PROMPT_RE, '');

  const lines = withoutMarkers
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !isNoiseLine(line));

  return lines.join('\n').trim();
}
