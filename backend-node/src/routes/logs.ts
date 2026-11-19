import type { FastifyInstance } from "fastify";
import { listLogEvents, pushLogEvent, subscribeLogs } from "../services/logService.js";

const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>LingShu Logs</title>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:16px}
h1{font-size:16px;color:#58a6ff;margin:0 0 12px}
#logs{display:flex;flex-direction:column;gap:4px;font-size:12px}
.row{border-bottom:1px solid #21262d;padding:4px 0;white-space:pre-wrap;word-break:break-word}
.level-info{color:#79c0ff}.level-warn{color:#d29922}.level-error,.level-fatal{color:#f85149}.level-debug,.level-trace{color:#8b949e}
.meta{color:#8b949e;margin-right:8px}
</style></head>
<body><h1>LingShu Node Logs</h1><div id="logs"></div>
<script type="module" src="/api/v1/logs/view.js"></script></body></html>`;

const VIEWER_JS = `
const container = document.getElementById('logs');
function add(event){
  const row = document.createElement('div');
  row.className = 'row level-' + event.level;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = new Date(event.timestamp).toLocaleTimeString() + ' ' + event.levelLabel;
  const text = document.createElement('span');
  text.textContent = event.message;
  row.append(meta, text);
  container.appendChild(row);
  while (container.children.length > 800) container.removeChild(container.firstChild);
  window.scrollTo(0, document.body.scrollHeight);
}
const initial = await fetch('/api/v1/logs/events?limit=300').then(r=>r.json()).catch(()=>[]);
initial.forEach(add);
const source = new EventSource('/api/v1/logs/stream');
source.addEventListener('app_log', (event)=>{
  try { add(JSON.parse(event.data)); } catch {}
});
`;

const SHARED_JS = `export function connectLogs(onEvent){
  const source = new EventSource('/api/v1/logs/stream');
  source.addEventListener('app_log', (event) => {
    try { onEvent(JSON.parse(event.data)); } catch {}
  });
  return () => source.close();
}`;

export async function registerLogsRoutes(app: FastifyInstance) {
  app.get("/api/v1/logs/events", async (req) => {
    const query = req.query as Record<string, any>;
    return listLogEvents({
      sessionId: query.sessionId ? String(query.sessionId) : undefined,
      level: query.level ? String(query.level) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  app.post("/api/v1/client-logs", async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    pushLogEvent({
      level: Number(body.level) || 30,
      time: Date.now(),
      msg: `[client] ${String(body.message || body.stage || "log").slice(0, 1500)}`,
      component: "frontend",
      kind: "client",
      presentation: { category: "frontend", title: String(body.stage || "client") },
      extra: body.data && typeof body.data === "object" ? body.data : {},
    });
    return { status: "success" };
  });

  app.get("/api/v1/logs/stream", async (req, reply) => {
    const query = req.query as Record<string, any>;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const event of listLogEvents({
      sessionId: query.sessionId ? String(query.sessionId) : undefined,
      level: query.level ? String(query.level) : undefined,
      limit: 100,
    })) {
      res.write(`event: app_log\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = subscribeLogs((event) => {
      if (query.sessionId && event.sessionId !== String(query.sessionId)) return;
      if (!res.writableEnded) {
        res.write(`event: app_log\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 5000);
    res.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.get("/api/v1/logs/view", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(VIEWER_HTML);
  });
  app.get("/api/v1/logs/view.js", async (_req, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(VIEWER_JS);
  });
  app.get("/api/v1/logs/view-shared.mjs", async (_req, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(SHARED_JS);
  });
}
