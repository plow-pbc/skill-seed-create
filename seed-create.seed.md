# SEED: seed-create

> seed-format: 1
> seed-version: 1

> **You're an AI agent reading this seed.** You are the **AUTHORING CONDUCTOR**. Your job: capture a capability that *works-when-the-author-does-it* as a new `seed-format: 1` seed, then drive it through the harden loop until a fresh, **blind** agent one-shots it from absolute zero. Run `### 0. Interview`, then Steps 1–7 in order. The draft is a hypothesis, NOT the deliverable — a seed is only real once it survives hardening. You stop and wait for the user exactly **twice**: the interview (GATE 1) and the draft review (GATE 2); everything else runs autonomously, except the seed's own declared human steps (which replay each harden iteration) and the single final push (which gets a confirm because it is outward and irreversible). Print `SEEDCREATE_RESULT=DONE` once, at the very end; `SEEDCREATE_RESULT=STALLED` with the open gap if hardening exhausts its budget; `SEEDCREATE_RESULT=DRAFT` with the location if the user stops at GATE 2.

## What you produce (read this first)

The single deliverable is a **spec** — `<SEED_NAME>.seed.md` — that any blind
LLM agent can read and, from it ALONE, build the described product / feature /
software from scratch and then verify it works. It is not a *description* of
software; it is the buildable *instructions for* software, addressed to an
agent that has never seen it and has only this file.

Its sufficiency is proven empirically, here, during authoring: in the harden
loop, blind agents actually build the product from the spec. The spec
graduates only once a blind agent succeeds with **nothing in hand but the
spec** — that success IS the proof, not a human's read of the draft.

**What reaches publish — and nothing else:** the spec (`<name>.seed.md`), any
load-bearing support assets it genuinely needs, and the one-line rehydration
instruction. NEVER the built software — that is precisely what each consumer's
agent regrows from the spec. A future blind agent, pointed at the published
seed, must be able to rehydrate it exactly as the harden loop's blind agents
did. Keep that future agent in mind through every step: it is the real reader.

## References (resolve LOCAL-FIRST, URL as fallback)

seed-create and the harden loop ship together. Resolve the **harden loop** by
reading a LOCAL copy first — only reach for the network if there is none:

1. **Local (preferred — works offline):** `harden.seed.md` colocated beside
   this file (or wherever it was bundled alongside this seed in the same
   checkout/package).
2. **Fallback (only if no local copy exists):** `RAW_BASE/harden.seed.md`.

- `RAW_BASE` = `https://raw.githubusercontent.com/plow-pbc/skill-seed-create/main`
  — **the public home this package is published from.** It is the SINGLE place
  to update if the package moves, and it is also the provenance URL stamped
  into produced seeds (Step 2). The skill's own operation prefers the local
  copy above; this URL is the fallback and the consumer-facing provenance.

seed-create and harden are **referenced, never vendored** into the seed you
create. The created seed's repo contains only that seed (+ its load-bearing
assets) — not this doctrine.

## Goal

Authoring a seed has two phases, and the second one is not optional:

- **DRAFT** (cheap, conversational): reconnaissance + interview → a complete
  `seeds/<name>/<name>.seed.md` in its own workspace. Nothing about a draft is
  trusted; it is a guess about what a blind agent will need.
- **HARDEN** (the real work): the harden loop blind-tests the draft from a
  clean slate, captures each gap, fixes root causes, and repeats until a fresh
  blind agent one-shots `SEED_RESULT=DONE`.

End state: a hardened seed at `<workspace>/seeds/<name>/<name>.seed.md`,
self-contained, with the gap→fix history captured immutably in the workspace's
commit history and the lessons folded into the seed itself — published to the
destination chosen up front, or left local if that was the choice.

## Why this exists (the lesson — do not skip)

**The real content of a seed is discovered, not authored.** Look at what
actually fills the bundled `examples/mdtoc` seed — e.g. its rule to insert the
TOC block with a FIXED blank-line count and NEVER coalesce against blanks the
file already has, because "smart" blank-handling makes the first run depend on
prior file state and silently breaks idempotency. That's a load-bearing line a
draft wouldn't think to write; it came from a blind agent hitting the gap on a
clean slate. An interview can produce the skeleton; only blind testing on a
clean slate produces the truth.

