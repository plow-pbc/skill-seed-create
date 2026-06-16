---
name: seed-create
description: Use when the user wants to capture a capability — a feature, tool, or product that works on their machine — as a SEED: one self-contained spec another agent can rebuild the whole thing from. Triggers on "author/create a seed", "turn this into a seed", "make a spec an agent can build from", or capturing a working capability so a fresh agent (or someone else) can reproduce it from the spec alone.
---

# seed-create

A SEED is one spec file (`<name>.seed.md`) that a blind LLM agent can build a
capability from end to end, with nothing else in hand — proven empirically by
the harden loop before it ships.

**When invoked:** `Read` the colocated `seed-create.seed.md` in full and execute
it exactly. It is the authoring procedure (interview → recon → draft → harden →
publish), and it is the source of truth — follow it, don't summarize or
improvise around it.

**Do NOT use when:** the user wants to *run/consume* an existing seed — that's
plain hydration (point a blind agent at the seed and execute it), not authoring.
Or when they just want a throwaway script with no intent to capture or
distribute it.

The harden loop the procedure dispatches (`harden.seed.md`) is read on demand at
its Step 5 — it is not loaded up front.
