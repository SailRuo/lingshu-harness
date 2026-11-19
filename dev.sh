#!/usr/bin/env bash
#
# 灵枢桌面端本地启动脚本：一条命令同时拉起 Node 后端和桌面端。
#
#   ./dev.sh              后端 + Tauri 桌面窗口（默认，Vite 由 beforeDevCommand 拉起）
#   ./dev.sh --web        后端 + Vite 开发服务器（浏览器访问脚本探测出的端口）
#   ./dev.sh --backend    只启动后端
#   ./dev.sh --gui        只启动前端（连已在跑的后端）
#
# 端口默认 8600（后端）/ 1420（前端），被占用时自动顺延到下一个空闲端口；
# 后端端口变化会通过 VITE_API_BASE_URL 同步给前端，Tauri 模式会同时改写 devUrl。
#
# 其它参数：
#   --port <n>       指定后端端口（指定后不再自动顺延）
#   --gui-port <n>   指定前端端口（指定后不再自动顺延）
#   --verbose        前端/后端日志直接输出到终端，不写入 .dev-logs/
#   -h, --help       显示帮助
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend-node"
GUI_DIR="$ROOT/lingshu-gui"
LOG_DIR="$ROOT/.dev-logs"

BACKEND_PORT="${BACKEND_PORT:-8600}"
GUI_PORT="${LINGSHU_GUI_PORT:-1420}"
MODE="tauri"   # tauri | web
ONLY=""        # "" | backend | gui
VERBOSE=0
BACKEND_PORT_EXPLICIT=0
GUI_PORT_EXPLICIT=0

BACKEND_PID=""
GUI_PID=""