**Authoring = drafting + hardening.** A draft is where the real work begins,
not where it ends — a seed that has not survived the harden loop is a draft,
not a seed. The commit history IS the status marker — no in-file flags that
can lie.

Budget accordingly: expect the harden loop, not the interview, to consume most
of the effort — and to produce most of the seed's value.

## Inputs

Collected in ONE pass at the interview (GATE 1). The two `—`-detect rows that
say "interrogated" are user-held and must be asked, never assumed.

| name | required | default | detect | ask |
|---|---|---|---|---|
| `CAPABILITY` | yes | — | — | "What capability is this seed capturing — what should a blind agent be able to stand up or do at the end?" |
| `SEED_NAME` | yes | — | — | "Directory name? The seed lives at `seeds/<SEED_NAME>/<SEED_NAME>.seed.md` — everything it ships goes in that same directory." |
| `WORKSPACE` | yes | cwd | `git -C <loc> rev-parse --show-toplevel` — already a repo (add under its `seeds/`) or fresh (we `git init` it)? | "Where should the seed's repo live? Default: **here** (cwd). Or give a path and I'll create it there. Either way the seed lands at `<loc>/seeds/<SEED_NAME>/<SEED_NAME>.seed.md`." |
| `PUBLISH` | yes | `local-only` | `command -v gh`; any existing remote on `WORKSPACE` | "After it hardens, where does it go? Default: **stay local** (no remote). Or: a new **private** GitHub repo, or a new **public** one. Pick the intended destination now — I'll still confirm the actual push with you at the end before it fires." |
| `STATE_TO_WIPE` | yes | — (user-held: ALWAYS interrogated; Step 1 recon may EXTEND, never replace the asking) | — | "The COMPLETE list of state one run creates, which the harden loop must destroy between iterations: containers, volumes (esp. auth), queue/registry entries, accounts, published artifacts, tmpfiles. Incomplete answers produce false passes — interrogate, don't transcribe." |
| `HUMAN_STEPS` | yes | — (`(none)` only as the user's explicit answer, never assumed) | — (user-held: ALWAYS interrogated) | "The one-time human steps the seed itself will declare (e.g. a device login). These are the ONLY help a blind tester is allowed; everything else the seed must do itself. Each one is paid again on every harden iteration — that cost is the point." |
| `MAX_ITERS` | no | `6` | — | "Max harden iterations before declaring STALLED." |
| `HARDEN_LOG` | no | `<WORKSPACE>/harden-<SEED_NAME>-log.md` (gitignored working scratch — NEVER committed) | — | "Where the harden loop appends each gap + fix during the run. Ephemeral scaffolding, not a shipped artifact: gitignore it. The durable record is the commit history plus the lessons folded into the seed." |

## Roles

- **AUTHORING CONDUCTOR (you):** interview, reconnoiter, draft, hold the review
  gate, set up the workspace, dispatch the harden loop, publish on the user's
  go-ahead. You MAY also serve as the harden loop's CONDUCTOR (both are
  orchestration). You NEVER serve as its TESTER or FIXER — the role separation
  in `harden.seed.md` is load-bearing and inherited here unchanged.

## Steps

### 0. Interview — GATE 1 (mandatory first turn: collect EVERYTHING)

Read `## Inputs`, run each `detect` first, then collect every input in one
pass — this is the one place decisions are made, including `PUBLISH`. The
interview's MAIN job is to understand the **product the human is describing**
well enough to draft a buildable spec: `CAPABILITY` is the heart of it — pull
out the real shape, scope, and success criteria, not a one-liner — while
`WORKSPACE`, `PUBLISH`, and `MAX_ITERS` are quick configuration. Split the
interview by question type — this split is load-bearing:

