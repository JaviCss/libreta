# libreta

Persistent memory for coding agents: observations, sessions, a daily log (bitácora) and per-agent token metrics, stored in a local SQLite database and exposed as an MCP server. Works with Claude Code today; other MCP clients should work but are untested.

## Install

```bash
npm install
npm run build
```

Register the server with your MCP client. For Claude Code:

```bash
claude mcp add libreta -- node /path/to/libreta/dist/src/mcp/server.js
```

Data lives in `~/.libreta/`.

## What it does

**Observations** — the unit of memory: a single fact (a decision, a gotcha, a learning, a pattern) with its why/where/learned. Deterministic dedup by content hash, full-text search (FTS5, bm25-ranked), timeline queries around any entry.

**Sessions** — open/close work sessions and attach observations to them.

**Bitácora** — a day-level executive index (one headline + summary per day) distinct from observations: it orients "where were we" at session start. Write-toggle in `~/.libreta/bitacora.json`; reads always work.

**Token metrics** — per-agent token telemetry ingested from real transcripts, grouped by agent, model, task type or session. The main thread's spend is published as an explicit unattributed remainder, never spread across groups. Cache reads are kept apart from work.

**Operations** — `lib_doctor` health check, idempotent JSON export/import (paths sandboxed to `~/.libreta` or the project directory), aggregate stats.

## Tools

24 MCP tools, prefixed `lib_`:

`lib_save`, `lib_get`, `lib_update`, `lib_delete`, `lib_search`, `lib_context`, `lib_timeline`, `lib_review`, `lib_criteria`, `lib_session_start`, `lib_session_end`, `lib_session_summary`, `lib_bitacora_add`, `lib_bitacora_day`, `lib_bitacora_range`, `lib_tokens_report`, `lib_tokens_series`, `lib_stats`, `lib_doctor`, `lib_export`, `lib_import`.

## Development

```bash
npm run typecheck
npm test
```

SQLite schema is migrated automatically (versioned, dense migrations). Tests use `node:test` via `tsx`.

## License

MIT © Javier Cossio
