# PROJECT SPEC COMPLETE

The loop has finished every piece of work SPEC.md authorizes. This is the
terminal state, not a blocker: DECISIONS.md locks "when every SPEC.md feature is
built and gated, PROJECT SPEC COMPLETE is the desired terminal state — declare
it, do not find more work."

All nine SPEC.md v1 features are built and every ROADMAP.md row reads SHIPPED
across phases **A–J**: the two proofs (A), tenancy core (B), workflows as tenant
data (C), gateway (D), job runner (E), metering and entitlements (F), ops
surface (G), tenant dashboard (H), operator console (I), demo mode and
deploy-grade packaging (J).

`bash verify.sh` is green on this commit — all four gates, 40 test files,
570 passed, 2 skipped (the pre-registered PGlite-only claim-concurrency cases,
recorded in DECISIONS.md §Recorded during Phase A).

See ROADMAP.md for per-feature coverage and its reservations ledger for every
named seam. No TODO.md tasks were added; the loop has nothing authorized left.

## Decisions needed to go further

Each is human-gated by DECISIONS.md. Nothing below can be resolved by the loop.

1. **Publish the repo** — flip public, confirm the name, choose the license
   (DECISIONS.md records default intent: MIT), and decide the git identity
   (currently neutral by policy).
   *Unlocks:* the repo as a public deliverable; the CI badge SPEC.md's
   "Done means" calls for.

2. **The demo deployment** — host, tunnel mechanism, public URL, reset cadence.
   The repo ships the scripts and example units (`deploy/`, `pnpm seed:demo`,
   `pnpm reset:demo`); a human runs them.
   *Unlocks:* the live demo. Gate it on `scripts/live-check.sh` against a real
   gateway, which DECISIONS.md requires before any demo deployment and which CI
   deliberately does not run.

3. **Scope beyond SPEC.md v1** — the loop refuses to invent features. New work
   must be locked into DECISIONS.md first.
   *Candidates already recorded as deliberate seams, none of them spec-required:*
   enforcing `state = 'suspended'` (today a label), a support grant that gates
   rather than records, workflow editing on a page, widening the JSON Schema and
   YAML subsets, and tuning `DEFAULT_ENTITLEMENTS` against a real-model corpus.

## Two verifications only a human can close

Neither is unbuilt work; both need hardware the build box does not have.

- **The Postgres half of Phase A's proof** has never executed here — no Postgres
  server, no docker permission. The authoritative `suite on Postgres 16` CI job
  is the only place it runs; treat its first green run as the completion of
  Phase A's pre-registered proof.
- **`scripts/live-check.sh`** proves the gateway contract against a real gateway
  and model. CI runs the in-process stub instead, by design.