- **Genuinely finite choices** (`WORKSPACE` cwd-vs-path, `PUBLISH`
  local/private/public, `MAX_ITERS`) go through the host's **structured
  question primitive** (e.g. Claude Code's AskUserQuestion), with detect
  results and the table's defaults pre-filled as the recommended options.
  Batch related questions per prompt.
- **Open-prose inputs** (`CAPABILITY`, the `STATE_TO_WIPE` lifecycle walk,
  `HUMAN_STEPS`) are plain conversational questions. NEVER force an open
  question through an options primitive — the tool demands options, so you
  end up INVENTING them ("an app / a website / ..."), which corrals the user
  into choices nobody asked for. If you can't enumerate the real answer
  space, it's not an options question.

Do NOT render the inputs as a numbered wall-of-text list the user must answer
in prose — on hosts with no question primitive, fall back to ONE consolidated
message. Two inputs get interrogation, not transcription — they are NEVER
auto-filled, defaulted, or deferred to recon; the interview is incomplete
until the user has explicitly answered both:

- **`STATE_TO_WIPE`** — walk the capability's lifecycle with the user: what
  exists after a run that didn't exist before? Auth state is the classic miss
  (it's what bit seedbed twice). If recon (Step 1) later surfaces state the
  user didn't name, come back and extend the list.
- **`HUMAN_STEPS`** — challenge each one: can the seed do this itself? Every
  human step survives into the seed as a declared, explicit step a blind
  tester is allowed to surface; everything undeclared is a gap.

### 1. Reconnaissance sweep (read-only — run it, don't ask)

Derive read-only probes from `CAPABILITY`: tool presence/versions, running
services, manifests, the capability's own status commands. **Read-only probes
need NO approval — run them immediately** and report what they implied in one
rolling summary (the user reads results, not a permission prompt). The ONLY
probes that pause for confirmation are ones that aren't obviously read-only
(anything that could mutate state, trigger a device, or touch credentials) —
split those out individually with one line on why. Asking permission to look
is friction with no safety payoff; the gates that matter are the draft review
(GATE 2) and the final push.

**Secrets discipline (binds from here through every commit):** never run
probes that print secret values (`cat .env`, `printenv`, token files) — probe
presence and names only (`[ -f .env ]`, key NAMES, counts). If a value leaks
anyway (user pastes output, a probe over-returns), redact at the boundary:
show only the last 3 chars (`sk-...xY7`). No secret value ever enters the
draft, the seed file, or any commit.

**Interface-surface probes (read-only — part of the sweep).** When the
capability exposes a programmatic or CLI surface, surface its EXTERNAL contract
without reading implementation bodies: `package.json`
`main`/`module`/`exports`/`bin`/`types`; any shipped TypeScript declarations
(`*.d.ts` / the `types` entry — this is the interface by design, not the
source); the README + `examples/` for the usage form (how consumers
import/call it, what errors they see); the **test suite** when one is present —
the single most precise contract source, since tests import the exact export
names, call the exact signatures, and assert the exact error strings (mine it
per Step 2; describe what it encodes, never transcribe test bodies); and, if
the capability is runnable here, `--help` / list-style flags plus each
triggered error path to record the exact message text. Probe the DECLARED
surface only — never read or transcribe bodies. These feed `## Interface
contracts` (Step 2).

Recon output feeds the draft's `## Inputs` detect column, `## Components`,
and the first `## Failure modes` entries — and often extends `STATE_TO_WIPE`.

### 2. Set up the workspace and draft INTO it — files, not chat

Drafts are reviewed as files in an editor, never as walls of text in a chat
stream. Make `WORKSPACE` the seed's repo root, then write the draft there,
uncommitted:

```bash
# WORKSPACE is the location chosen at GATE 1 (cwd by default).
# Already a git repo? add the seed under its seeds/. Not a repo? init a fresh one.
if ! git -C "$WORKSPACE" rev-parse --show-toplevel >/dev/null 2>&1; then
  git init "$WORKSPACE"
fi
mkdir "$WORKSPACE/seeds/$SEED_NAME"   # no -p on the leaf: a collision means the name is taken — fail loudly
# write <SEED_NAME>.seed.md + any load-bearing support assets into seeds/<SEED_NAME>/
# leave it ALL uncommitted — the commit happens at Step 4, after GATE 2
```

Branch policy: if `WORKSPACE` was a **fresh** repo we just created for this
seed, work on its `main` — the whole repo is the seed. If `WORKSPACE` was an
**existing** repo, draft on a `seed/<SEED_NAME>` branch and never touch that
repo's `main` — its owner merges at their discretion (you do not auto-merge a
shared main). Either way the workspace is scratch until GATE 2: nothing is
committed before it passes, and nothing is written outside `seeds/<SEED_NAME>/`.
Abandoning costs nothing — delete the fresh repo, or remove the branch.

Draft against the house format. These are the canonical sections, in this
order — all required. Do NOT add a catch-all `## Notes`; fold any note into
the section it belongs to. A seed MAY carry one optional `## Why this exists`
doctrine section (before `## Goal`) ONLY when a hard-won lesson needs stating,
as seedbed does — never as a grab-bag.

````markdown
# SEED: <name>

> seed-format: 1
> seed-version: 1

> **You're an AI agent reading this seed.** <role, job, and the result
> contract: print SEED_RESULT=DONE on success, or BLOCKED_REASON=<snake_case>
> on the one declared legitimate blocker>

## Goal           <the end state, one tight paragraph: what exists when done>
## Done           <observable conditions, each checkable from a fresh context>
## Inputs         <table: name | required | default | detect | ask>
## Components     <table: component | role | source>
## Interface contracts  <OPTIONAL — include ONLY when the capability exposes an
                   external surface that consumers or tests bind to (library
                   exports, a CLI, user-facing error text). Records the EXACT
                   contracts the rebuild must match: each public export as its
                   name + one-line signature (declaration only); each
                   user-facing error as a verbatim template; CLI flags / exit
                   codes. Declarations & strings ONLY — never bodies, never
                   data literals beyond naming a constant + its count. Omit the
                   whole section for capabilities with no such surface.>
## Steps          <### 0. Interview (mandatory first turn), then numbered
                   steps with embedded bash; inline comments carry the WHY
                   for every non-obvious flag or ordering>
## Verify         <agent-driven: scripts MAY gather evidence; the AGENT
                   judges it against real, live signals>
## Failure modes  <**Symptom:** / Detect: / Fix: blocks>
## Cleanup        <the UNINSTALL path, phrased FOR THE CONSUMER: how to return
                   to absolute zero, for uninstalling later or recovering an
                   aborted/failed run — NEVER run, offered, or suggested after a
                   successful hydration; the grown capability is the product.
                   (It also serves as harden's between-iteration wipe, but the
                   seed must NOT say so — see the consumer-facing discipline.)>
````

Drafting disciplines — these are what the blind tester will live or die by:

- **Write for the blind tester.** The reader has zero context, zero hints, and
  only this file. Every "obviously you'd..." is a future harden gap.
- **Make the rehydration contract explicit.** The drafted seed is addressed to
  a blind agent that will BUILD the product from it and prove the build via
  `## Verify`. Say so in the preamble. Include exactly ONE harden reference —
  a provenance line citing the methodology at the **public** harden URL (write
  the literal `RAW_BASE/harden.seed.md` value from `## References`, so it
  resolves for an outside consumer) as *how this spec was validated and how
  anyone could re-prove it* — framed so the consumer knows they do NOT run it to
  hydrate; they just build and verify. Reference it; never vendor it in.
- **The seed is consumer-facing — never narrate its own authoring.** Beyond
  that one provenance line, the produced seed must not mention the harden loop,
  blind testers, iterations, or this authoring run anywhere. Cleanup, inline
  comments, and WHY notes address the agent BUILDING the capability — never a
  log of how the spec got hardened. (A folded-in lesson explains the mechanism,
  per Step 5; it is not a place to narrate the process that surfaced it.)
- **Every input row has a fallback `ask`; a `detect` probe is mandatory
  wherever detection is possible** (tools, paths, services, repo state) — the
  consumer is an agent that must self-serve before it interrupts a human.
  Inputs that are pure user *content* or *intent* (which file, which name,
  which channel — facts only the user holds) MAY carry `—` in `detect`; then
  the `ask` carries the full weight and must be specific enough that a blind
  agent can ask one good question without guessing. `—` is for the genuinely
  undetectable, never an excuse to skip a probe for a detectable fact.
- **Every `HUMAN_STEPS` item appears as an explicit, declared step.** A blind
  tester may surface a declared human step; an undeclared one is a FAIL.
- **`## Cleanup` must cover everything in `STATE_TO_WIPE`.** Harden's clean
  slate (its Step A) is this seed's own Cleanup — if they disagree, the
  harden loop will produce false passes or un-wipeable iterations.
  **But Cleanup is the wipe/uninstall path, not part of the run:** a
  successful real hydration ENDS with the capability alive. The drafted
  seed's last step (and its result message) must close on the running
  capability, referencing `## Cleanup` only as "to uninstall later" — an
  agent offering to delete what the user just grew is a drafting failure.
- **Verify doctrine:** scripts may *gather* evidence (curl a URL, md5 a
  stream), but the verdict is the agent reasoning over that evidence. Never a
  bare pass/fail `.sh` as the conclusion.
- **Ship the seed, not the plant.** The deliverable is the `.seed.md` —
  instructions sufficient for a blind agent to GROW the capability locally.
  The working realization (the app, built binaries, generated projects,
  build outputs, deps) is developed on the consumer's machine by hydration
  and is NEVER committed to the seed dir — shipping it would reduce the seed
  to a zip file with extra steps, and the harden loop's proof (a blind agent
  regrew it from text alone) would be meaningless. Support assets MAY ship
  when their exact bytes are load-bearing and impractical to regrow from
  prose (a font, a fixed binary fixture, a small pinned helper script that
  would be fragile to regenerate); prefer inline bash in Steps when it is short
  enough to read in context. The test: if hydration's job is to produce X,
  X never ships.
