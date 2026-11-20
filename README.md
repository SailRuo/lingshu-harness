# LingShu Harness

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

> A desktop AI agent built on long-term memory — an experiment in what an AI companion can actually do for someone's life when it stays present long enough.

## About

LingShu (灵枢) is a personal research project built around one question: **what does an agent become when it actually remembers you?**

- **Long-term memory as the foundation** — conversations, events and persona state keep accumulating: memory chunking, recall, persona blocks, memory echo. The dialogue never starts from zero.
- **Persona evolution (core research direction)** — how does memory feed back into personality? Affect, self-state, baseline, seeds and witnesses interact over months of companionship, producing character change that is **observable and traceable** — not a fixed character card.
- **Long-horizon conversation quality** — designed around personal knowledge and context measured in months and years, not single sessions.
- **Participating in real life** — voice dialogue, proactive care, appointment reminders, MCP tools and skills; an agent that lives in your daily routine, not just a Q&A box.

## Current capabilities

- 155 HTTP endpoints + 4 WebSocket endpoints, no placeholders; `npm run typecheck` and `npm run build` pass.
- Memory: full recall pipeline (digest / AKIN / semantic recall), proactive dynamics, baseline / self-state / affect, seed & witness; local SQLite + vector search.
- Voice: TTS (multiple providers with emotion tags) + streaming ASR + voiceprint.
- MCP: server CRUD, Claude Desktop format import, stdio / SSE / streamableHttp transports, tool discovery & invocation, approval flow.
- Skills: `SKILL.md` scanning, session-level binding, system-prompt injection, skill meta-tools.
- Desktop packaging via Tauri; local backend speaks HTTP on `127.0.0.1` only.

## Project layout

```
lingshu-harness/
├── backend-node/          # Node.js/TypeScript backend (Fastify)
│   ├── src/
│   │   ├── index.ts       # entry: health check + route registration
│   │   ├── config.ts      # env config
│   │   ├── routes/        # routes + generated fallbacks
│   │   ├── services/      # memory / voice / MCP / skills / scheduling
│   │   └── tools/         # native & MCP tool registration
│   └── package.json
├── lingshu-gui/           # Vue 3 + Tauri 2 desktop GUI
├── docs/                  # public documentation
├── local-docs/            # local dev notes (gitignored, not in repo)
├── LICENSE                # AGPL-3.0 full text
├── CLA.md                 # Contributor License Agreement
└── README.md
```

## Quick start

```bash
./dev.sh             # backend + Tauri desktop window (default)
./dev.sh --web       # backend + Vite dev server (ports auto-probed)
./dev.sh --help      # all flags
```

The script checks the Node version, installs dependencies if missing, waits for the backend `/health`, then starts the frontend; Ctrl-C tears down both. Logs go to `.dev-logs/`.

Default ports: 8600 (backend) / 1420 (frontend). If occupied, the script auto-increments to the next free port and syncs the new port to the frontend. Pin them with `--port 8601` / `--gui-port 1421`.

Run the backend alone:

```bash
cd backend-node
npm install
npm run dev          # port 8600 by default
```

Environment variables: `PORT`, `HOST`, `LOG_LEVEL`, `DB_PATH`, and more — see `backend-node/src/config.ts`.

## License

This project is open-sourced under the **[GNU AGPL-3.0](./LICENSE)**. Copyright © 2026 the LingShu authors.

In short (not legal advice; the license text prevails):

- **Commercial use is allowed.** Anyone may use, modify and redistribute, including commercially, provided applicable laws are followed.
- **Copyleft.** Distributing modified versions (including packaged builds) requires releasing the complete corresponding source under AGPL-3.0; offering this project's backend as a network service requires offering its source to the users of that service (AGPL §13).
- **Notices must be preserved** on redistribution.
- The authors may additionally offer commercial licensing (dual licensing) — contact the authors if needed.

### Trademark

The names "灵枢 / LingShu", the logo and brand assets are **not licensed** with the code. Derivative projects must rename and rebrand, and must not imply official affiliation.

### Project nature

LingShu Harness is an **experimental personal research project** (research focus: long-term memory and agent persona evolution), released for learning and study. It is not a finished product.

- **Local-first.** The agent runs entirely on the user's own machine; model access is configured by the user with their own API keys. The authors operate no servers and provide no hosted AI service.
- All agent output is **AI-generated**; judge it accordingly. It is not medical, psychological, or legal advice, and must not be used as a substitute for any of them.
- Anthropomorphic interaction — persona, emotional expression, proactive messages, long-term memory — is part of the research itself. Please use it with judgment.
- Anyone who deploys this software **as a public-facing service** thereby becomes the operator of that service and is solely responsible for complying with all laws and regulations applicable in their jurisdiction (including AI-service registration or labeling requirements where they exist).

### Mijia (MIoT) integration notice

The Xiaomi Mijia (MIoT) integration uses **unofficial APIs**. This project is not affiliated with, endorsed by, or connected to Xiaomi in any way. The integration may violate Xiaomi's terms of service; any account restrictions or consequences are borne by the user.

### Third-party components

Third-party dependencies keep their own licenses (mostly MIT / Apache-2.0). Notable items:

- **Twemoji** (emoji graphics bundled in `lingshu-gui`): CC-BY 4.0 — *Twemoji by Twitter, licensed under CC-BY 4.0*.
- **Silero VAD** (`silero_vad.onnx`): MIT.
- **sherpa-onnx streaming paraformer ASR model**: Apache-2.0 family (verify against the model's accompanying terms before release).
- **Mijia (MIoT) integration** (`backend-node/src/services/mijiaService.ts`): ported to TypeScript from [Do1e/mijia-api](https://github.com/Do1e/mijia-api) (GPL-3.0) with modifications; original copyright notices preserved per GPL-3.0. As combined here, that portion is distributed under this repository's AGPL-3.0 (GPLv3 §13 compatibility).

Run `npx license-checker --summary` before a release to audit the full dependency list.

## Contributing

Issues and pull requests are welcome. **Opening your first PR constitutes acceptance of [CLA.md](./CLA.md)**: copyright of contributions stays with their authors, but each contributor grants the maintainers a license that covers commercial and closed-source use beyond AGPL-3.0 — this is what keeps the project's future licensing options open while staying open source.

Once the repository is public, enable [CLA-assistant](https://github.com/cla-assistant/cla-assistant) to automate signing: install the GitHub App → restrict it to this repository → set `CLA.md` as the agreement file and a dedicated branch for signature records; unsigned PRs get blocked automatically.
