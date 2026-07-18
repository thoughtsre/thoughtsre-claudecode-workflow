export const meta = {
  name: 'bug-fix-sprint',
  description:
    'Autonomously deliver open GitHub issues labelled `bug`, one at a time. Select the open `bug` issues (ascending by number, skipping any that already have an open linked PR), then for each bug: plan (planner↔architect) → implement → review → test on a branch cut from a freshly-pulled main → PR + squash-merge into main (Fixes #N auto-closes the issue). Failures fail soft: an async escalation fixer takes one pass, then the bug is stranded (comment + best-effort label, skip, keep going) — there is no shared integration branch to break, so the run never hard-stops. Ends `complete` (all delivered), `partial` (some stranded), or `noop` (no open bugs).',
  phases: [
    { title: 'Setup', detail: 'Read .claude/project-profile.json (hard-fail if absent), run preflight checks + gh auth, derive owner_repo + default branch, sync to clean main, bring infra up once if needs_infra' },
    { title: 'Select', detail: 'gh issue list --label <bug> --state open, ascending by number; skip bugs with an open linked PR' },
    { title: 'Plan', detail: 'planner (Plan agent) ↔ architect loop, write .claude/plans/issue-N.md' },
    { title: 'Implement', detail: 'implementer (default agent) on a branch cut from a freshly-pulled default branch, strictly per plan' },
    { title: 'Review', detail: 'reviewer agent (/code-review rubric); fix until HIGH+MEDIUM clean' },
    { title: 'Test', detail: 'unit suite always; full suite if infra_needed and needs_infra' },
    { title: 'Merge', detail: 'push, gh pr create --base main with Fixes #N, gh pr merge --squash --delete-branch; sync main for the next bug' },
    { title: 'Escalate', detail: 'async escalation fixer (max effort) takes one pass at a stranded bug — failing review/test fix or a merge-conflict rebase — before the bug is stranded and the run keeps going' },
    { title: 'Report', detail: 'complete (all delivered), partial (fail-soft residue — delivered/stranded/skipped), or noop (no open bugs)' },
  ],
}

// ── Tunables (workflow tuning; NOT project-specific — per-project config lives in .claude/project-profile.json) ──
const MAX_PLAN_ROUNDS = 6     // planner↔architect negotiation rounds
const MAX_REVIEW_FIXES = 3    // fix passes for HIGH/MEDIUM review findings
const MAX_TEST_ATTEMPTS = 3   // fix+retest attempts before halting a bug

// ── Args ──────────────────────────────────────────────────────────────────────
// `/bug-fix-sprint`               → all open `bug` issues (label from the profile)
// `/bug-fix-sprint 239 240`       → restrict to those issue numbers
// `/bug-fix-sprint regression`    → override the work-source label
const RAW_ARGS = args === undefined || args === null ? '' : String(args).trim()
const ARG_TOKENS = RAW_ARGS.split(/\s+/).filter(Boolean)
const EXPLICIT_NUMBERS = ARG_TOKENS.filter((t) => /^#?\d+$/.test(t)).map((t) => parseInt(t.replace('#', ''), 10))
const LABEL_TOKEN = ARG_TOKENS.find((t) => !/^#?\d+$/.test(t))
// Resolved after setup: WORK_LABEL = LABEL_TOKEN || ctx.labels.bug (the profile's bug label).
let WORK_LABEL = LABEL_TOKEN || 'bug'

// ── Structured-output schemas ─────────────────────────────────────────────────
// Setup echoes the live repo identity PLUS every field parsed from .claude/project-profile.json,
// so that every downstream prompt/constant reads project-specific values from `ctx` (the .js never
// needs per-project edits). Nullable fields (build/lint/infra_up/migrate/secrets_note) carry no
// `type` so JSON null is accepted.
const SETUP_SCHEMA = {
  type: 'object',
  required: ['ok', 'owner_repo', 'repo_root', 'default_branch'],
  properties: {
    ok: { type: 'boolean' },
    owner_repo: { type: 'string', description: 'nameWithOwner of the repo (derived live via gh)' },
    repo_root: { type: 'string', description: 'absolute path of the repository checkout (git rev-parse --show-toplevel)' },
    default_branch: { type: 'string', description: 'the default branch, e.g. main' },
    // ── echoed from .claude/project-profile.json ──
    test_unit: { type: 'string', description: 'profile tooling.test_unit — the unit/fast test command' },
    test_full: { type: 'string', description: 'profile tooling.test_full — the full test command (== test_unit if no split)' },
    build: { description: 'profile tooling.build (string or null)' },
    lint: { description: 'profile tooling.lint (string or null)' },
    preflight: { type: 'array', items: { type: 'string' }, description: 'profile tooling.preflight — version/tooling checks run in Setup' },
    needs_infra: { type: 'boolean', description: 'profile infra.needs_infra — false collapses all docker/migrate/infra-lock paths' },
    infra_up: { description: 'profile infra.infra_up — command to bring the stack up (string or null)' },
    migrate: { description: 'profile infra.migrate — DB migration command (string or null)' },
    secrets_note: { description: 'profile infra.secrets_note — how tests obtain secrets (string or null)' },
    infra_touched_hint: { type: 'string', description: 'profile infra.infra_touched_hint — examples of infra-affecting changes' },
    labels: {
      type: 'object',
      description: 'profile github.labels',
      properties: { bug: { type: 'string' }, specs: { type: 'string' }, stranded: { type: 'string' } },
    },
    stranded_label: { type: 'string', description: 'profile github.labels.stranded — best-effort label on a stranded bug' },
    claude_md: { type: 'string', description: 'profile repo.claude_md — path to the project guide' },
    adr_glob: { type: 'string', description: 'profile repo.adr_glob — glob for decision records' },
    design_globs: { type: 'array', items: { type: 'string' }, description: 'profile repo.design_globs' },
    review_emphasis: { type: 'string', description: 'profile review_emphasis — project-specific review focus injected into architect/reviewer prompts ("" ⇒ generic reviews)' },
    models: {
      type: 'object',
      description: 'profile models',
      properties: { planner: { type: 'string' }, impl: { type: 'string' }, review: { type: 'string' }, trailer: { type: 'string' } },
    },
    trailer: { type: 'string', description: 'profile models.trailer — the Co-Authored-By commit trailer' },
    error: { type: 'string' },
  },
}

const SELECT_SCHEMA = {
  type: 'object',
  required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'has_open_pr'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          url: { type: 'string' },
          has_open_pr: { type: 'boolean', description: 'true if an open PR already links/mentions this issue (skip it)' },
        },
      },
    },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['plan_markdown', 'files_touched', 'open_questions', 'infra_needed', 'test_plan'],
  properties: {
    plan_markdown: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    infra_needed: { type: 'boolean', description: 'true if verifying this bug requires the Docker stack (integration tests)' },
    test_plan: { type: 'string' },
  },
}