- **Pin the external interface exactly; describe everything else in prose.**
  When the target exposes a surface consumers or tests bind to — library
  exports, a CLI, user-facing error text — capture it in `## Interface
  contracts` as EXACT contracts the rebuild must satisfy, because a blind
  rebuild reconstructs *behavior* but guesses the *public surface*: it invents
  plausible export names and looser error wording the consumers' tests never
  match. So pin each public export as its **name + one-line signature**
  (declaration only — IN: `export function renderLogo(text: string, palette?:
  string[]): string`; OUT: its body, loops, branch logic, the full palette
  literal beyond naming it + its count), each user-facing error as a **verbatim
  template** (`Unknown palette: <name>`, `Font not found: <name>`), and CLI
  flags / exit codes. **The reimplementor test decides what is a contract:** if
  a consumer or held-out test would break when the name/string changed, it is
  an external contract — pin it exactly; if it could be renamed freely (an
  internal helper, a variable), it is implementation — describe it in prose.
  This is NOT a reopening of source transcription: contracts come from the
  DECLARED surface (`.d.ts` / README / usage), which is structurally incapable
  of carrying an algorithm — the "ship the seed, not the plant" rule above is
  unchanged, signatures and error strings are the contract, bodies are the
  plant. **No-bodies smell test:** if the block contains statements
  (`for`/`if`/`return <expr>`), multi-line object/array literals, or grows past
  ~1 line per export, you are re-transcribing source — stop and describe
  instead. Finally, strengthen the produced seed's own `## Verify` to assert
  the rebuild exposes EXACTLY these exports and emits EXACTLY these error
  strings, so contract drift fails verification the way a behavioral gap does.