usage() {
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

log()  { printf '\033[36m[灵枢]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[灵枢]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[灵枢]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 参数解析 ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tauri)   MODE="tauri" ;;
    --web)     MODE="web" ;;
    --backend) ONLY="backend" ;;
    --gui)     ONLY="gui" ;;
    --verbose) VERBOSE=1 ;;
    --port)
      [[ $# -ge 2 ]] || die "--port 需要一个端口号"
      BACKEND_PORT="$2"; BACKEND_PORT_EXPLICIT=1; shift ;;
    --gui-port)
      [[ $# -ge 2 ]] || die "--gui-port 需要一个端口号"
      GUI_PORT="$2"; GUI_PORT_EXPLICIT=1; shift ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

[[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字：$BACKEND_PORT"
[[ "$GUI_PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字：$GUI_PORT"

# --- 环境检查 ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 20+"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "需要 Node.js 20 及以上，当前 $(node -v)"
fi

if [[ "$MODE" == "tauri" && "$ONLY" != "backend" ]] && ! command -v cargo >/dev/null 2>&1; then
  die "Tauri 需要 Rust 工具链（https://rustup.rs）；只想跑网页版用 ./dev.sh --web"
fi

# --- 工具函数 ---------------------------------------------------------------
health_ok() {
  curl -sf --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# 从 start 开始向上找第一个空闲端口（最多看 20 个）。
find_free_port() {
  local port="$1" limit=$(( $1 + 20 ))
  while (( port <= limit )); do
    if ! port_in_use "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$(( port + 1 ))
  done
  return 1
}

# 逐层杀掉子进程，避免 npm → tsx / vite 留下孤儿进程。
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# 兜底：tauri 的 beforeDevCommand 偶尔会脱离进程树（父 shell 先退出），
# 按端口反查所属进程，只回收当前工作区起的 vite / tsx。
reap_workspace_port() {
  local port="${1:-}" pid cmd
  [[ -n "$port" ]] || return 0
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *"$ROOT"*)
        log "回收端口 ${port} 上的残留进程 (pid $pid)"
        kill_tree "$pid" ;;
    esac
  done
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "$GUI_PID" ]] && kill -0 "$GUI_PID" 2>/dev/null; then
    log "停止前端 (pid $GUI_PID)"
    kill_tree "$GUI_PID"
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    log "停止后端 (pid $BACKEND_PID)"
    kill_tree "$BACKEND_PID"
  fi
  reap_workspace_port "${GUI_PORT:-}"
  reap_workspace_port "${BACKEND_PORT:-}"
  exit "$code"
}
trap cleanup EXIT INT TERM

ensure_deps() {
  local dir="$1" name="$2"
  if [[ ! -d "$dir/node_modules" ]]; then
    log "$name 依赖未安装，执行 npm install…"
    ( cd "$dir" && npm install )
  fi
}

wait_for() {
  local what="$1" check="$2" tries="$3" i=0
  while (( i < tries )); do
    if eval "$check"; then return 0; fi
    sleep 0.5
    i=$(( i + 1 ))
  done
  return 1
}

# --- 后端 -------------------------------------------------------------------
start_backend() {
  if health_ok; then
    log "后端已在 ${BACKEND_PORT} 端口运行，直接复用"
    return 0
  fi
  if port_in_use "$BACKEND_PORT"; then
    if [[ "$BACKEND_PORT_EXPLICIT" -eq 1 ]]; then
      die "端口 ${BACKEND_PORT} 被其它进程占用（不是灵枢后端）"
    fi
    local fallback
    fallback="$(find_free_port $(( BACKEND_PORT + 1 )))" \
      || die "${BACKEND_PORT} 往后 20 个端口都被占用了，用 --port 指定一个空闲端口"
    warn "端口 ${BACKEND_PORT} 被其它进程占用，后端改用 ${fallback}"
    BACKEND_PORT="$fallback"
  fi

  ensure_deps "$BACKEND_DIR" "后端"
  mkdir -p "$LOG_DIR"

  log "启动后端 (PORT=${BACKEND_PORT})…"
  if [[ "$VERBOSE" -eq 1 ]]; then
    ( cd "$BACKEND_DIR" && PORT="$BACKEND_PORT" exec npm run dev ) &
  else
    ( cd "$BACKEND_DIR" && PORT="$BACKEND_PORT" exec npm run dev ) \
      >"$LOG_DIR/backend.log" 2>&1 &
  fi
  BACKEND_PID=$!

  if ! wait_for "后端" health_ok 120; then
    if [[ "$VERBOSE" -eq 0 && -f "$LOG_DIR/backend.log" ]]; then
      warn "后端 60s 内没有就绪，日志末尾："
      tail -n 30 "$LOG_DIR/backend.log" >&2
    fi
    die "后端启动失败"
  fi
  log "后端就绪：http://127.0.0.1:${BACKEND_PORT}/health"
}

# --- 前端 -------------------------------------------------------------------
start_gui() {
  ensure_deps "$GUI_DIR" "前端"

  local gui_port="$GUI_PORT"
  if port_in_use "$gui_port"; then
    if [[ "$GUI_PORT_EXPLICIT" -eq 1 ]]; then
      die "端口 ${gui_port} 已被占用"
    fi
    local gui_fallback
    gui_fallback="$(find_free_port $(( gui_port + 1 )))" \
      || die "${gui_port} 往后 20 个端口都被占用了，用 --gui-port 指定一个空闲端口"
    warn "端口 ${gui_port} 被其它进程占用，前端改用 ${gui_fallback}"
    gui_port="$gui_fallback"
  fi
  GUI_PORT="$gui_port"

  mkdir -p "$LOG_DIR"

  # Tauri 的 devUrl / beforeDevCommand 写死 1420；换端口时用 --config 覆盖这两项。
  local cmd
  if [[ "$MODE" == "tauri" ]]; then
    local tauri_config=""
    if [[ "$gui_port" != "1420" ]]; then
      tauri_config="$LOG_DIR/tauri.dev.json"
      cat >"$tauri_config" <<EOF
{
  "build": {
    "devUrl": "http://localhost:${gui_port}",
    "beforeDevCommand": "npm run dev -- --port ${gui_port}"
  }
}
EOF
      cmd=(npm run tauri dev -- --config "$tauri_config")
    else
      cmd=(npm run tauri dev)
    fi
    log "启动 Tauri 桌面窗口（Vite ${gui_port}，首次编译 Rust 需要几分钟）…"
  else
    log "启动 Vite 开发服务器…"
    cmd=(npm run dev -- --port "$gui_port")
  fi

  # 前端连哪个后端以 VITE_API_BASE_URL 为准，后端换端口时在这里同步（进程env 优先级高于 .env.local）。
  if [[ "$VERBOSE" -eq 1 ]]; then
    ( cd "$GUI_DIR" && VITE_API_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" exec "${cmd[@]}" ) &
  else
    ( cd "$GUI_DIR" && VITE_API_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" exec "${cmd[@]}" ) \
      >"$LOG_DIR/gui.log" 2>&1 &
  fi
  GUI_PID=$!

  if [[ "$MODE" == "tauri" ]]; then
    # tauri dev 先编译 Rust，失败往往几秒内就退出；早点抓出来给日志，别挂在那儿等。
    sleep 8
    if ! kill -0 "$GUI_PID" 2>/dev/null; then
      if [[ "$VERBOSE" -eq 0 && -f "$LOG_DIR/gui.log" ]]; then
        warn "Tauri 启动失败，日志末尾："
        tail -n 30 "$LOG_DIR/gui.log" >&2
      fi
      die "Tauri 启动失败"
    fi
  fi

  if [[ "$MODE" == "web" ]]; then
    if ! wait_for "前端" "curl -sf --max-time 2 http://127.0.0.1:${gui_port}/ >/dev/null 2>&1" 120; then
      if [[ "$VERBOSE" -eq 0 && -f "$LOG_DIR/gui.log" ]]; then
        warn "前端 60s 内没有就绪，日志末尾："
        tail -n 30 "$LOG_DIR/gui.log" >&2
      fi
      die "前端启动失败"
    fi
  fi
}

# --- 主流程 -----------------------------------------------------------------
if [[ "$ONLY" != "gui" ]]; then
  start_backend
fi

if [[ "$ONLY" != "backend" ]]; then
  start_gui
fi

echo
log "──── 灵枢已启动 ────"
if [[ "$ONLY" != "gui" ]]; then
  log "后端  http://127.0.0.1:${BACKEND_PORT}   日志 .dev-logs/backend.log"
fi
if [[ "$ONLY" != "backend" ]]; then
  if [[ "$MODE" == "web" ]]; then
    log "前端  http://localhost:${GUI_PORT}  日志 .dev-logs/gui.log"
  else
    log "桌面窗口正在启动，日志 .dev-logs/gui.log"
  fi
fi
log "按 Ctrl-C 退出（会一并关闭子进程）"
echo

# 前台等待：任一进程退出就整体收尾（macOS 自带 bash 3.2 没有 wait -n）。
if [[ -n "$GUI_PID" && -n "$BACKEND_PID" ]]; then
  while kill -0 "$GUI_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
    sleep 2
  done
elif [[ -n "$GUI_PID" ]]; then
  wait "$GUI_PID" || true
elif [[ -n "$BACKEND_PID" ]]; then
  wait "$BACKEND_PID" || true
fi