const ARCH_SCHEMA = {
  type: 'object',
  required: ['verdict', 'answers', 'revisions'],
  properties: {
    verdict: { enum: ['APPROVED', 'REVISE'] },
    answers: { type: 'array', items: { type: 'string' }, description: 'one answer per open_question, decided autonomously' },
    revisions: { type: 'array', items: { type: 'string' }, description: 'required changes if REVISE; [] if APPROVED' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['status', 'files_changed', 'commit_sha', 'unit_tests_passed', 'summary'],
  properties: {
    status: { enum: ['ok', 'blocked'] },
    files_changed: { type: 'array', items: { type: 'string' } },
    commit_sha: { type: 'string' },
    unit_tests_passed: { type: 'boolean' },
    infra_touched: { type: 'boolean' },
    summary: { type: 'string' },
    error: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'description'],
        properties: {
          severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

const TEST_SCHEMA = {
  type: 'object',
  required: ['passed', 'output'],
  properties: {
    passed: { type: 'boolean' },
    output: { type: 'string', description: 'tail of the test output (failures if any)' },
    ran_integration: { type: 'boolean' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['merged'],
  properties: {
    merged: { type: 'boolean' },
    pr_url: { type: 'string' },
    merge_commit: { type: 'string', description: 'the squash-merge commit sha on the default branch' },
    issue_closed: { type: 'boolean' },
    error: { type: 'string' },
  },
}

const FIXER_SCHEMA = {
  type: 'object',
  required: ['status', 'diagnosis'],
  properties: {
    status: { enum: ['fixed', 'stuck'] },
    diagnosis: { type: 'string', description: 'what was wrong and what was changed (fixed), or the root cause + what a human should look at (stuck)' },
    commit_sha: { type: 'string' },
    output: { type: 'string' },
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || 'fix'
}
function branchOf(ctx, issue) {
  return `fix/${issue.number}-${slugify(issue.title)}`
}

// ── Prompt builders ───────────────────────────────────────────────────────────
function repoNote(ctx) {
  return `The workflow operates from the main repository checkout at ${ctx.repo_root}. Each bug is delivered on its own branch cut from a freshly-pulled ${ctx.default_branch}; there are NO per-issue worktrees — the loop is strictly sequential (one agent touches the checkout at a time). Run all git/gh from ${ctx.repo_root}. Confirm the repo root with \`git -C ${ctx.repo_root} rev-parse --show-toplevel\`.`
}

// Project-specific review focus (from the profile). Empty ⇒ no extra text (generic /code-review).
function emphasisNote(ctx) {
  const e = (ctx.review_emphasis || '').trim()
  return e ? `\n\nProject-specific review emphasis (weigh heavily, in addition to the generic rubric):\n${e}` : ''
}

function setupPrompt() {
  return `You are the Setup step of the bug-fix-sprint workflow.

STEP 0 — load the project profile (this drives every later step; do it before anything else):
   - Determine the repo root: \`git rev-parse --show-toplevel\`.
   - Read \`<repo_root>/.claude/project-profile.json\`. If the file does NOT exist, return ok=false with error exactly "project-profile.json not found — run /init-workflows first" and mutate NOTHING. Do not fall back to defaults.
   - Parse it as JSON (it is pure JSON). You will echo its fields verbatim into the SETUP return (test_unit, test_full, build, lint, preflight, needs_infra, infra_up, migrate, secrets_note, infra_touched_hint, labels, stranded_label = labels.stranded, claude_md, adr_glob, design_globs, review_emphasis, models, trailer = models.trailer).

Then do the following, returning the SETUP schema. If any precondition fails, return ok=false with a precise \`error\` and DO NOT mutate anything.

1. Preconditions (fail fast — on any violation return ok=false with a precise \`error\` and mutate nothing):
   - Run EACH command in the profile's \`tooling.preflight\` array; every one must exit 0 (language/tooling version checks). On failure, error naming the command that failed.
   - \`gh auth status\` must pass and have BOTH the Issues and Pull-requests permissions (the workflow lists/edits issues and opens+merges PRs).
   - ONLY IF the profile's \`infra.needs_infra\` is true: \`docker info\` must succeed (Docker running).
   - We must be inside a git checkout: \`git rev-parse --show-toplevel\` must succeed; capture it as the absolute repo_root.
   - Working tree must be clean: \`git status --porcelain\` empty. On violation, error like "bug-fix-sprint requires a clean working tree; commit or stash first".
2. Derive identity:
   - owner_repo from \`gh repo view --json nameWithOwner -q .nameWithOwner\`.
   - default_branch from \`gh repo view --json defaultBranchRef -q .defaultBranchRef.name\` (e.g. main).
   - repo_root = \`git rev-parse --show-toplevel\` (absolute).
3. Sync to a clean default branch (the base every bug branch is cut from): \`git checkout <default_branch> && git pull --ff-only\`.
4. ONLY IF \`infra.needs_infra\` is true, bring up the shared infra stack once (some bugs need integration tests): run \`infra.infra_up\` then \`infra.migrate\` (skip either step whose profile value is null). If needs_infra is false, skip this step entirely.
5. If the profile's \`github.auto_create_stranded_label\` is true, best-effort ensure the stranded label exists: \`gh label create <labels.stranded> --force\` (ignore failure).
6. Return: ok=true, owner_repo, repo_root (absolute path), default_branch, and every profile field echoed (see STEP 0).`
}

function selectPrompt(ctx) {
  const restrict = EXPLICIT_NUMBERS.length
    ? `\n\nNOTE: the caller restricted this run to issue numbers ${JSON.stringify(EXPLICIT_NUMBERS)}. Still return the FULL list of open \`${WORK_LABEL}\` issues you find (the workflow applies the restriction) — do not pre-filter by that list.`
    : ''
  return `You are the Select step of the bug-fix-sprint workflow in ${ctx.owner_repo}.
${repoNote(ctx)}

1. List the open work items: \`gh issue list --repo ${ctx.owner_repo} --label ${WORK_LABEL} --state open --json number,title,url --limit 200\`.
2. For EACH such issue (call its number N), detect whether it already has an OPEN linked PR (so we don't double-deliver): \`gh pr list --repo ${ctx.owner_repo} --state open --search "N in:body" --json number\` with N substituted for the actual issue number (also treat a PR whose head branch is \`fix/N-...\` as linked). Set has_open_pr accordingly.
3. Return the SELECT schema: one entry per open \`${WORK_LABEL}\` issue with its number, title, url, and has_open_pr. Report the LIVE GitHub state — do not cache or guess. If there are no open \`${WORK_LABEL}\` issues, return an empty bugs[].${restrict}`
}

function plannerPrompt(ctx, issue, revision) {
  const base = `You are the PLANNER for bug #${issue.number} ("${issue.title}") in ${ctx.owner_repo}.
${repoNote(ctx)}

Goal: produce a focused, root-cause fix plan that the architect can approve and the implementer can build strictly to. Stay faithful to the design — read ${ctx.claude_md} and the relevant decision records (${ctx.adr_glob}) for anything the fix touches.${emphasisNote(ctx)}

Steps:
1. Read the issue: \`gh issue view ${issue.number} --repo ${ctx.owner_repo}\` (symptom, repro, expected vs. actual, any acceptance criteria).
2. Read ${ctx.claude_md}, the cited decision records/design docs, and the current code on ${ctx.default_branch} that the bug lives in. Find the ROOT CAUSE, not just the symptom — a bug fix must not paper over the underlying defect.
3. Decide whether reproducing/verifying the fix needs a running infrastructure stack (integration tests) → set infra_needed.
4. Draft the plan: the root cause, the minimal correct fix, concrete files to modify, and a regression test that FAILS before the fix and PASSES after. Reuse existing helpers and shared test utilities — do not reinvent them. Keep scope tight: fix the bug, do not refactor unrelated code.
5. WRITE the plan markdown to \`${ctx.repo_root}/.claude/plans/issue-${issue.number}.md\` (create the dir if needed). Overwrite on each revision.
6. List genuine design ambiguities as open_questions[] for the architect ([] if none).

Return the PLAN schema. plan_markdown must equal what you wrote to the file.`
  if (!revision) return base
  return `${base}

This is a REVISION. The architect returned REVISE on your previous plan. Address every item, then rewrite the plan file and return the updated PLAN.
Architect revisions: ${JSON.stringify(revision.revisions)}
Architect answers to your open questions: ${JSON.stringify(revision.answers)}`
}

function architectPrompt(ctx, issue, draft) {
  return `You are the ARCHITECT reviewing the fix plan for bug #${issue.number} ("${issue.title}") in ${ctx.owner_repo}.
${repoNote(ctx)}

Your job: judge whether this plan fixes the ROOT CAUSE correctly and minimally, strictly against ${ctx.claude_md} and the decision records (${ctx.adr_glob}). Decide all ambiguities AUTONOMOUSLY — never escalate to the user.${emphasisNote(ctx)}

Read ${ctx.claude_md} and any decision records the plan touches. Then evaluate the plan below.

Plan files_touched: ${JSON.stringify(draft.files_touched)}
infra_needed: ${draft.infra_needed}
open_questions: ${JSON.stringify(draft.open_questions)}
test_plan: ${draft.test_plan}

--- PLAN MARKDOWN ---
${draft.plan_markdown}
--- END PLAN ---

Return the ARCH schema:
- answers[]: one decisive answer per open_question (in order).
- verdict: APPROVED only if the plan addresses the real root cause, stays in-scope (no unrelated refactor), is faithful to the design, and its regression test would actually prove the fix. Otherwise REVISE.
- revisions[]: specific, actionable required changes if REVISE ([] if APPROVED).`
}

function implementerPrompt(ctx, issue) {
  const branch = branchOf(ctx, issue)
  return `Implement the fix for bug #${issue.number} ("${issue.title}"), strictly per the approved plan. Run at high reasoning effort.
${repoNote(ctx)}

Cut a fresh branch off the up-to-date default branch (so you build on everything already merged):
1. In ${ctx.repo_root}: \`git checkout ${ctx.default_branch} && git pull --ff-only && git checkout -b ${branch}\`. If ${branch} already exists from a prior pass, check it out and reuse it instead.
2. Confirm with \`git branch --show-current\` (must be ${branch}).

Then:
3. Read \`${ctx.repo_root}/.claude/plans/issue-${issue.number}.md\` and implement it EXACTLY — fix the root cause, add the regression test. Do not redesign or expand scope. Match surrounding code style and reuse existing helpers.
4. Run unit tests: \`${ctx.test_unit}\`. Fix until green.
5. Commit on ${branch} with a descriptive message ending with the trailer:
   ${ctx.trailer}
   Do NOT push, do NOT open a PR, do NOT merge — the workflow owns the merge.

Return the IMPL schema: status "ok" if committed with unit tests green, else "blocked" with \`error\`. Set infra_touched if the change affects infrastructure (${ctx.infra_touched_hint}).`
}

function fixPrompt(ctx, issue, problem, kind) {
  const branch = branchOf(ctx, issue)
  const detail = kind === 'review'
    ? `Fix these HIGH/MEDIUM review findings:\n${JSON.stringify(problem, null, 2)}`
    : `The test run failed. Fix the cause:\n${String(problem).slice(0, 4000)}`
  return `Continue implementing the fix for bug #${issue.number} on branch ${branch} in ${ctx.repo_root}. Run at high reasoning effort.
${repoNote(ctx)}

${detail}

Stay faithful to \`${ctx.repo_root}/.claude/plans/issue-${issue.number}.md\` and ${ctx.claude_md}. After fixing, run \`${ctx.test_unit}\`, then amend or add a commit on ${branch} (same trailer: ${ctx.trailer}). Do not push/PR/merge.
Return the IMPL schema (status "ok" only if committed and unit tests green).`
}

function reviewerPrompt(ctx, issue) {
  const branch = branchOf(ctx, issue)
  return `Review the diff for bug #${issue.number} on branch ${branch} in ${ctx.repo_root}, applying the /code-review rubric: correctness bugs, security issues, architectural violations against ${ctx.claude_md}/the decision records (${ctx.adr_glob}), and reuse/simplification.${emphasisNote(ctx)}
${repoNote(ctx)}

Get the diff with \`git -C ${ctx.repo_root} diff ${ctx.default_branch}...${branch}\` (and read changed files for context). Read \`${ctx.repo_root}/.claude/plans/issue-${issue.number}.md\` to check the fix matches the approved plan AND that it genuinely addresses the root cause (not just the symptom) with a regression test.

Return the REVIEW schema. Classify each finding HIGH / MEDIUM / LOW. HIGH+MEDIUM block the merge; LOW is reported but does not block. Do not inflate severity.`
}

function testPrompt(ctx, issue, infra, attempt) {
  const branch = branchOf(ctx, issue)
  const infraSteps = [
    ctx.infra_up ? `Ensure infra is up: \`${ctx.infra_up}\`${ctx.migrate ? ` and \`${ctx.migrate}\`` : ''}.` : null,
    `Run the FULL suite${ctx.secrets_note ? ` (${ctx.secrets_note} where the tests need it)` : ''}: \`${ctx.test_full}\`.`,
  ].filter(Boolean).map((s, i) => `   ${String.fromCharCode(97 + i)}. ${s}`).join('\n')
  const infraBlock = infra
    ? `This bug is infra_needed, so ALSO run the full suite against the shared infrastructure stack (the loop is sequential, so no lock is needed):
${infraSteps}`
    : `This bug is unit-only (infra_needed=false): run unit tests only.`
  return `Run the authoritative test gate for bug #${issue.number} on branch ${branch} in ${ctx.repo_root} (attempt ${attempt}). First ensure you are on ${branch}: \`git -C ${ctx.repo_root} checkout ${branch}\`.
${repoNote(ctx)}

1. Always run unit tests: \`${ctx.test_unit}\`.
2. ${infraBlock}

Return the TEST schema: passed=true only if every suite you ran is green. On failure put the failing-test tail in \`output\`. Set ran_integration accordingly.`
}

function mergePrompt(ctx, issue) {
  const branch = branchOf(ctx, issue)
  const title = `Fix #${issue.number}: ${issue.title.replace(/"/g, "'")}`
  return `Deliver bug #${issue.number} by squash-merging its branch ${branch} into ${ctx.default_branch} via a PR. This runs one bug at a time.
${repoNote(ctx)}

Operate in ${ctx.repo_root}:
1. Push the branch: \`git -C ${ctx.repo_root} push -u origin ${branch}\`.
2. Open the PR against the default branch. The body MUST contain \`Fixes #${issue.number}\` so the squash-merge onto ${ctx.default_branch} auto-closes the issue:
   \`gh pr create --repo ${ctx.owner_repo} --base ${ctx.default_branch} --head ${branch} --title "${title}" --body "Fixes #${issue.number}. Autonomous bug fix delivered by /bug-fix-sprint."\`
   Capture the PR url.
3. Squash-merge and delete the branch (remote + local): \`gh pr merge ${issue.number} --repo ${ctx.owner_repo} --squash --delete-branch\`. (If gh needs the PR number/url instead of the issue number, use the one from step 2.) If the merge reports a conflict or a not-mergeable state, return merged=false with the reason in \`error\` — do NOT force.
4. Sync local default branch for the next bug: \`git -C ${ctx.repo_root} checkout ${ctx.default_branch} && git -C ${ctx.repo_root} pull --ff-only\`.
5. Verify: \`gh issue view ${issue.number} --repo ${ctx.owner_repo} --json state -q .state\` should be CLOSED (Fixes #N closes it on the default-branch merge). Capture the squash merge commit: \`git -C ${ctx.repo_root} rev-parse HEAD\`.

Return the MERGE schema: merged=true only if the PR squash-merged into ${ctx.default_branch}; set pr_url, merge_commit, and issue_closed.`
}

function fixerPrompt(ctx, issue, stage, reason) {
  const branch = branchOf(ctx, issue)
  const isConflict = stage === 'merge'
  const task = isConflict
    ? `The squash-merge of ${branch} into ${ctx.default_branch} did not go through (${String(reason).slice(0, 300)}). Make this branch cleanly mergeable again:
   - In ${ctx.repo_root} on ${branch}, integrate the current ${ctx.default_branch} HEAD: \`git -C ${ctx.repo_root} fetch origin ${ctx.default_branch}\` then \`git -C ${ctx.repo_root} merge origin/${ctx.default_branch}\` (or rebase onto it), resolve EVERY conflict faithfully — preserve both the default branch's intent and this bug's fix — then commit on ${branch} (same commit trailer: ${ctx.trailer}).
   - Do NOT push, open a PR, or merge into ${ctx.default_branch}; you only make ${branch} mergeable — the workflow re-attempts the merge afterwards.`
    : `Bug #${issue.number} was stranded at the ${stage} stage: ${String(reason).slice(0, 500)}. Take one focused, high-effort pass at the root cause on its branch:
   - Work in ${ctx.repo_root} on ${branch} (\`git -C ${ctx.repo_root} checkout ${branch}\`). Read \`${ctx.repo_root}/.claude/plans/issue-${issue.number}.md\` and ${ctx.claude_md}; stay faithful to the plan and the decision records (${ctx.adr_glob}) — do not expand scope.
   - Fix the failing review findings / tests at their root cause. Run \`${ctx.test_unit}\` until green, then amend or add a commit on ${branch} (same commit trailer: ${ctx.trailer}). Do NOT push/PR/merge.`
  return `You are the ESCALATION FIXER for bug #${issue.number} ("${issue.title}") in ${ctx.owner_repo}. This is the LAST automated attempt before the bug is stranded for a human. Run at maximum reasoning effort.
${repoNote(ctx)}

You OWN this bug's branch (${branch}) for this pass. You must NEVER checkout, commit to, push, or merge into ${ctx.default_branch}, and you must NEVER close the GitHub issue — the workflow owns all merges and closures.

${task}

If you succeed (branch green / cleanly integrated and committed on ${branch}), return status="fixed" with a \`diagnosis\` of what was wrong and what you changed. The workflow re-enters this bug at the TEST gate (then the merge).

If you CANNOT fix it in this single pass, return status="stuck" with a precise \`diagnosis\` (root cause + what you tried + what a human should look at). Do NOT post a GitHub comment — the workflow's strand step records the diagnosis on the issue.
Return the FIXER schema.`
}

function strandPrompt(ctx, issue, stage, reason, diagnosis) {
  const branch = branchOf(ctx, issue)
  const body = `bug-fix-sprint could not deliver this bug (stranded at ${stage}: ${String(reason).slice(0, 400)}). ${diagnosis ? `Escalation fixer diagnosis: ${String(diagnosis).slice(0, 1200)}` : 'No escalation-fixer diagnosis available.'} The fix branch ${branch} is left in place for a human to finish.`
  return `Strand bug #${issue.number} — record why it could not be delivered, then leave the checkout on a clean ${ctx.default_branch} for the next bug.
${repoNote(ctx)}

1. Record the diagnosis on the issue: \`gh issue comment ${issue.number} --repo ${ctx.owner_repo} -b ${JSON.stringify(body)}\`.
2. Best-effort label it (ignore failure if the label does not exist): \`gh issue edit ${issue.number} --repo ${ctx.owner_repo} --add-label ${ctx.stranded_label}\`.
3. Do NOT delete or push branch ${branch} — the human resumes from it. Return the checkout to a clean default branch so the next bug starts fresh: \`git -C ${ctx.repo_root} checkout ${ctx.default_branch} && git -C ${ctx.repo_root} pull --ff-only\` (if the checkout fails because of leftover changes, \`git -C ${ctx.repo_root} checkout -- .\` first, then retry — never touch ${branch}'s commits).

Report what you did in one sentence.`
}

// ── Inner per-bug pipeline stages (return {issue, ...} or {issue, halt}) ────────
async function planStage(ctx, issue) {
  let draft = await agent(plannerPrompt(ctx, issue, null), { label: `plan:#${issue.number}`, phase: 'Plan', model: ctx.models.planner, agentType: 'Plan', schema: PLAN_SCHEMA })
  if (!draft) return { issue, halt: { stage: 'plan', reason: 'planner produced no output' } }

  let verdict = null
  for (let round = 1; round <= MAX_PLAN_ROUNDS; round++) {
    verdict = await agent(architectPrompt(ctx, issue, draft), { label: `arch:#${issue.number} r${round}`, phase: 'Plan', model: ctx.models.planner, schema: ARCH_SCHEMA })
    if (verdict && verdict.verdict === 'APPROVED') break
    if (round === MAX_PLAN_ROUNDS) break
    draft = await agent(plannerPrompt(ctx, issue, verdict), { label: `plan:#${issue.number} r${round + 1}`, phase: 'Plan', model: ctx.models.planner, agentType: 'Plan', schema: PLAN_SCHEMA })
    if (!draft) return { issue, halt: { stage: 'plan', reason: 'planner produced no output on revision' } }
  }
  if (!verdict || verdict.verdict !== 'APPROVED') {
    return { issue, halt: { stage: 'plan', reason: `plan not approved within ${MAX_PLAN_ROUNDS} rounds`, last_revisions: verdict ? verdict.revisions : null } }
  }
  return { issue, draft }
}

async function implementStage(prev, issue, ctx) {
  if (prev.halt) return prev
  const impl = await agent(implementerPrompt(ctx, issue), { label: `impl:#${issue.number}`, phase: 'Implement', model: ctx.models.impl, schema: IMPL_SCHEMA })
  if (!impl || impl.status !== 'ok') return { issue, halt: { stage: 'implement', reason: (impl && impl.error) || 'implementer failed', detail: impl } }
  return { issue, draft: prev.draft, impl }
}

async function reviewStage(prev, issue, ctx) {
  if (prev.halt) return prev
  let fixes = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const review = await agent(reviewerPrompt(ctx, issue), { label: `review:#${issue.number}`, phase: 'Review', model: ctx.models.review, schema: REVIEW_SCHEMA })
    const blocking = ((review && review.findings) || []).filter((f) => f.severity === 'HIGH' || f.severity === 'MEDIUM')
    if (!blocking.length) return { issue, draft: prev.draft, impl: prev.impl, review }
    if (fixes >= MAX_REVIEW_FIXES) return { issue, halt: { stage: 'review', reason: `HIGH/MEDIUM findings remain after ${MAX_REVIEW_FIXES} fix passes`, findings: blocking } }
    fixes++
    const fix = await agent(fixPrompt(ctx, issue, blocking, 'review'), { label: `fix:#${issue.number} r${fixes}`, phase: 'Review', model: ctx.models.impl, schema: IMPL_SCHEMA })
    if (!fix || fix.status !== 'ok') return { issue, halt: { stage: 'review', reason: 'fix agent failed addressing review findings', detail: fix } }
  }
}

async function testStage(prev, issue, ctx) {
  if (prev.halt) return { issue, status: 'halt', halt: prev.halt }
  // Gate integration/full-suite on BOTH the project profile (needs_infra) and this bug's plan.
  // needs_infra:false makes the full-suite path unreachable regardless of the planner's flag.
  const infra = !!(ctx.needs_infra && prev.draft && prev.draft.infra_needed)
  let attempt = 0
  let last = null
  while (attempt < MAX_TEST_ATTEMPTS) {
    attempt++
    last = await agent(testPrompt(ctx, issue, infra, attempt), { label: `test:#${issue.number} a${attempt}`, phase: 'Test', model: ctx.models.review, schema: TEST_SCHEMA })
    if (last && last.passed) return { issue, status: 'green', infra }
    if (attempt >= MAX_TEST_ATTEMPTS) break
    const fix = await agent(fixPrompt(ctx, issue, last ? last.output : 'no output', 'test'), { label: `fix:#${issue.number} t${attempt}`, phase: 'Test', model: ctx.models.impl, schema: IMPL_SCHEMA })
    if (!fix || fix.status !== 'ok') return { issue, status: 'halt', halt: { stage: 'test', reason: 'fix agent failed during test retry', detail: fix } }
  }
  return { issue, status: 'halt', halt: { stage: 'test', reason: `tests failing after ${MAX_TEST_ATTEMPTS} attempts`, output: last ? last.output : null, attempts: attempt } }
}

// Thin wrapper over the four inner stages. start='plan' runs the whole pipeline fresh;
// start='test' re-enters at the TEST gate only (post escalation-fix), reusing the known
// infra flag. Always returns testStage's normalized shape: {issue, status:'green'|'halt', infra, halt?}.
async function runPipeline(ctx, issue, start, infra) {
  if (start === 'test') {
    const prev = { issue, draft: { infra_needed: !!infra } }
    const t = await testStage(prev, issue, ctx)
    return { ...t, infra: !!infra }
  }
  const p = await planStage(ctx, issue)
  const iNeed = !!(ctx.needs_infra && p.draft && p.draft.infra_needed)
  const im = await implementStage(p, issue, ctx)
  const rv = await reviewStage(im, issue, ctx)
  const t = await testStage(rv, issue, ctx)
  return { ...t, infra: iNeed }
}

async function mergeStage(ctx, issue) {
  const m = await agent(mergePrompt(ctx, issue), { label: `merge:#${issue.number}`, phase: 'Merge', model: ctx.models.review, schema: MERGE_SCHEMA })
  return m
}

// ── Per-bug delivery (fail-soft: one escalation pass, then strand & continue) ──
async function deliverBug(ctx, issue) {
  let usedFixer = false
  const tryEscalate = async (stage, reason) => {
    if (usedFixer) return { status: 'stuck', diagnosis: 'escalation fixer already used its one pass for this bug' }
    usedFixer = true
    const res = await agent(fixerPrompt(ctx, issue, stage, reason), { label: `fix!:#${issue.number}`, phase: 'Escalate', model: ctx.models.impl, effort: 'max', schema: FIXER_SCHEMA })
    return res || { status: 'stuck', diagnosis: 'escalation fixer produced no output' }
  }
  const strand = async (stage, reason, diagnosis) => {
    await agent(strandPrompt(ctx, issue, stage, reason, diagnosis), { label: `strand:#${issue.number}`, phase: 'Escalate', model: ctx.models.review })
    log(`STRANDED #${issue.number} at ${stage}: ${reason}`)
    return { outcome: 'stranded', issue: issue.number, stage, reason, diagnosis: diagnosis || null }
  }

  // 1. Inner pipeline (plan → implement → review → test).
  let pipe = await runPipeline(ctx, issue, 'plan', false)
  const infra = !!pipe.infra
  if (pipe.status === 'halt') {
    const esc = await tryEscalate(pipe.halt.stage, pipe.halt.reason)
    if (esc.status !== 'fixed') return strand(pipe.halt.stage, pipe.halt.reason, esc.diagnosis)
    // Re-enter at the TEST gate once to confirm the fix holds.
    pipe = await runPipeline(ctx, issue, 'test', infra)
    if (pipe.status === 'halt') return strand(pipe.halt.stage, pipe.halt.reason, esc.diagnosis || 'escalation fix did not hold at re-test')
  }

  // 2. Merge lane (PR + squash-merge into the default branch; Fixes #N auto-closes).
  let merge = await mergeStage(ctx, issue)
  if (!merge || !merge.merged) {
    const reason = (merge && merge.error) || 'merge produced no output'
    const esc = await tryEscalate('merge', reason)
    if (esc.status === 'fixed') merge = await mergeStage(ctx, issue)
    if (!merge || !merge.merged) return strand('merge', (merge && merge.error) || reason, esc.diagnosis)
  }
  log(`Delivered #${issue.number} → ${ctx.default_branch} (${merge.merge_commit || '?'})${merge.pr_url ? ` via ${merge.pr_url}` : ''}`)
  return { outcome: 'delivered', issue: issue.number, pr_url: merge.pr_url || null, merge_commit: merge.merge_commit || null }
}

// ── Main ──────────────────────────────────────────────────────────────────────
phase('Setup')
const setup = await agent(setupPrompt(), { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA })
if (!setup || !setup.ok) {
  return { status: 'halted', stage: 'setup', error: setup ? setup.error : 'setup agent produced no output' }
}
const ctx = setup
// Resolve the work-source label now that the profile is loaded: explicit arg wins, else profile bug label.
WORK_LABEL = LABEL_TOKEN || (ctx.labels && ctx.labels.bug) || 'bug'
log(`bug-fix-sprint in ${ctx.owner_repo} (root ${ctx.repo_root}, default ${ctx.default_branch}), work label "${WORK_LABEL}"`)

phase('Select')
const selection = await agent(selectPrompt(ctx), { label: 'select', phase: 'Select', schema: SELECT_SCHEMA })
if (!selection) return { status: 'halted', stage: 'select', error: 'select agent produced no output' }

// Skip bugs with an open linked PR; restrict to explicit numbers if the caller gave any; sort ascending.
const skipped = []
let bugs = (selection.bugs || []).filter((b) => {
  if (b.has_open_pr) {
    skipped.push({ issue: b.number, reason: 'already has an open linked PR' })
    return false
  }
  return true
})
if (EXPLICIT_NUMBERS.length) {
  const want = new Set(EXPLICIT_NUMBERS)
  bugs = bugs.filter((b) => want.has(b.number))
}
bugs.sort((a, b) => a.number - b.number)

if (!bugs.length) {
  phase('Report')
  const msg = `No open "${WORK_LABEL}" issues to deliver${skipped.length ? ` (${skipped.length} skipped — open linked PR)` : ''}.`
  log(msg)
  return { status: 'noop', label: WORK_LABEL, message: msg, skipped }
}
log(`${bugs.length} bug(s) to deliver, ascending: ${bugs.map((b) => '#' + b.number).join(', ')}`)

// Sequential delivery — one bug at a time, each cut from a freshly-pulled default branch.
const delivered = []
const stranded = []
for (const bug of bugs) {
  log(`── Delivering #${bug.number}: ${bug.title} ──`)
  const res = await deliverBug(ctx, bug)
  if (res.outcome === 'delivered') delivered.push({ issue: res.issue, pr_url: res.pr_url, merge_commit: res.merge_commit })
  else stranded.push({ issue: res.issue, stage: res.stage, reason: res.reason, diagnosis: res.diagnosis })
}

phase('Report')
if (!stranded.length) {
  log(`bug-fix-sprint complete — ${delivered.length} delivered${skipped.length ? `, ${skipped.length} skipped` : ''}.`)
  return { status: 'complete', delivered, skipped, label: WORK_LABEL }
}
log(`bug-fix-sprint PARTIAL — ${delivered.length} delivered, ${stranded.length} stranded${skipped.length ? `, ${skipped.length} skipped` : ''}.`)
return {
  status: 'partial',
  label: WORK_LABEL,
  delivered,
  stranded,
  skipped,
  next: 'Between-runs handoff: for each stranded bug, read its gh comment/diagnosis, finish the fix on its fix/<N>-... branch, then open + squash-merge its PR (Fixes #N closes it). Re-run /bug-fix-sprint — already-closed/PR-linked bugs are skipped and the rest flow.',
}