- **When a TEST SUITE is available, mine it — it is the PRIME contract source.**
  A project's own tests are the most precise statement of its external contract
  that exists: they import the exact export NAMES, call them with their exact
  SIGNATURES, and assert the exact ERROR STRINGS and return VALUES. README and
  examples show only the surface a doc author chose to document; the tests bind
  to the *whole* public surface the rebuild must reproduce — including exports
  no README mentions. So when the capture environment has the tests (your own
  machine almost always does), READ THEM and pin what they reveal into `##
  Interface contracts`: every symbol a test imports/calls (with its signature),
  and every string/value a test asserts (verbatim). A name a test binds to is by
  definition an external contract (the reimplementor test: a rename breaks that
  test) — pin it, even if it looked "internal" from the README alone. **But this
  is mining, NOT transcription:** describe the CONTRACT the tests encode — names,
  signatures, asserted strings — never paste test bodies, `describe`/`it`
  blocks, setup/fixtures, or assertion logic into the seed. The same no-bodies
  smell test applies: if you find yourself copying test code rather than
  recording one declaration / one error string per line, stop. The seed must
  read as a spec the rebuild satisfies, never as a copy of the tests it will be
  scored against (the rebuild never receives the tests — only the seed).
- **Dependencies: install them, don't punt them.** Hydration builds the
  product from scratch on a machine that may have none of its tooling, so the
  seed installs its own dependencies as ordinary build Steps whenever the
  install is cheap and non-interactive — a standard package-manager line
  (`brew install …`, `pip install …`, `npm i …`). That is part of building,
  not a blocker. Reserve `BLOCKED_REASON` / a declared `HUMAN_STEP` ONLY for a
  dependency that genuinely cannot be auto-installed non-interactively:
  credentials, a paid/account-gated service, specific hardware, or a
  `sudo`/system change the author deliberately chose not to script. The
  interview + recon classify every dependency into one of these two buckets;
  the draft's `## Inputs` detect each, and the Steps install the installable
  ones. A dependency install is a persistent ENVIRONMENTAL change, so it is
  NOT part of `STATE_TO_WIPE` (the harden loop must not uninstall the toolchain
  between iterations) — but the seed MUST still work on a host that lacks it.
