# SEED: mdtoc

> seed-format: 1
> seed-version: 1

> **You're an AI agent reading this seed.** You have only this file. Your job:
> BUILD `mdtoc` — a command-line tool that injects or updates a Table of
> Contents in a Markdown file — from the spec below, on this host, using only
> the stock toolchain (a `python3` interpreter and the shell). Then PROVE it
> works by running `## Verify` and reasoning over the real output. Print
> `SEED_RESULT=DONE` once every Verify check holds. The one legitimate blocker
> is a missing interpreter: if `python3` is absent and cannot be installed,
> stop and print `BLOCKED_REASON=python3_missing`. There are no other declared
> human steps — everything else you do yourself.
>
> Provenance: this spec was validated by blind-rebuild hardening per
> `https://raw.githubusercontent.com/plow-pbc/skill-seed-create/main/harden.seed.md`
> — you do NOT run that to hydrate; you build `mdtoc` from these instructions
> and confirm it with `## Verify`. Anyone can re-prove sufficiency the same way.

## Goal

A single-file, dependency-free `mdtoc` command-line tool exists on this host and
is executable. Given a path to a Markdown file, it scans the file's ATX headings
(`#`..`######`), builds a nested bullet-list Table of Contents with GitHub-style
anchor links, and writes that TOC between `<!-- toc -->` and `<!-- /toc -->`
marker comments inside the file — inserting the marker pair just after the first
H1 when it is absent. It honors `--min-level`/`--max-level` (default `2..4`), is
**idempotent** (re-running on an unchanged file produces a byte-identical
result), and leaves every byte outside the markers untouched. The end state is
this working tool present and verified on the host.

## Done

Each condition is checkable from a fresh shell, with no memory of this run:

- An executable `mdtoc` exists in `WORKDIR` (`./mdtoc`) and runs under `python3`
  using only the Python standard library (no `pip install`, no third-party
  imports).
- `mdtoc --help` exits `0` and documents the positional `FILE` plus
  `--min-level` and `--max-level`.
- On a Markdown file with no markers, the first invocation inserts a
  `<!-- toc -->` / `<!-- /toc -->` pair immediately after the first H1, with a
  correct nested TOC between them.
- Re-running `mdtoc` on that file a second time leaves it **byte-identical**
  (`cmp` reports no difference) — idempotency holds.
- The TOC excludes headings outside `[min_level, max_level]`, excludes ATX
  lines that occur inside fenced code blocks, generates GitHub-style slugs, and
  de-duplicates colliding slugs with `-1`, `-2`, … suffixes.
- Every line of the source file outside the marker pair is unchanged after a run.

## Inputs

Collected in the `### 0. Interview` first turn. Detect before you ask.

| name | required | default | detect | ask |
|---|---|---|---|---|
| `python3` | yes | — | `command -v python3` (need ≥ 3.8: `python3 -c 'import sys;print(sys.version_info[:2])'`) | "This tool runs on `python3` (≥ 3.8) and it wasn't found. Install it (e.g. Xcode Command Line Tools `xcode-select --install`, or python.org) and re-run. This is the one declared blocker: `BLOCKED_REASON=python3_missing`." |
| `WORKDIR` | yes | current directory (`pwd`) | `pwd` | "Where should I create the `mdtoc` script and any throwaway test fixtures? Default: the current directory." |

There is no user *content* to gather: `mdtoc` operates on whatever file the
consumer later points it at. The only runtime argument (`FILE`) is supplied per
invocation on the command line, not at build time.

## Components

| component | role | source |
|---|---|---|
| `mdtoc` | the CLI tool: a single executable script that injects/updates a Markdown TOC | built by you in `## Steps` from the spec — a single-file `python3` program, standard library only |
| `python3` (≥ 3.8) | interpreter that runs `mdtoc` | host-provided; detected in the interview, else `BLOCKED_REASON=python3_missing` |
| throwaway fixture `*.md` | temporary Markdown files used by `## Verify` to exercise the tool | generated during Verify; deleted by `## Cleanup` |

## Steps

### 0. Interview (mandatory first turn)

Run the detects in `## Inputs` first, then resolve both inputs:

- `python3`: run `command -v python3`. If absent (or older than 3.8 and not
  upgradable), stop now and print `BLOCKED_REASON=python3_missing`. This is the
  ONLY legitimate blocker.
- `WORKDIR`: default to the current directory. Confirm the single finite choice
  (here vs. a path) with the host's question primitive; everything else is
  determined by this spec, so do not ask more.

