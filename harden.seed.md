# SEED: harden

> seed-format: 1

> **You're an AI agent reading this seed.** You are the **HARDENING CONDUCTOR**. Your job: take a TARGET seed and run the hardening-off loop until a *fresh, blind* agent can one-shot it from absolute zero. Run `## Step 0 Interview`, then execute the `## Loop` until DONE. You do NOT fix the target yourself and you do NOT test it yourself — you orchestrate two **separate, single-purpose** agents (a blind TESTER and a builder FIXER) and enforce a full clean slate between every iteration. On success print `HARDEN_RESULT=DONE`; if you exhaust the iteration budget print `HARDEN_RESULT=STALLED` with the last gap.

## Goal

"Harden off" a seed — drive it from *works-when-I-do-it* to *a fresh blind agent one-shots it every time* — by repeatedly: blind-hydrate → agent-driven verify → on fail, capture the exact gap, have a different agent fix the root cause, wipe ALL state, repeat. The output is a TARGET seed that reliably one-shots, plus the captured gaps/fixes as a record.

## Why this exists (the lesson — do not skip)

**Reused state masks gaps and produces false passes. It bit us twice on `seedbed.seed.md`:**
1. A **shared** Claude auth volume (`seedlab-claude-auth`) was already onboarded, so it hid a real bug: a fresh per-node volume hits Claude's first-run theme/onboarding dialog and blocks the spawned agent. Invisible until someone ran truly fresh.
2. After switching to per-node volumes, an iteration **kept** the node's auth volume "to avoid re-auth." That reused, already-onboarded volume produced a **FALSE PASS** — the run looked green but never exercised the fresh-login path, so the fix was unverified.

**Therefore: every iteration starts from ABSOLUTE ZERO.** No cached auth volume, no leftover container, no warm queue registration. If a step is "expensive" (e.g. a one-time human login), that cost is the *point* — paying it each iteration is what proves the seed handles it. A green run on reused state proves nothing.

## Inputs

| name | required | default | detect | ask |
|---|---|---|---|---|
| `TARGET_SEED` | yes | — | path exists | "Absolute path to the seed being hardened (e.g. `~/workspace/seedlab/seeds/seedbed/seedbed.seed.md`)" |
| `MAX_ITERS` | no | `6` | — | "Max loop iterations before declaring STALLED" |
| `STATE_TO_WIPE` | yes | — | derived from the target | "The COMPLETE list of state a run creates that must be destroyed between iterations: containers, Docker volumes (esp. auth), queue/registry entries, tmpfiles. For `seedbed.seed.md`: the node container `<NODE_NAME>`, any `<NODE_NAME>-auth` helper, the per-node volume `claude-auth-<NODE_NAME>`, and the node's queue client/agent registrations." |
| `HARDEN_LOG` | no | `~/workspace/seedlab/harden-<target>-log.md` | — | "Where to append each iteration's gap + fix" |

## Roles (STRICT separation — never blur them)

- **CONDUCTOR (you):** orchestrate, enforce clean slate, record iterations, decide DONE/STALLED. Never fix the target; never grade your own run.
- **TESTER:** a brand-new, **clean-context, BLIND** agent. It is given ONLY the target seed path and told to hydrate + run the target's own agent-driven Verify. **No hints, no prior-iteration knowledge, no pointers to the bug.** If the tester needs a hint to succeed, the seed isn't hardened — that's a gap, not a pass.
- **FIXER:** a separate builder agent. It sees the captured gap and fixes the TARGET seed at **root cause**. It **never** runs the test. (Use the standing seed-builder for the target if one exists.)

A single agent must never both fix and test — that's how false passes happen.

## Loop

Repeat up to `MAX_ITERS`:

### A. FULL CLEAN SLATE (before every iteration — including the first)

Destroy **all** `STATE_TO_WIPE`. Nothing carries over. For a `seedbed.seed.md` target:
```bash
NODE="${NODE_NAME:-harden-probe-1}"          # use a dedicated name so it's unambiguous to wipe
docker rm -f "$NODE" "${NODE}-auth" 2>/dev/null || true
docker volume rm "claude-auth-${NODE}" 2>/dev/null || true   # <-- the auth volume MUST go (no reuse)
# clear the node's queue registration so it can't show a stale 'pass':
# (state-preserving central restart that replays ONLY the real long-lived agents,
#  OR just confirm the dead node ages out — never let a prior node's client/agent linger)
```
Verify the slate is clean before proceeding: no target container, **no auth volume**, no stale queue client/agent for the node. If any remains, stop and fix the teardown — a dirty slate invalidates the iteration.

### B. BLIND HYDRATE (fresh tester agent)

Spawn a NEW clean-context agent. Give it **only**: the `TARGET_SEED` path, the `NODE_NAME` to use, and "hydrate this seed and then run its `## Verify` exactly; report the verdict with evidence." Nothing else. It must surface any human step the target itself defines (e.g. a one-time device login) — that's allowed; it's the target's own declared human touch, not a hint.

### C. AGENT-DRIVEN VERIFY (same tester, target's own Verify)

The tester runs the target's `## Verify` — **agent reasoning over the live node, never a pass/fail `.sh`**. It judges real evidence (e.g. a live in-container reply, an HTTP 200 attach, a queue registration) and concludes PASS or FAIL.

### D. BRANCH

- **PASS** (every Verify check holds, no help beyond the target's own one-time human steps) → the seed one-shot it. Record success → `HARDEN_RESULT=DONE`. Stop.
- **FAIL** → capture the **EXACT gap**: the precise `BLOCKED_REASON` / failing check, the command + output that showed it, and the root cause if known. Append to `HARDEN_LOG`. Go to E.

### E. FIX (separate fixer agent, root cause only)

Hand the captured gap to the FIXER. It edits the TARGET seed to fix the **root cause** (not a workaround that only papers over this instance), confirms it found the real mechanism, and reports the exact change. It does **not** test. Then loop back to **A** (full clean slate) for a fresh blind re-test.

## Done

- A fresh, blind tester agent hydrated the TARGET from absolute zero (clean slate, no reused state) and **all** of the target's own Verify checks passed, with **no human help beyond the target's own declared one-time steps**.
- Independently re-confirmable: wipe everything and have *another* fresh blind agent run it again — it should pass again.

## Verify (of the hardening run itself — agent-driven)

Reason, don't trust a script:
1. Confirm the passing iteration started from a **provably clean slate** (you saw the auth volume + container absent before it ran). A pass on reused state is void — re-run clean.
2. Confirm the TESTER was genuinely blind (given only the seed path, no gap hints) and was a different agent/context than any FIXER.
3. Confirm the tester's PASS rests on real evidence (live reply, HTTP 200, queue registration), not a self-reported "looks done."
4. Confirm `HARDEN_LOG` records each gap→fix so the hardening is auditable.
If all hold: `HARDEN_RESULT=DONE` with the target seed path and the iteration count. Else keep looping or `HARDEN_RESULT=STALLED` with the open gap.

## Notes

- **The clean slate is the whole point.** The single most common failure of this loop is a tester succeeding on warm state. When in doubt, wipe more.
- **Blindness is load-bearing.** The moment a tester is told "watch out for X," it stops being a real first-run and X stays unhardened for the next person.
- **Root cause, not workaround.** A fix that only handles the one observed symptom will re-fail on the next fresh run. Make the fixer confirm the actual mechanism (as with `hasCompletedOnboarding` — the real onboarding gate, found by diffing a working config, not a guessed flag).
- Keep iterations cheap to reason about: one gap, one fix, one re-test per loop.