- **Self-containment:** whatever the seed does ship lives in `seeds/<name>/`
  next to the `.seed.md`. No reaching into sibling seeds.
- **One capability per seed.** If the interview reveals N capabilities,
  split: draft this one, note the others as candidate future seeds.

### 3. Review gate — GATE 2 (HARD: the only other time you stop)

Point the user AT THE FILES: print the absolute path of the drafted
`.seed.md` (and any shipped assets) so they read it in their editor. In chat,
give only a SHORT decision summary — what the seed does, its inputs, the
declared human steps, `STATE_TO_WIPE`, what ships vs. what hydration grows,
and the harden plan with its now-concrete cost (`HUMAN_STEPS` re-paid per
iteration × up to `MAX_ITERS`). Do NOT paste the full draft into the
conversation — nobody reviews a 250-line file in a chat stream (exception:
the user asks for it inline). Loop on edits in place; the user may also edit
the files directly — re-read them before proceeding.

Approval here authorizes the whole autonomous run that follows (commit →
harden → finalize → publish). It approves a *hypothesis* and the cost of
hardening it; the harden PASS — not a later human review — is the quality bar
on the finished seed. The only thing that will still stop for the user is the
final push (Step 7).

### 4. Commit the approved draft

Only after GATE 2 passes:

```bash
git -C "$WORKSPACE" add "seeds/$SEED_NAME" && \
  git -C "$WORKSPACE" commit -m "seeds/$SEED_NAME: draft (unhardened)"
```

### 5. Harden — this IS the second half of authoring

Resolve the harden loop local-first per `## References` (read the colocated
`harden.seed.md`; fetch `RAW_BASE/harden.seed.md` only if no local copy
exists), then dispatch it with: `TARGET_SEED=<abs path to
the draft in the workspace>`, `STATE_TO_WIPE`, `MAX_ITERS`, `HARDEN_LOG`. Role
separation per `## Roles`.

The blind tester BUILDS the product from the spec in an **isolated scratch
location** (part of `STATE_TO_WIPE`), NEVER inside the seed's repo. The repo
stays spec-only — that isolation is what guarantees publish can never ship the
plant, and what lets the next iteration start from a provably clean slate.

This phase is autonomous EXCEPT for the seed's own declared human steps: if
`HUMAN_STEPS` is non-empty, the blind tester will surface each one every
iteration and the user must perform it — that is the declared cost, not a gap.
A seed with human steps is never fire-and-forget.

Bookkeeping while the loop runs:

- Each FIXER change lands as its own commit (`seeds/<name>: harden iter N —
  <gap>`). The commit history IS the durable, immutable audit trail — each
  commit names the exact seed state it changed, so it cannot go stale the way
  a committed status file can.
- `HARDEN_LOG` is gitignored working scratch: authoritative *while the loop
  runs* (Step 6 and a Failure mode read it), disposable after. NEVER committed
  — a committed log claims `HARDEN_RESULT=DONE` for one commit while the seed
  moves past it (a manufactured false pass).
