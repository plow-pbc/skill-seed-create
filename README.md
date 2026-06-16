# seed-create

A skill for authoring **SEEDs**. A SEED is one self-contained spec
(`<name>.seed.md`) that a blind LLM agent can build an entire capability from —
a feature, a CLI tool, a whole product — with nothing in hand but that file.

The catch most specs miss: *is it actually buildable from the text alone?*
seed-create answers that empirically. Authoring a seed is two phases:

1. **Draft** — a short interview about the capability produces a candidate spec.
2. **Harden** — a fresh, blind agent tries to build the capability from the
   spec on a clean slate. Every gap it hits is fixed in the spec, and it runs
   again. The seed isn't "done" until a blind agent one-shots it from zero.

A draft is a hypothesis; hardening is what turns it into a spec you can trust.

## What's in here

| file | role |
|---|---|
| `SKILL.md` | skill entry point (frontmatter + a pointer to the procedure) |
| `seed-create.seed.md` | the authoring procedure: interview → recon → draft → harden → publish |
| `harden.seed.md` | the blind-rebuild validation loop, dispatched during authoring; bundled so it resolves offline |
| `examples/mdtoc/mdtoc.seed.md` | a finished, hardened seed for a small Markdown-TOC CLI — what the output looks like |

## Install

Drop the repo into your agent's skills directory. For Claude Code:

```bash
git clone https://github.com/plow-pbc/skill-seed-create ~/.claude/skills/seed-create
```

That lands `SKILL.md` and its bundled files together, so the harden loop
resolves locally with no network round-trip.

## Use

Invoke it when you want to capture a working capability as a spec another agent
can rebuild from scratch — e.g. *"turn this into a seed"* or *"author a seed for
&lt;capability&gt;"*. The skill interviews you, drafts the seed, drives the harden
loop, and (with your go-ahead) publishes the result. Consuming a finished seed
is the reverse and needs no skill: point a fresh agent at it and say *"hydrate
`seeds/<name>/<name>.seed.md` and execute it."*

## License

MIT — see [LICENSE](LICENSE).
