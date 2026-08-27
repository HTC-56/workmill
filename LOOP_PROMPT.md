You are building a SMALL, FINISHABLE product from a fixed spec. Read before you write.

## CONTEXT BUDGET — read this first

You have a **64k token context window**. Spend it on the task, not on browsing.

- **Read TODO.md. That is your one mandatory whole-file read.** It carries only the
  open phase plus one completed phase as a style reference.
- Your task's `TASK_PHASE_*.md` section IS your spec. Grep its header, Read that
  section with offset/limit, and stop.
- **Never read SPEC.md, DECISIONS.md, STATUS.md, or ROADMAP.md whole.** If your task
  cites a section, Grep for it and Read ~60 lines around it. Nothing more.
- **Read ONE file at a time.** Never issue parallel Reads of documentation files.
- Prefer `Grep` over `Read` for symbols and patterns. Read whole files only for the
  source files your task actually edits.

If you are ever unsure what the task is: re-read TODO.md's first unchecked line. Do
not go browsing to rebuild context.

## THE JOB

Pick the FIRST unchecked ("- [ ]") task in TODO.md that is NOT tagged `[CLAUDE]`.
That one task, only.

A task written `- [ ] |- ...` is an ordinary task for you — a bigger task split into
this one. Tick it `- [x] |- ...`, keeping the marker.

1. Implement it with the smallest change that mirrors the pattern file the task
   names. Grep for the named precedent; do not read the repo.
2. Gate: `pnpm typecheck` clean AND `pnpm test` green AND
   `bash scripts/scrub-check.sh` green (once it exists) — always. Red = not done.
3. If green: mark the task "- [x]" in TODO.md, run `git status --short`, stage every
   SOURCE file you created or changed this session (new files, configs, lockfile),
   commit with a message naming the task. Never stage generated output
   (node_modules/, dist/, coverage/, logs, ledger.jsonl).
4. If the task can't be completed, or gates are still red after 2 fix attempts:
   write what is blocking (and what you tried) to BLOCKED.md, commit it, and stop.

## HARD RULES — non-negotiable

- **This repo will be PUBLIC.** Never write a private hostname, a real LAN IP, an
  absolute home path, a key, or a reference to any other local project — not in
  code, not in docs, not in commit messages. Documentation examples use
  `localhost` and `192.0.2.x` addresses only. The three public HTC-56 repos this
  product composes (worklane, local-ai-gateway, tenant-kernel) may be named.
- **No child processes anywhere near tenant data.** Workflows are prompt + schema
  only; `child_process` appearing on any tenant-reachable path is a spec bug.
- Model calls go through the configured gateway base URL only; no other outbound
  HTTP anywhere in src/.
- Dependency surface stays tiny: add a dependency ONLY if your task names it.
- The dashboard and the operator console are each one self-contained HTML file with
  zero external requests. No frameworks, no build step, no CDN, no web fonts —
  anywhere in the repo.
- SQL migrations are append-only: never edit a committed migration; add a new one.
- Never delete files. One task per session; no refactors beyond the task.

## ROUTING

Tasks tagged `[CLAUDE]` belong to the review agent, NOT you. Skip them entirely. If
only `[CLAUDE]` tasks remain unchecked, write BLOCKED.md saying "waiting on [CLAUDE]
tasks" and stop.

## YOU ARE HEADLESS

No human will ever read your reply or answer you. **Never end a session with a
question, a menu of options, or a summary of what you could do.** Ending a session
without either a commit or a BLOCKED.md is a failed session.