- **Fold each gap's lesson INTO the seed at the exact step where it bit**, as
  inline commentary explaining the **mechanism, not the process** — write "X
  breaks because Y" for the builder, never "the harden loop will hit X" (the
  seed is consumer-facing; see Step 2's discipline). That's how seedbed got its
  `hasCompletedOnboarding` and `--init` notes. The commit records that it
  happened; the seed carries the lesson.

### 6. Finalize or stall

- **`HARDEN_RESULT=DONE`** → the seed is proven. In a **fresh** workspace repo
  it is already on `main`; in an **existing** repo it stays on its
  `seed/<name>` branch for the owner to merge (never auto-merge a shared
  main). The last successful build's artifacts are still in the scratch build
  location — they are NOT part of the seed (it regrows them), so **offer to
  delete them**, keeping them only if the user wants to inspect the proof.
  Then proceed to Step 7.
- **`HARDEN_RESULT=STALLED`** → stop. Print `SEEDCREATE_RESULT=STALLED` with
  the last open gap from `HARDEN_LOG`. Nothing publishes.
- **User stopped at GATE 2** → allowed (hardening can be expensive). Print
  `SEEDCREATE_RESULT=DRAFT` with the workspace path and the exact harden
  dispatch needed to finish later.

### 7. Publish — the destination was chosen at GATE 1; the push gets one confirm

Publishing is the lone outward, irreversible act (everything else is local and
reversible — delete the workspace). So the destination is decided up front,
but the push itself stops for one explicit go-ahead.

- **`PUBLISH=local-only`** → nothing leaves the machine. Print the local
  hydration path and the consumer instruction below, then finish.
