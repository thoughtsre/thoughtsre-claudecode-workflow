# Claude Code Sprint Workflows

A shareable template of autonomous, multi-agent development workflows for [Claude Code](https://claude.com/claude-code). Clone it into any GitHub-backed project and the sprints will plan, implement, review, test, and merge GitHub issues for you.

The workflow scripts and support agents are **byte-identical across every project** — all per-project variation (test commands, infra, labels, docs, models) lives in a single `.claude/project-profile.json`.

## What's in `.claude/`

| Path | What it is |
|------|------------|
| `workflows/bug-fix-sprint.js` | Delivers open `bug` issues one at a time: plan → implement → review → test → PR + squash-merge into the default branch. |
| `workflows/feature-sprint.js` | Delivers a milestone specs issue via a rolling dependency-aware scheduler, merging sub-issues into a milestone branch until it's ready for the human PR. |
| `agents/spec-breakdown.md` | Breaks a `specs` issue into a dependency-ordered graph of sub-issues. |
| `agents/codebase-grounding.md` | Read-only agent that grounds claims/plans in the real code with `file:line` citations. |
| `skills/` | Git helpers (`commit`, `pr`, `push`, `merge-pr`), `think`, and the `init-workflows` generator. |
| `project-profile.example.json` | A filled specimen of the per-project config. |

## Quickstart

1. **Clone this `.claude/` folder into your repo** (or clone the whole template and point it at your project).
2. **Generate your project profile** — run the generator, which fingerprints your repo, confirms its detections with you, validates the commands, and writes `.claude/project-profile.json`:

   ```
   /init-workflows
   ```

   The sprints **hard-fail with "run /init-workflows first"** until this file exists — there are no silent defaults. See `.claude/project-profile.example.json` for the shape.
3. **Commit `.claude/project-profile.json`** so your team shares the same configuration.
4. **Run a sprint:**
   - `/bug-fix-sprint` — deliver all open issues with your `bug` label.
   - `/feature-sprint <specs#>` — deliver a milestone. Run it from a milestone branch (e.g. `mvp1`) whose `specs`-labelled issue has a sub-issue dependency graph (use the `spec-breakdown` agent to create one).

## Configuration

Everything project-specific is a field in `.claude/project-profile.json`:

- **`tooling`** — your unit / full test commands, optional build/lint, and preflight version checks.
- **`infra`** — `needs_infra: false` (the default) collapses all Docker/migration/integration paths. Set it `true` and fill `infra_up` / `migrate` / `secrets_note` if verifying a change needs a running stack.
- **`github`** — your `bug` / `specs` / stranded label names and milestone conventions.
- **`repo`** — your project guide and design/decision-record doc globs.
- **`review_emphasis`** — free text injected into the review prompts. Empty ⇒ generic `/code-review` + `/security-review`; non-empty ⇒ your project's architectural/security rules are weighed in every review.
- **`models`** — the model IDs and commit trailer the agents use.

Re-run `/init-workflows` any time to regenerate or update the profile.
