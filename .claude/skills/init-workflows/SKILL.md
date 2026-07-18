---
name: init-workflows
description: Generate .claude/project-profile.json for this repo so the bug-fix-sprint and feature-sprint workflows (and the spec-breakdown / codebase-grounding agents) run against this project's real tooling, infra, labels, docs, and models. Run this once after cloning the workflow template into a new repo.
---

# Init Workflows

You are configuring the shareable sprint workflows for **this** repository. The workflow `.js`
files and support agents are byte-identical across every project; all per-project variation lives
in a single **`.claude/project-profile.json`**. Your job is to write that file.

Work in four phases: **Detect → Interview → Validate → Write**. Detect silently, then confirm your
detections with the user (don't ask open-ended questions when you can propose an answer), validate
before writing, and finish with a summary table.

The target schema (pure JSON — no comments, no trailing commas) is:

```json
{
  "repo": {
    "claude_md": "CLAUDE.md",
    "adr_glob": "docs/decisions/*.md",
    "design_globs": ["docs/architecture/*.md", "docs/design/*.md"]
  },
  "tooling": {
    "test_unit": "npm test -- --testPathIgnorePatterns=integration",
    "test_full": "npm test",
    "build": null,
    "lint": null,
    "preflight": ["node --version"]
  },
  "infra": {
    "needs_infra": false,
    "infra_up": null,
    "migrate": null,
    "secrets_note": null,
    "infra_touched_hint": "migrations, docker, service wiring"
  },
  "github": {
    "labels": { "bug": "bug", "specs": "specs", "stranded": "needs-human" },
    "auto_create_stranded_label": true,
    "milestone_branch_pattern": "mvp{N}",
    "milestone_title_regex": "^\\[(.+?)\\]"
  },
  "review_emphasis": "",
  "models": {
    "planner": "claude-opus-4-8[1m]",
    "impl": "claude-opus-4-8[1m]",
    "review": "claude-sonnet-4-6",
    "trailer": "Co-Authored-By: Claude <noreply@anthropic.com>"
  }
}
```

A filled specimen lives at `.claude/project-profile.example.json` — read it for reference. If
`.claude/project-profile.json` already exists, tell the user and offer to review/update it rather
than overwriting blindly.

Every field's meaning:
- **`repo.claude_md`** — the project guide file the planner/architect/reviewers read.
- **`repo.adr_glob`** — glob for decision records / ADRs (design intent). Used by reviewers and the
  grounding agent. If the project has none, point it at whatever design docs exist, or leave a glob
  that simply matches nothing.
- **`repo.design_globs`** — globs for design/architecture docs the spec-breakdown agent reads.
- **`tooling.test_unit`** — the fast/unit test command (the always-run gate).
- **`tooling.test_full`** — the full test command. If there is no unit/full split, set it equal to
  `test_unit`.
- **`tooling.build`**, **`tooling.lint`** — optional; `null` if not applicable.
- **`tooling.preflight`** — array of cheap commands Setup runs to prove the toolchain is installed
  (each must exit 0), e.g. `["node --version"]` or `["uv --version"]`.
- **`infra.needs_infra`** — `true` only if verifying the code requires a running stack (DB, docker,
  services). `false` (the default) collapses every docker/migrate/infra-lock path in the workflows.
- **`infra.infra_up`** / **`infra.migrate`** / **`infra.secrets_note`** — only meaningful when
  `needs_infra` is true; `null` otherwise. `secrets_note` describes how integration tests obtain
  secrets (a short phrase the test agent interpolates, e.g. `"run under scripts/with-secrets"`).
- **`infra.infra_touched_hint`** — examples of infra-affecting changes, injected where the
  implementer decides whether it touched infrastructure (e.g. `"migrations, docker, service wiring"`).
- **`github.labels.bug`** / **`.specs`** — the labels bug-fix-sprint and feature-sprint select on.
- **`github.labels.stranded`** — label applied (best-effort) to an issue the workflow gives up on.
- **`github.auto_create_stranded_label`** — if true, Setup best-effort creates the stranded label.
- **`github.milestone_branch_pattern`** — informational; how milestone branches are named.
- **`github.milestone_title_regex`** — extracts the milestone label from a specs-issue title
  (capture group 1). Default `^\\[(.+?)\\]` turns `[MVP 7] …` into `MVP 7`.
- **`review_emphasis`** — free-text, project-specific review focus. **Empty ⇒ generic
  `/code-review` + `/security-review`.** Non-empty ⇒ its text is injected verbatim into the
  architect / reviewer / security-dimension prompts. This is the escape hatch for project-specific
  architectural rules (module boundaries, security invariants, naming conventions, etc.).
- **`models.planner`** / **`.impl`** / **`.review`** — model IDs for the planning, implementation,
  and review/test/merge agents. **`.trailer`** — the `Co-Authored-By:` commit trailer.

---

## Phase 1 — Detect (no questions)

Fingerprint the repo silently. Use Glob/Read/Bash (read-only):

1. **Language + test tooling** from the manifest:
   - `pyproject.toml` / `uv.lock` → Python. `uv.lock` ⇒ `uv run pytest` family and
     `preflight: ["uv --version"]`; otherwise `python -m pytest` / `pytest` with
     `preflight: ["python --version"]`. A `-m "not integration"` split is common in pytest.
   - `package.json` → Node. **Read its `scripts`** — use the real `test`, `build`, `lint`, and any
     `test:unit` / `test:integration` scripts. `preflight: ["node --version"]`.
   - `Cargo.toml` → Rust: `cargo test`, `cargo build`, `cargo clippy`; `preflight: ["cargo --version"]`.
   - `go.mod` → Go: `go test ./...`, `go build ./...`, `go vet ./...`; `preflight: ["go version"]`.
   - Otherwise leave commands blank and ask.
2. **Unit/full split** — look for a marker (pytest `integration` marker), a path convention
   (`tests/integration/…`, `*.integration.test.ts`), or a dedicated script. If none exists, plan for
   `test_full == test_unit`.
3. **Infra** — `docker-compose.yml` / `compose.yaml` / `Dockerfile` ⇒ `needs_infra` **candidate**
   (confirm with the user — presence of a Dockerfile doesn't mean tests need it). Migrations dir
   (`db/migrations` with dbmate, `alembic/`, `migrations/` with prisma/knex) ⇒ a `migrate` candidate.
4. **Docs** — presence of `CLAUDE.md`; and of `docs/decisions`, `docs/adr`, `docs/architecture`,
   `docs/design` (Glob each). Build `adr_glob` and `design_globs` from what actually exists.
5. **GitHub** — `gh label list --limit 200` for existing labels (match `bug`, `specs`/`spec`,
   and any human-escalation label like `needs-human`/`help wanted`/`blocked`); `gh repo view --json
   defaultBranchRef` for the default branch. If `gh` is not authed, note it and fall back to defaults.

Summarize what you detected in one compact block before moving on.

## Phase 2 — Interview (grouped, detect-confirm; ~4 questions)

Present detections as "found X — correct?" rather than open prompts. Group into ~4 questions
(use the AskUserQuestion tool where it helps):

a. **Tooling** — confirm `test_unit`, `test_full`, and **how the unit/full split is expressed**
   (marker / path / dedicated script / none ⇒ `test_full == test_unit`). Confirm `build`/`lint`
   (or `null`) and `preflight`.
b. **Infra** — "does verifying a change need a running stack?" If **no** → `needs_infra: false` and
   all four infra command fields `null` (the demo default; recommend this unless the user says the
   test suite genuinely needs services). If **yes** → collect `infra_up`, `migrate`, `secrets_note`.
c. **GitHub** — confirm the `bug` / `specs` / `stranded` label names; offer to auto-create the
   stranded label (`auto_create_stranded_label`). Ask about `milestone_branch_pattern` /
   `milestone_title_regex` **only if** the user intends to use feature-sprint (milestone delivery);
   otherwise keep the defaults.
d. **Docs + review emphasis** — confirm `claude_md`, `adr_glob`, `design_globs`. Ask for optional
   **`review_emphasis`** free text (project-specific architectural/security rules to weigh in
   reviews); empty is fine and keeps reviews generic. If there is no `CLAUDE.md`, offer to run
   `/init` to create one.

Also confirm the `models` block (default to the values in the example) and the commit `trailer`.

## Phase 3 — Validate before writing

Don't silently trust detections — prove them:
- Run each `preflight` command; report pass/fail.
- Dry-collect tests without running them where possible: `pytest --collect-only -q`,
  `npm test -- --listTests` (or the framework equivalent). Confirm the command is at least valid.
- If `needs_infra` is true, `docker compose config -q` to confirm the compose file parses (do **not**
  bring the stack up here).
- Confirm `claude_md` and at least one `design_globs`/`adr_glob` match real files (Glob).

Report a short pass/fail list. If something fails, fix the value with the user before writing.

## Phase 4 — Write + report

1. Assemble the profile object and **write `.claude/project-profile.json`**. It must be **pure JSON**
   (no comments/trailing commas) and `JSON.parse`-able — the workflows' Setup agent parses it directly.
   Verify by parsing it back (e.g. `node -e "JSON.parse(require('fs').readFileSync('.claude/project-profile.json','utf8'))"`).
2. Print a **summary table** of every value written and which were left at their default.
3. Name the one behavior delta explicitly: **reviews are generic `/code-review` + `/security-review`
   unless `review_emphasis` is non-empty**, and **`needs_infra: false` disables all
   docker/migrate/integration paths**.
4. Tell the user what's next: commit `.claude/project-profile.json`, then run `/bug-fix-sprint`
   (needs `bug`-labelled issues) or `/feature-sprint <specs#>` (needs a milestone branch + a
   `specs`-labelled issue with a sub-issue dependency graph).

## Guardrails
- Ask before overwriting an existing `.claude/project-profile.json`.
- Never invent a test/build command you couldn't at least dry-validate — confirm it with the user
  instead.
- Keep the output pure JSON. If you want to leave guidance, put it in the summary message, not the file.