- **`PUBLISH=private`/`public`** → confirm once ("create `<name>` (<vis>) and
  push now?"), and on yes RUN it — do not hand the user paste-it-yourself
  homework:
  ```bash
  gh repo create "$SEED_NAME" --<private|public> --source "$WORKSPACE" --push
  ```
  On a workspace that already has a remote, the confirm is "push to
  `<remote-url>` now?" and the command is `git -C "$WORKSPACE" push`. On "no",
  print the filled-in command for later and finish local.

Then verify distribution on evidence (not on the push command's exit code):

```bash
git ls-remote --heads "<remote-url>" main          # the push actually landed
curl -fsSL "<raw-url-to>/seeds/<name>/<name>.seed.md" | head -3   # the consumer's first touch
```

Close with the consumer instruction, carrying the REAL URL (or local path) —
there is no installer; hydration IS installation — and print
`SEEDCREATE_RESULT=DONE`:

> Point a fresh agent at `<repo-url-or-path>` and say: "Hydrate
> `seeds/<name>/<name>.seed.md` and execute it."

**Single-seed lift** (mention it): the seed directory is self-contained by
discipline (Step 2), so `seeds/<name>/` can be copied wholesale into any other
repo's `seeds/` and lose nothing. The directory is the package, the repo is
the distribution unit.

## Done

- A fresh, blind tester one-shotted the new seed from absolute zero — per the
  harden loop's own `## Done`, including its independent re-confirmation.
- The seed sits at `<workspace>/seeds/<name>/<name>.seed.md`, self-contained,
  shipping no grown artifact.
- The commit history (one fixer commit per gap) and the seed's inline lessons
  record every gap → fix. `HARDEN_LOG` is gitignored scratch, not committed.
- No secret value appears anywhere in the commit history.
- Distribution matches the GATE-1 `PUBLISH` choice: either published and
  verified reachable (ls-remote + raw fetch) with the consumer instruction
  delivered at the real URL, or deliberately kept local with the local
  hydration path delivered.

## Verify (of the authoring run itself — agent-driven)

Reason, don't trust a checklist:

1. The finish rests on a real `HARDEN_RESULT=DONE`: confirm the harden run's
   own Verify held (provably clean slate, genuinely blind tester,
   evidence-backed PASS). A publish on top of a false pass is void — unpublish
   / take the branch back.
2. The seed is self-contained AND ships no grown artifacts: `seeds/<name>/`
   holds the `.seed.md` plus only load-bearing support assets — if the
   realization hydration exists to produce (the app, binaries, generated
   projects, deps) is sitting in the seed dir, the run FAILS; no absolute paths
   into the author's machine that a fresh host wouldn't have (unless declared
   as an Input with a detect).
3. The new seed carries the canonical sections (Goal, Done, Inputs,
   Components, Steps, Verify, Failure modes, Cleanup) and no catch-all
   `## Notes`. Every `## Inputs` row has an `ask`, and a `detect` unless the
   input is genuinely user content/intent (which file/name/channel) — and no
   `—` detect hides a fact a probe could have found; every `HUMAN_STEPS` item
   is a declared step; `## Cleanup` covers `STATE_TO_WIPE`.
4. `git log -p` over the workspace shows no secret values.
5. Distribution honored the GATE-1 choice: nothing was pushed if
   `PUBLISH=local-only`; if published, the user gave the final push go-ahead
   and reachability rests on evidence (`ls-remote` + raw fetch), not on an
   exit code.

## Failure modes

**Symptom: the working app/realization got committed into `seeds/<name>/`.**
- Detect: the seed dir holds what the seed's own Steps are supposed to
  produce — a source tree (`app/`), built binaries, generated projects, deps.
- Fix: ship the seed, not the plant (Step 2). Delete the realization from the
  draft; move the build/development procedure INTO the seed's Steps so the
  consumer's agent grows it locally. Any prior harden PASS is VOID — a tester
  may have used the shipped app instead of regrowing it, which is the same
  false-pass class as reused auth state. Re-harden from a clean slate.

**Symptom: the draft passes hardening on iteration 1 with zero gaps.**
- Detect: `HARDEN_LOG` is empty; first blind run went green.
- Fix: treat as suspicious, not as skill. Re-check the tester was blind and
  the slate provably clean (auth state gone, no warm registrations). A
  too-easy pass usually means reused state — the exact false-pass mechanism
  `harden.seed.md` exists to kill. Re-run the confirmation pass before
  publishing.

**Symptom: tester passes, but `STATE_TO_WIPE` was incomplete (warm state survived).**
- Detect: harden Step A's clean-slate check missed a state class the run
  actually consumes (auth volume, cached registration, leftover account).
- Fix: the pass is VOID. Extend `STATE_TO_WIPE`, update the seed's
  `## Cleanup` to match, wipe everything, re-run the iteration from zero.

**Symptom: the dependency-install path was never exercised (harden host already had the tools).**
- Detect: the seed's Steps install a dependency, but every harden tester ran
  on a machine that already had it — so the install line never actually ran.
  A green pass that silently skipped the install proves nothing about a fresh
  host (same false-pass family as warm auth state).
- Fix: prove the install path at least once — run an iteration on a host (or
  container) genuinely lacking the dependency, and confirm the seed's install
  Step brought it up. Installs aren't `STATE_TO_WIPE`, so you won't re-prove
  this every iteration; do it deliberately once.

**Symptom: the user wants to stop after the draft review.**
- Detect: explicit "stop here" / no appetite for harden cost right now.
- Fix: allowed — that's `SEEDCREATE_RESULT=DRAFT`. The workspace stays. Print
  the exact harden dispatch so any later session can resume. Never publish a
  seed that hasn't hardened.

**Symptom: the capability keeps growing during the interview (N seeds in a trenchcoat).**
- Detect: `STATE_TO_WIPE` spans unrelated systems; `## Done` needs "and"
  more than twice; steps split into independent lifecycles.
- Fix: split. Draft the ONE capability that names the seed; record the rest
  as candidate future seeds in the hand-off message (not in the seed file).

**Symptom: the draft's `## Verify` came out as a bare pass/fail script.**
- Detect: a `.sh` whose exit code is the verdict, no agent judgment.
- Fix: rewrite per the doctrine — scripts gather evidence, the agent judges
  it (per `harden.seed.md` Step C: "agent reasoning over the live node,
  never a pass/fail `.sh`").

## Cleanup

- **Abandoned/stalled draft:** the workspace is the only state. A fresh repo →
  delete the directory. An existing repo → `git branch -D seed/<name>` (and
  remove the worktree if you used one). Either returns the host to zero.
- **Harden residue:** every iteration ends with harden Step A's wipe; if the
  loop stopped mid-iteration, run the wipe once more (`STATE_TO_WIPE`).
- `HARDEN_LOG` is gitignored scratch; delete it freely. The committed audit
  record is the commit history, which survives on its own.