### 1. Build the `mdtoc` script

Create an executable file `mdtoc` in `WORKDIR`:

```bash
cd "$WORKDIR"
# write the program described below to ./mdtoc, then:
chmod +x ./mdtoc
```

The first line must be `#!/usr/bin/env python3`. Import **only** the standard
library (`argparse`, `re`, `sys` are sufficient). Implement exactly the
following behavior — the precision here is what makes the tool idempotent, so do
not improvise the formatting.

#### 1a. Command-line interface

```
mdtoc [--min-level N] [--max-level N] FILE
```

- `FILE` — positional, required: path to the Markdown file to edit in place.
- `--min-level` — integer, default `2`. Headings shallower than this are
  excluded (so the document's H1 title is excluded by default).
- `--max-level` — integer, default `4`. Headings deeper than this are excluded.
- Validate `1 <= min_level <= max_level <= 6`; on violation, write a message to
  stderr and exit `2`.
- If `FILE` does not exist or cannot be read, write a message to stderr and exit
  `1`.
- On success, edit the file in place, optionally print a one-line summary to
  stdout, and exit `0`. (Stdout content is irrelevant to correctness — the
  product is the rewritten file.)
- `--help` must exit `0` and list `FILE`, `--min-level`, `--max-level`.

#### 1b. Heading scan (ATX only, code-fence aware)

Read the whole file as text. Split into lines for scanning. Walk the lines top to
bottom, tracking whether you are inside a fenced code block:

- A line matching `^ {0,3}(```+|~~~+)` toggles fenced-code state. Record which
  fence character opened it (`` ` `` or `~`); only a line whose fence uses the
  **same** character (and is at least as long) closes it. **WHY:** a `# Foo`
  line inside a ```` ```python ```` block is source code, not a heading —
  counting it would put a phantom entry in the TOC and (worse) change the output
  when unrelated code is edited, breaking idempotency expectations.
- When NOT inside a fence, a heading line matches
  `^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$`:
  - `level` = number of leading `#` characters (1..6).
  - A run of 7+ `#` is **not** a heading; requiring 1..6 then whitespace-or-end
    handles this. `#text` with no space after the `#` is **not** a heading
    either (CommonMark requires a space) — the regex's `[ \t]+` enforces it.
  - Raw heading text = capture group 2 (or empty string).
- Strip a trailing closing `#` sequence from the heading text only when it is
  preceded by whitespace: apply `re.sub(r'[ \t]+#+[ \t]*$', '', text)`, then
  `.strip()`. **WHY:** `## Heading ##` renders as "Heading", but `## C#` must
  stay "C#" — the closing sequence is only stripped when spaced off, per
  CommonMark.

Collect headings whose `min_level <= level <= max_level`, in document order,
each as `(level, text)`.

#### 1c. GitHub-style slug (with de-duplication)

For each collected heading, derive an anchor slug from its (already trimmed) text:

1. Lowercase the text.
2. Remove every character that is **not** an ASCII letter `a-z`, digit `0-9`,
   space, hyphen `-`, or underscore `_`: `re.sub(r'[^a-z0-9 _-]', '', s)`.
   (Punctuation like `&`, `:`, `?`, `!`, `.`, `*`, backticks is dropped;
   underscores and existing hyphens are kept — this matches GitHub's anchors.)
3. Replace every space with a hyphen `-` (do **not** collapse runs — two spaces
   become two hyphens, matching GitHub).

De-duplicate across the document in first-appearance order: keep a count of how
many times each base slug has been emitted. The first time a base slug appears,
use it unchanged; the Nth subsequent time (N ≥ 1) append `-N`. **WHY:** GitHub
gives the second "## Setup" the anchor `#setup-1` and the third `#setup-2`; the
tool must match so the links actually resolve.

Worked examples (verify your implementation against these):

| heading text | slug |
|---|---|
| `Getting Started` | `getting-started` |
| `Q&A: What's next?!` | `qa-whats-next` |
| `Setup` (1st) | `setup` |
| `Setup` (2nd) | `setup-1` |
| `C# notes` | `c-notes` |
| `snake_case_name` | `snake_case_name` |

#### 1d. Render the TOC block

The block is exactly these lines (a constant open marker, blank line, the
bullets, blank line, constant close marker):

```
<!-- toc -->

<bullet lines>

<!-- /toc -->
```

Each bullet line is:

```
<indent>- [<text>](#<slug>)
```

- `<indent>` = two spaces repeated `(level - min_level)` times. So with the
  default `min_level=2`: H2 → no indent, H3 → 2 spaces, H4 → 4 spaces.
- `<text>` = the trimmed heading text **verbatim** (do not slugify the visible
  label; only the `#<slug>` target is slugified).
- If there are zero collected headings, the block is just the two markers with a
  single blank line between them (`<!-- toc -->`, blank, `<!-- /toc -->`).

Define the marker strings once as constants (`<!-- toc -->`, `<!-- /toc -->`) and
reuse them for both detection and rendering — they must match exactly.

#### 1e. Splice the block into the file (the idempotency-critical part)

Work on the list of lines (`text.split("\n")`, which preserves a trailing
newline as a final empty element; re-join with `"\n".join(...)` to restore the
original trailing-newline state byte-for-byte).

- **Markers already present** (a line whose stripped content equals
  `<!-- toc -->` and, after it, a line whose stripped content equals
  `<!-- /toc -->`): replace the **inclusive** span from the open-marker line
  through the close-marker line with the freshly rendered block. Everything
  before the open marker and after the close marker is left exactly as-is.
  **WHY this guarantees idempotency:** every run rewrites both marker lines and
  their interior to the same deterministic block, and never touches anything
  outside, so a second run on an unchanged document reproduces identical bytes.
- **Markers absent, an H1 exists** (first heading line with `level == 1`, found
  by the same code-fence-aware scan — independent of `min_level`): insert, right
  after that H1 line, a blank line, then the rendered block, then a blank line,
  then the original following content. Insert these blanks unconditionally — do
  NOT try to coalesce them against whatever blank line may already follow the
  H1. **WHY:** correctness depends only on the block being well-formed and on
  every later run reproducing identical bytes; since later runs splice the
  inclusive marker span and never touch the surrounding lines, a stray doubled
  blank is harmless and stays stable, whereas "smart" blank-collapsing reads the
  pre-existing line and makes the first insertion a function of file state —
  inviting the exact drift that breaks idempotency. Keep insertion blank-count
  fixed; never normalize blanks outside the markers.
- **Markers absent and no H1**: insert the rendered block at the very top of the
  file, followed by a blank line, then the original content.
- **Exactly one marker present** (open without close, or vice versa): this is a
  malformed file; write a message to stderr and exit `1` rather than guessing.

Write the result back to `FILE` in place.

### 2. Smoke-check the build

```bash
./mdtoc --help            # exits 0, shows FILE / --min-level / --max-level
```

Then proceed to `## Verify` for the real proof.

## Verify

Agent-driven: the script below **gathers evidence**; YOU read the resulting
files and judge each claim against what is actually on disk. Do not treat any
single command's exit code as the verdict — `cat` the files and reason.

Build a fixture that exercises every rule, then run the tool:

```bash
cd "$WORKDIR"
cat > fixture.md <<'EOF'
# My Document

Intro paragraph that must stay untouched.

## Getting Started

Body text.

### Q&A: What's next?!

More body.

#### Details

## Setup

First setup section.

## Setup

Second setup section (duplicate heading).

##### Too Deep

This H5 is below the default max-level and must be excluded.

```python
# Not A Heading
def f(): pass
```

End of file marker line.
EOF

cp fixture.md fixture.orig            # keep a pristine copy for the "outside markers" check

./mdtoc fixture.md                    # first run: should insert markers after the H1
echo '----- after first run -----'
cat fixture.md

cp fixture.md fixture.after1          # snapshot
./mdtoc fixture.md                    # second run: must be a no-op on the bytes
echo '----- idempotency cmp (no output = identical) -----'
cmp fixture.after1 fixture.md && echo "IDEMPOTENT_OK"

echo '----- min/max override: only H3..H3 -----'
cp fixture.orig fixture2.md
./mdtoc --min-level 3 --max-level 3 fixture2.md
cat fixture2.md

echo '----- full range 1..6 -----'
cp fixture.orig fixture3.md
./mdtoc --min-level 1 --max-level 6 fixture3.md
cat fixture3.md
```

Judge the live output. The run PASSES only if ALL of these hold (read the files
to confirm — do not assume):

1. **Markers placed after the H1.** In `fixture.md`, `<!-- toc -->` … `<!-- /toc -->`
   appear immediately after the `# My Document` line (with a blank line), and the
   `# My Document` line itself is unchanged.
2. **Default TOC contents.** Between the markers, with default levels `2..4`:
   - `- [Getting Started](#getting-started)`
   - `  - [Q&A: What's next?!](#qa-whats-next)` (indented one level; slug strips
     `&`, `:`, `'`, `?`, `!`)
   - `    - [Details](#details)` (indented two levels)
   - `- [Setup](#setup)`
   - `- [Setup](#setup-1)` (duplicate slug suffixed)
   The H1 `My Document`, the H5 `Too Deep`, and the `# Not A Heading` line inside
   the ```` ```python ```` fence are all ABSENT from the TOC.
3. **Idempotency.** `cmp` printed nothing and `IDEMPOTENT_OK` appeared — the
   second run produced byte-identical output.
4. **Outside the markers is untouched.** Everything in `fixture.md` except the
   inserted marker block matches `fixture.orig` (same intro paragraph, same
   headings, same code fence, same trailing line). `diff fixture.orig fixture.md`
   should show only the added marker block, nothing else changed.
5. **Level overrides work.** `fixture2.md` (`--min-level 3 --max-level 3`) lists
   only the H3 (`Q&A: What's next?!`) with no indentation. `fixture3.md`
   (`1..6`) includes `My Document` (H1), both `Setup`s, `Too Deep` (H5), and the
   nesting deepens accordingly — while the `# Not A Heading` inside the code
   fence is STILL excluded.
6. **Re-confirm idempotency on an override.** Run `./mdtoc --min-level 3
   --max-level 3 fixture2.md` a second time and `cmp` it against its own prior
   output — still byte-identical.

If every check holds on the real files, print `SEED_RESULT=DONE`. If any fails,
the tool is not built correctly — fix `mdtoc` and re-run Verify; do not declare
done on partial evidence.

## Failure modes

**Symptom: the second run changes the file (not idempotent).**
- Detect: `cmp fixture.after1 fixture.md` reports a difference.
- Fix: the splice must rewrite the **inclusive** marker span (both marker lines
  plus interior) to the exact same deterministic block and touch nothing else.
  Usual causes: emitting a different number of blank lines around the block on
  the second pass; mishandling the trailing newline (use `split("\n")` /
  `"\n".join(...)` so the final-newline state round-trips); or collapsing/adding
  whitespace in bullets. Make the rendered block a pure function of the headings.

**Symptom: a heading inside a code block appears in the TOC.**
- Detect: `# Not A Heading` (or similar) shows up as a TOC entry.
- Fix: track fenced-code state (```` ``` ```` and `~~~`) during the scan and skip
  ATX matches while inside a fence; only a same-character fence of equal-or-greater
  length closes the block.

**Symptom: duplicate headings produce duplicate (broken) anchors.**
- Detect: two `## Setup` headings both yield `#setup`.
- Fix: de-duplicate by first-appearance count — 1st `setup`, 2nd `setup-1`, 3rd
  `setup-2`, matching GitHub so the in-page links resolve.

**Symptom: anchors don't match GitHub (links 404 in the rendered page).**
- Detect: slug keeps punctuation, or upper-case, or collapses spaces wrong.
- Fix: lowercase → drop everything except `[a-z0-9 _-]` → spaces to hyphens
  (no collapsing). Keep underscores and existing hyphens; the visible label keeps
  its original text, only the `#anchor` is slugified.

**Symptom: `# My Document` (H1) shows in the TOC by default.**
- Detect: the title appears as a top-level TOC entry under default flags.
- Fix: default `min_level` is `2`, so H1 is excluded; only widen with
  `--min-level 1`. Insertion still keys off the first H1 regardless of `min_level`.

**Symptom: `python3` missing.**
- Detect: `command -v python3` is empty.
- Fix: this is the one declared blocker — install `python3` (Xcode CLT or
  python.org) and re-run, or print `BLOCKED_REASON=python3_missing`.

## Cleanup

To uninstall `mdtoc` later, or to recover from an aborted/failed build, return
the host to zero (do NOT run this after a successful build — the working `mdtoc`
tool is the product you keep):

```bash
cd "$WORKDIR"
rm -f ./mdtoc                                   # the built tool
rm -f fixture.md fixture.orig fixture.after1 \
      fixture2.md fixture3.md                   # Verify fixtures and snapshots
rm -f *.md.bak *.bak                            # any backups a run may have left
```

No services, containers, accounts, registries, or auth state are created by this
seed, so nothing else needs wiping. After cleanup the host has no trace of the
tool or its fixtures.
