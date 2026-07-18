export const meta = {
  name: 'feature-sprint',
  description:
    'Autonomously deliver a milestone specs issue: read the GitHub sub-issue dependency graph once, then run a continuous rolling scheduler — each unblocked sub-issue goes plan (planner↔architect) → implement → review → test → serial merge into the mvpN milestone branch, merging and unblocking its dependents the moment it goes green. Failures fail soft: an async escalation fixer takes one pass, then the issue\'s subtree is stranded while the run keeps delivering everything else; only a broken mvpN (post-merge re-test failure) hard-stops. Stops at "mvpN ready" (or "partial"); the mvpN→main PR is the single human gate.',
  phases: [
    { title: 'Setup', detail: 'Read .claude/project-profile.json (hard-fail if absent), bring infra up + migrate if needs_infra, verify we\'re in a milestone worktree on a non-default branch, derive the milestone label from the specs issue' },
    { title: 'Graph', detail: 'Build the sub-issue dependency DAG once from the GitHub sub-issues + dependencies APIs; seed the in-memory closed set (no per-merge recompute)' },
    { title: 'Plan', detail: 'planner (Plan agent) ↔ architect loop, write .claude/plans/issue-N.md' },
    { title: 'Implement', detail: 'implementer (default agent) in a per-issue worktree, strictly per plan' },
    { title: 'Review', detail: 'reviewer agent (/code-review rubric); fix until HIGH+MEDIUM clean' },
    { title: 'Test', detail: 'unit suite always; full suite under an infra lock if infra_needed and needs_infra' },
    { title: 'Merge', detail: 'serial merge lane into the milestone branch (one writer), re-test, close the GitHub issue; the moment an issue closes its dependents are scheduled' },
    { title: 'Escalate', detail: 'async escalation fixer (max effort) takes one pass at a stranded issue — failing review/test fix or merge-conflict rebase — before its subtree is marked unreachable and the run keeps going' },
    { title: 'Milestone Review', detail: 'after a full clean drain: whole-diff dimensional fan-out (correctness/architecture/reuse/security); auto-fix HIGH+MEDIUM on the milestone branch until clean' },
    { title: 'Report', detail: 'milestone summary (ready), fail-soft partial report (delivered/stranded/unreachable), or milestone-broken halt' },
  ],
}

// ── Tunables (workflow tuning; NOT project-specific — per-project config lives in .claude/project-profile.json) ──
const CAP = 3                 // concurrent inner-pipeline slots in the rolling scheduler
const FIXER_CAP = 2           // concurrent async escalation-fixer slots (separate budget so a burst of strands can't starve pipeline slots)
const MAX_PLAN_ROUNDS = 6     // planner↔architect negotiation rounds
const MAX_REVIEW_FIXES = 3    // fix passes for HIGH/MEDIUM review findings
const MAX_TEST_ATTEMPTS = 3   // fix+retest attempts before halting an issue
const MAX_MILESTONE_FIX_ROUNDS = 3  // review→fix→re-review rounds at the milestone gate
const INFRA_LOCK = '.claude/.infra.lock'  // mkdir-based mutex over the single shared infra stack (only used when needs_infra)

const SPECS_ISSUE = String(args).replace(/[^0-9]/g, '')

// ── Structured-output schemas ─────────────────────────────────────────────────
// Setup echoes the live milestone identity PLUS every field parsed from .claude/project-profile.json,
// so that every downstream prompt/constant reads project-specific values from `ctx` (the .js never
// needs per-project edits). Nullable fields (build/lint/infra_up/migrate/secrets_note) carry no
// `type` so JSON null is accepted.
const SETUP_SCHEMA = {
  type: 'object',
  required: ['ok', 'owner_repo', 'milestone_label', 'milestone_branch', 'milestone_worktree', 'specs_title'],
  properties: {
    ok: { type: 'boolean' },
    owner_repo: { type: 'string', description: 'nameWithOwner of the repo (derived live via gh)' },
    milestone_label: { type: 'string', description: 'text extracted from the specs-issue title by github.milestone_title_regex; falls back to milestone_branch if no match' },
    milestone_branch: { type: 'string', description: 'the current branch (the milestone branch), e.g. mvp1 or release-2.1' },
    milestone_worktree: { type: 'string', description: 'absolute path of the current milestone worktree' },
    default_branch: { type: 'string', description: 'the repo default branch (the milestone PR base), e.g. main' },
    specs_title: { type: 'string' },
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
    stranded_label: { type: 'string', description: 'profile github.labels.stranded — best-effort label on a stranded issue' },
    milestone_branch_pattern: { type: 'string', description: 'profile github.milestone_branch_pattern (informational)' },
    milestone_title_regex: { type: 'string', description: 'profile github.milestone_title_regex — extracts milestone_label from the specs title' },
    claude_md: { type: 'string', description: 'profile repo.claude_md — path to the project guide' },
    adr_glob: { type: 'string', description: 'profile repo.adr_glob — glob for decision records' },
    design_globs: { type: 'array', items: { type: 'string' }, description: 'profile repo.design_globs' },
    review_emphasis: { type: 'string', description: 'profile review_emphasis — project-specific review focus injected into architect/reviewer/security prompts ("" ⇒ generic reviews)' },
    models: {
      type: 'object',
      description: 'profile models',
      properties: { planner: { type: 'string' }, impl: { type: 'string' }, review: { type: 'string' }, trailer: { type: 'string' } },
    },
    trailer: { type: 'string', description: 'profile models.trailer — the Co-Authored-By commit trailer' },
    error: { type: 'string' },
  },
}

const GRAPH_SCHEMA = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'state', 'blocked_by'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          state: { enum: ['open', 'closed'] },
          blocked_by: {
            type: 'array',
            items: {
              type: 'object',
              required: ['number', 'state'],
              properties: { number: { type: 'number' }, state: { enum: ['open', 'closed'] } },
            },
          },
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
    infra_needed: { type: 'boolean', description: 'true if verifying this issue requires the Docker stack (integration tests)' },
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
  required: ['merged', 'retest_passed', 'issue_closed'],
  properties: {
    merged: { type: 'boolean' },
    retest_passed: { type: 'boolean' },
    issue_closed: { type: 'boolean' },
    mvp_head: { type: 'string' },
    output: { type: 'string' },
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

// ── Prompt builders ───────────────────────────────────────────────────────────
const REPO_NOTE = `The workflow operates from the milestone worktree — the current checkout, on the milestone branch — which is the integration point. Per-issue worktrees live under .claude/worktrees/ relative to it. Use git rev-parse --show-toplevel to confirm the repo root.`

// Project-specific review focus (from the profile). Empty ⇒ no extra text (generic /code-review + /security-review).
function emphasisNote(ctx) {
  const e = (ctx.review_emphasis || '').trim()
  return e ? `\n\nProject-specific review emphasis (weigh heavily, in addition to the generic rubric):\n${e}` : ''
}

function setupPrompt() {
  return `You are the Setup step of the feature-sprint workflow. Specs issue: #${SPECS_ISSUE}.
${REPO_NOTE}

STEP 0 — load the project profile (this drives every later step; do it before anything else):
   - Determine the repo root: \`git rev-parse --show-toplevel\`.
   - Read \`<repo_root>/.claude/project-profile.json\`. If the file does NOT exist, return ok=false with error exactly "project-profile.json not found — run /init-workflows first" and mutate NOTHING. Do not fall back to defaults.
   - Parse it as JSON (it is pure JSON). You will echo its fields verbatim into the SETUP return (test_unit, test_full, build, lint, preflight, needs_infra, infra_up, migrate, secrets_note, infra_touched_hint, labels, stranded_label = labels.stranded, milestone_branch_pattern, milestone_title_regex, claude_md, adr_glob, design_globs, review_emphasis, models, trailer = models.trailer).

Then do the following, returning the SETUP schema. If any precondition fails, return ok=false with a precise \`error\` and DO NOT mutate anything.

1. Preconditions (fail fast — on any violation return ok=false with a precise \`error\` and mutate nothing):
   - Run EACH command in the profile's \`tooling.preflight\` array; every one must exit 0 (language/tooling version checks). On failure, error naming the command that failed.
   - \`gh auth status\` must pass and have the Issues permission.
   - ONLY IF the profile's \`infra.needs_infra\` is true: \`docker info\` must succeed (Docker running).
   - We must be inside a git worktree: \`git rev-parse --show-toplevel\` must succeed; capture it as the absolute milestone_worktree.
   - The current branch must NOT be the default branch: \`git branch --show-current\` must be non-empty and not \`main\` or \`master\` (a detached HEAD also fails, since --show-current is empty). On violation, error like "feature-sprint must run from a milestone worktree on a non-default branch; currently on <branch>".
   - Working tree must be clean: \`git status --porcelain\` empty.
2. Derive identity:
   - owner_repo from \`gh repo view --json nameWithOwner -q .nameWithOwner\`.
   - milestone_branch = the current branch (\`git branch --show-current\`).
   - milestone_worktree = \`git rev-parse --show-toplevel\` (absolute).
   - default_branch from \`gh repo view --json defaultBranchRef -q .defaultBranchRef.name\` (the milestone PR base, e.g. main).
   - Fetch the specs issue: \`gh issue view ${SPECS_ISSUE} --json title,number\`. Extract milestone_label by applying the profile's \`github.milestone_title_regex\` to the title and taking capture group 1 (e.g. regex \`^\\[(.+?)\\]\` on "[Release 2.1] …" → "Release 2.1"). If the regex does not match, set milestone_label = milestone_branch (do NOT fail).
3. ONLY IF \`infra.needs_infra\` is true, bring up the shared infra stack once: run \`infra.infra_up\` then \`infra.migrate\` (skip either step whose profile value is null). If needs_infra is false, skip this step entirely.
   - Optionally \`git worktree prune\` to clear stale per-issue worktrees from prior halted runs (harmless cleanup). Do NOT create or add the milestone worktree — it already exists (it is the current checkout).
4. If the profile's \`github.auto_create_stranded_label\` is true, best-effort ensure the stranded label exists: \`gh label create <labels.stranded> --force\` (ignore failure).
5. Return: ok=true, owner_repo, milestone_label, milestone_branch, milestone_worktree (absolute path), specs_title, and every profile field echoed (see STEP 0).`
}

function graphPrompt(ctx) {
  return `You are the Graph step of the feature-sprint workflow. Build the sub-issue dependency graph for specs issue #${SPECS_ISSUE} in ${ctx.owner_repo}.
${REPO_NOTE}

1. Enumerate sub-issues:
   \`gh api repos/${ctx.owner_repo}/issues/${SPECS_ISSUE}/sub_issues --jq '.[] | {number, title, state}'\`
   (state is "open" or "closed").
2. For EACH sub-issue M, resolve its blockers:
   \`gh api repos/${ctx.owner_repo}/issues/M/dependencies/blocked_by --jq '.[] | {number, state}'\`
   These calls may run for many issues — pace them to avoid REST rate limits.
3. Return the GRAPH schema: one entry per sub-issue with its number, title, state, and blocked_by list ({number, state} each). Report the LIVE GitHub state — do not cache or guess. The graph is read ONCE and seeds an in-memory closed set; the scheduler recomputes readiness in-process as issues close, so this snapshot must be accurate.`
}

function plannerPrompt(ctx, issue, revision) {
  const base = `You are the PLANNER for sub-issue #${issue.number} ("${issue.title}") of milestone ${ctx.milestone_branch} in ${ctx.owner_repo}.
${REPO_NOTE}

Goal: produce an implementation plan that the architect can approve and the implementer can build strictly to. Implementation MUST stay faithful to the design — read ${ctx.claude_md} and the relevant decision records (${ctx.adr_glob}) before planning.${emphasisNote(ctx)}

Steps:
1. Read the issue: \`gh issue view ${issue.number} --repo ${ctx.owner_repo}\` (scope, deliverables, acceptance criteria, dependencies).
2. Read ${ctx.claude_md}, the cited decision records/design docs, and the current code on the ${ctx.milestone_branch} branch that this issue touches (it builds on everything merged so far).
3. Decide whether verifying the issue's acceptance criteria needs a running infrastructure stack (integration tests) → set infra_needed.
4. Draft the plan: concrete files to create/modify, interfaces, and how the tests prove the acceptance criteria. Reuse existing helpers and shared test utilities — do not reinvent them.
5. WRITE the plan markdown to \`${ctx.milestone_worktree}/.claude/plans/issue-${issue.number}.md\` (create the dir if needed). Overwrite on each revision.
6. List genuine design ambiguities as open_questions[] for the architect ([] if none).

Return the PLAN schema. plan_markdown must equal what you wrote to the file.`
  if (!revision) return base
  return `${base}

This is a REVISION. The architect returned REVISE on your previous plan. Address every item, then rewrite the plan file and return the updated PLAN.
Architect revisions: ${JSON.stringify(revision.revisions)}
Architect answers to your open questions: ${JSON.stringify(revision.answers)}`
}

function architectPrompt(ctx, issue, draft) {
  return `You are the ARCHITECT reviewing the plan for sub-issue #${issue.number} ("${issue.title}") of milestone ${ctx.milestone_branch}.
${REPO_NOTE}

Your job: judge whether this plan is architecturally correct and complete FOR THIS ISSUE, strictly against ${ctx.claude_md} and the decision records (${ctx.adr_glob}). Decide all ambiguities AUTONOMOUSLY — never escalate to the user.${emphasisNote(ctx)}

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
- verdict: APPROVED only if the plan is correct, in-scope, faithful to the design, and its tests would prove the acceptance criteria. Otherwise REVISE.
- revisions[]: specific, actionable required changes if REVISE ([] if APPROVED).`
}

function implementerPrompt(ctx, issue, draft) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const branch = `${ctx.milestone_branch}-issue-${issue.number}`
  return `Implement sub-issue #${issue.number} ("${issue.title}") of milestone ${ctx.milestone_branch}, strictly per the approved plan. Run at high reasoning effort.
${REPO_NOTE}

Setup your isolated worktree (created off the CURRENT ${ctx.milestone_branch} HEAD so you see everything merged before you):
1. From the current milestone worktree (${ctx.milestone_worktree}, on branch ${ctx.milestone_branch}): \`git worktree add ${wt} -b ${branch} ${ctx.milestone_branch}\` (off the milestone branch HEAD). If ${wt} already exists, reuse it.
2. cd into ${wt} for all edits. Confirm with \`git rev-parse --show-toplevel\` and \`git branch --show-current\` (must be ${branch}).

Then:
3. Read \`${ctx.milestone_worktree}/.claude/plans/issue-${issue.number}.md\` and implement it EXACTLY. Do not redesign or expand scope. Match surrounding code style and reuse existing helpers.
4. Run unit tests in the worktree: \`${ctx.test_unit}\`. Fix until green.
5. Commit on ${branch} with a descriptive message ending with the trailer:
   ${ctx.trailer}
   Do NOT push, do NOT open a PR, do NOT merge — the workflow owns the merge.

Return the IMPL schema: status "ok" if committed with unit tests green, else "blocked" with \`error\`. Set infra_touched if the change affects infrastructure (${ctx.infra_touched_hint}).`
}

function fixPrompt(ctx, issue, problem, kind) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const branch = `${ctx.milestone_branch}-issue-${issue.number}`
  const detail = kind === 'review'
    ? `Fix these HIGH/MEDIUM review findings:\n${JSON.stringify(problem, null, 2)}`
    : `The test run failed. Fix the cause:\n${String(problem).slice(0, 4000)}`
  return `Continue implementing sub-issue #${issue.number} on branch ${branch} in worktree ${wt}. Run at high reasoning effort.
${REPO_NOTE}

${detail}

Stay faithful to \`${ctx.milestone_worktree}/.claude/plans/issue-${issue.number}.md\` and ${ctx.claude_md}. After fixing, run \`${ctx.test_unit}\` in the worktree, then amend or add a commit on ${branch} (same trailer: ${ctx.trailer}). Do not push/PR/merge.
Return the IMPL schema (status "ok" only if committed and unit tests green).`
}

function reviewerPrompt(ctx, issue) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const branch = `${ctx.milestone_branch}-issue-${issue.number}`
  return `Review the diff for sub-issue #${issue.number} on branch ${branch} (worktree ${wt}), applying the /code-review rubric: correctness bugs, security issues, architectural violations against ${ctx.claude_md}/the decision records (${ctx.adr_glob}), and reuse/simplification.${emphasisNote(ctx)}
${REPO_NOTE}

Get the diff with \`git -C ${wt} diff ${ctx.milestone_branch}...${branch}\` (and read changed files for context). Read \`${ctx.milestone_worktree}/.claude/plans/issue-${issue.number}.md\` to check the implementation matches the approved plan.

Return the REVIEW schema. Classify each finding HIGH / MEDIUM / LOW. HIGH+MEDIUM block the merge; LOW is deferred to the milestone PR — still report LOW findings, but do not inflate severity.`
}

function testPrompt(ctx, issue, infra, attempt) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const infraSteps = [
    `Acquire the lock: retry \`mkdir ${INFRA_LOCK}\` until it succeeds (mkdir is atomic; if it fails the lock is held — wait a few seconds and retry, up to ~5 min).`,
    ctx.infra_up ? `Ensure infra is up: \`${ctx.infra_up}\`${ctx.migrate ? ` and \`${ctx.migrate}\`` : ''}.` : null,
    `Run the FULL suite${ctx.secrets_note ? ` (${ctx.secrets_note} where the tests need it)` : ''}: \`${ctx.test_full}\`.`,
    `ALWAYS release the lock when done (success or failure): \`rmdir ${INFRA_LOCK}\`.`,
  ].filter(Boolean).map((s, i) => `   ${String.fromCharCode(97 + i)}. ${s}`).join('\n')
  const infraBlock = infra
    ? `This issue is infra_needed, so ALSO run the full suite against the single shared infrastructure stack, under a mutex (the stack is shared and has no per-worktree port remapping):
${infraSteps}`
    : `This issue is unit-only (infra_needed=false): run unit tests only.`
  return `Run the authoritative test gate for sub-issue #${issue.number} in worktree ${wt} (attempt ${attempt}).
${REPO_NOTE}

1. Always run unit tests: \`${ctx.test_unit}\` in ${wt}.
2. ${infraBlock}

Return the TEST schema: passed=true only if every suite you ran is green. On failure put the failing-test tail in \`output\`. Set ran_integration accordingly.`
}

function mergePrompt(ctx, issue) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const branch = `${ctx.milestone_branch}-issue-${issue.number}`
  return `Serial merge barrier for sub-issue #${issue.number} into ${ctx.milestone_branch}. This runs one issue at a time.
${REPO_NOTE}

Operate in the milestone worktree at ${ctx.milestone_worktree} (branch ${ctx.milestone_branch}):
1. \`git -C ${ctx.milestone_worktree} merge --no-ff ${branch} -m "Merge #${issue.number}: ${issue.title.replace(/"/g, "'")}"\`. If the merge conflicts, abort it (\`git merge --abort\`) and return merged=false with the conflict in \`output\` (do not force).
2. Fast re-test for undeclared coupling: \`${ctx.test_unit}\` in ${ctx.milestone_worktree}. If it fails, return merged=true, retest_passed=false, with the failure tail in \`output\` (do NOT close the issue).
3. Only if the merge AND re-test are green: close the GitHub issue: \`gh issue close ${issue.number} --repo ${ctx.owner_repo} -c "Delivered on ${ctx.milestone_branch} via feature-sprint."\`. This is the resume checkpoint.
4. Remove the per-issue worktree: \`git worktree remove ${wt} --force\` (always attempt cleanup).
5. Capture the merged HEAD: \`git -C ${ctx.milestone_worktree} rev-parse HEAD\`.

Return the MERGE schema.`
}

function fixerPrompt(ctx, issue, stage, reason) {
  const wt = `${ctx.milestone_worktree}/.claude/worktrees/issue-${issue.number}`
  const branch = `${ctx.milestone_branch}-issue-${issue.number}`
  const isConflict = stage === 'merge'
  const task = isConflict
    ? `The serial merge of ${branch} into ${ctx.milestone_branch} CONFLICTED (${String(reason).slice(0, 300)}). Make this branch cleanly mergeable again:
   - In ${wt} on ${branch}, integrate the current ${ctx.milestone_branch} HEAD: \`git -C ${wt} merge ${ctx.milestone_branch}\` (or rebase onto it), resolve EVERY conflict faithfully — preserve both the milestone's accumulated intent and this issue's change — then commit on ${branch} (same commit trailer: ${ctx.trailer}).
   - Do NOT merge into ${ctx.milestone_branch} and do NOT touch it. You only make ${branch} mergeable; the workflow's serial merge worker re-attempts the merge afterwards.`
    : `Sub-issue #${issue.number} was stranded at the ${stage} stage: ${String(reason).slice(0, 500)}. Take one focused, high-effort pass at the root cause on its branch:
   - Work in ${wt} on ${branch}. Read \`${ctx.milestone_worktree}/.claude/plans/issue-${issue.number}.md\` and ${ctx.claude_md}; stay faithful to the plan and the decision records (${ctx.adr_glob}) — do not expand scope.
   - Fix the failing review findings / tests. Run \`${ctx.test_unit}\` in ${wt} until green, then amend or add a commit on ${branch} (same commit trailer: ${ctx.trailer}). Do NOT push/PR/merge.`
  return `You are the ESCALATION FIXER for sub-issue #${issue.number} ("${issue.title}") of milestone ${ctx.milestone_branch} in ${ctx.owner_repo}. This is the LAST automated attempt before the issue is handed to the main agent between runs. Run at maximum reasoning effort.
${REPO_NOTE}

You OWN this issue's branch (${branch}) and worktree (${wt}) for this pass. You must NEVER checkout, commit to, or merge into ${ctx.milestone_branch}, and you must NEVER close the GitHub issue — the workflow owns all merges and closures.

${task}

If you succeed (branch green / cleanly integrated and committed on ${branch}), return status="fixed" with a \`diagnosis\` of what was wrong and what you changed. The workflow re-enters this issue at the TEST gate and then the serial merge.

If you CANNOT fix it in this single pass, return status="stuck" with a precise \`diagnosis\` (root cause + what you tried + what a human should look at). Before returning stuck, record the diagnosis on the issue so the between-runs main agent has it (the workflow script cannot run \`gh\` itself — you own this):
   - \`gh issue comment ${issue.number} --repo ${ctx.owner_repo} -b "feature-sprint escalation fixer could not resolve this (stranded at ${stage}). <your diagnosis>"\`
   - Best-effort label it: \`gh issue edit ${issue.number} --repo ${ctx.owner_repo} --add-label ${ctx.stranded_label}\` (ignore failure if the label does not exist).
Return the FIXER schema.`
}

// ── Milestone-review prompt builders (whole-diff gate, in-workflow) ───────────
// The four-dimension fan-out is a fixed mechanism; each rubric is generic and gets the project's
// decision-record path + review_emphasis injected at prompt-build time (see milestoneReviewPrompt).
const REVIEW_DIMENSIONS = [
  {
    key: 'correctness',
    title: 'Correctness',
    rubric: `   - Logic bugs, edge cases, error handling, race conditions, resource leaks.
   - Integration coupling ACROSS issues: interfaces that drifted between issues, contracts two issues implement inconsistently, ordering/lifecycle assumptions that only break once the merged whole runs together. This cross-issue view is the reason a milestone-level review exists.`,
  },
  {
    key: 'architecture',
    title: 'Architecture',
    rubric: `   - Faithfulness to the project guide and the project's decision records: module/layer boundaries, separation of concerns, dependency direction, and any explicit architectural constraints the project documents.
   - Violations of documented design boundaries or invariants. Read the relevant decision records (and any project-specific emphasis below) before judging.`,
  },
  {
    key: 'reuse',
    title: 'Reuse & simplification',
    rubric: `   - Duplicated logic that should reuse an existing helper, base class, shared module, or test utility instead of reimplementing it.
   - Needless complexity, dead code, or abstractions that could be simpler without losing behaviour.`,
  },
  {
    key: 'security',
    title: 'Security',
    rubric: `   - Apply the /security-review rubric: injection, authentication/authorization gaps, secret handling, unsafe deserialization, SSRF, path traversal, missing input validation, trust-boundary violations, unsafe subprocess/exec, and origin/CSRF checks on network entry points.
   - This is the dedicated security pass for the milestone — there is no other one in the pipeline. Be thorough.`,
  },
]

function milestoneReviewPrompt(ctx, d) {
  const wt = ctx.milestone_worktree
  return `You are the ${d.title} reviewer at the MILESTONE gate for ${ctx.milestone_label} (branch ${ctx.milestone_branch}) in ${ctx.owner_repo}. This is the final automated review over the WHOLE milestone diff before the human PR — review the cumulative change, paying special attention to issues that only surface when every merged sub-issue runs together.
${REPO_NOTE}

Project context for this review: the project guide is ${ctx.claude_md}; the decision records are at ${ctx.adr_glob}.${emphasisNote(ctx)}

1. Refresh the base: \`git -C ${wt} fetch origin ${ctx.default_branch || 'main'} --quiet\`.
2. Get the milestone diff: \`git -C ${wt} diff origin/${ctx.default_branch || 'main'}...HEAD\` (and read the changed files for full context — the diff alone is not enough).
3. Review ONLY for the ${d.title} dimension:
${d.rubric}

Return the REVIEW schema. Classify each finding HIGH / MEDIUM / LOW honestly — do not inflate severity. HIGH+MEDIUM are auto-fixed on ${ctx.milestone_branch}; LOW is reported but deferred to the human PR. Report findings ONLY for the ${d.title} dimension so you don't duplicate the other reviewers.`
}

function milestoneFixPrompt(ctx, blocking) {
  const wt = ctx.milestone_worktree
  return `Fix these HIGH/MEDIUM findings from the milestone review, committing directly on the milestone branch ${ctx.milestone_branch} in the milestone worktree ${wt}. Run at high reasoning effort.
${REPO_NOTE}

Findings to fix (pooled from the correctness / architecture / reuse / security reviewers over the whole ${ctx.milestone_branch} diff):
${JSON.stringify(blocking, null, 2)}

Rules:
- Work in ${wt} on branch ${ctx.milestone_branch} (the integration worktree, NOT a per-issue worktree). Confirm with \`git -C ${wt} branch --show-current\`.
- Fix every HIGH and MEDIUM finding. Stay faithful to ${ctx.claude_md} and the decision records (${ctx.adr_glob}); do not expand scope or redesign beyond what each finding requires.
- Run \`${ctx.test_unit}\` in ${wt} and fix until green.
- Commit on ${ctx.milestone_branch} with a descriptive message ending with the trailer:
  ${ctx.trailer}
  Do NOT push, open a PR, or merge — the human gate owns the PR.

Return the IMPL schema: status "ok" only if all findings are addressed, committed, and unit tests pass. Set infra_touched if any fix affects infrastructure (${ctx.infra_touched_hint}).`
}

function milestoneRetestPrompt(ctx, infra) {
  const wt = ctx.milestone_worktree
  const infraSteps = [
    `Acquire the lock: retry \`mkdir ${INFRA_LOCK}\` until it succeeds (mkdir is atomic; wait a few seconds and retry, up to ~5 min).`,
    ctx.infra_up ? `Ensure infra is up: \`${ctx.infra_up}\`${ctx.migrate ? ` and \`${ctx.migrate}\`` : ''}.` : null,
    `Run the FULL suite${ctx.secrets_note ? ` (${ctx.secrets_note} where the tests need it)` : ''}: \`${ctx.test_full}\`.`,
    `ALWAYS release the lock when done (success or failure): \`rmdir ${INFRA_LOCK}\`.`,
  ].filter(Boolean).map((s, i) => `   ${String.fromCharCode(97 + i)}. ${s}`).join('\n')
  const infraBlock = infra
    ? `This milestone included infra_needed issues, so ALSO run the full suite against the single shared infrastructure stack under the mutex:
${infraSteps}`
    : `This milestone had no infra_needed issues: run unit only.`
  return `Re-test the milestone branch ${ctx.milestone_branch} in worktree ${wt} after milestone-review fixes.
${REPO_NOTE}

1. Always: \`${ctx.test_unit}\` in ${wt}.
2. ${infraBlock}

Return the TEST schema: passed=true only if every suite you ran is green. On failure put the failing-test tail in \`output\`. Set ran_integration accordingly.`
}

// ── Graph helpers (pure JS over the single graph snapshot) ────────────────────
function openIssues(graph) {
  return graph.issues.filter((i) => i.state === 'open')
}
// Transitive reverse-dependency closure: every sub-issue that (directly or indirectly)
// is blocked_by one of `roots`. The roots themselves are NOT included — used to mark the
// subtree downstream of a stranded issue `unreachable`.
function dependentsOf(graph, roots) {
  const rev = new Map()  // blocker number → [dependent numbers]
  for (const i of graph.issues) {
    for (const b of i.blocked_by) {
      if (!rev.has(b.number)) rev.set(b.number, [])
      rev.get(b.number).push(i.number)
    }
  }
  const out = new Set()
  const stack = [...roots]
  while (stack.length) {
    const n = stack.pop()
    for (const d of rev.get(n) || []) {
      if (!out.has(d)) {
        out.add(d)
        stack.push(d)
      }
    }
  }
  return out
}

// ── Inner per-issue pipeline stages (return {issue, ...} or {issue, halt}) ─────
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
  const impl = await agent(implementerPrompt(ctx, issue, prev.draft), { label: `impl:#${issue.number}`, phase: 'Implement', model: ctx.models.impl, schema: IMPL_SCHEMA })
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
  // Gate integration/full-suite on BOTH the project profile (needs_infra) and this issue's plan.
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

// ── Milestone review (in-workflow whole-diff gate; runs after all issues merge) ─
function dedupeFindings(findings) {
  const seen = new Set()
  const out = []
  for (const f of findings) {
    const key = `${f.file}:${f.line || 0}:${f.severity}:${(f.description || '').slice(0, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

async function milestoneReviewStage(ctx, milestoneInfra) {
  let deferredLow = []
  for (let round = 1; round <= MAX_MILESTONE_FIX_ROUNDS; round++) {
    // Fan out the four review dimensions over the whole milestone diff, in parallel.
    const reviews = await parallel(
      REVIEW_DIMENSIONS.map((d) => () =>
        agent(milestoneReviewPrompt(ctx, d), { label: `mreview:${d.key} r${round}`, phase: 'Milestone Review', model: ctx.models.planner, schema: REVIEW_SCHEMA }),
      ),
    )
    // parallel() preserves order and yields null on failure, so the index aligns with REVIEW_DIMENSIONS.
    const all = reviews.flatMap((r, i) => ((r && r.findings) || []).map((f) => ({ ...f, dimension: REVIEW_DIMENSIONS[i].key })))
    const deduped = dedupeFindings(all)
    const blocking = deduped.filter((f) => f.severity === 'HIGH' || f.severity === 'MEDIUM')
    deferredLow = deduped.filter((f) => f.severity === 'LOW')

    if (!blocking.length) {
      log(`Milestone review clean (round ${round}); ${deferredLow.length} LOW finding(s) deferred to the human PR.`)
      return { ok: true, deferred_low: deferredLow }
    }
    if (round >= MAX_MILESTONE_FIX_ROUNDS) {
      return { ok: false, halt: { stage: 'milestone-review', reason: `HIGH/MEDIUM findings remain after ${MAX_MILESTONE_FIX_ROUNDS} review rounds`, findings: blocking } }
    }

    log(`Milestone review round ${round}: ${blocking.length} HIGH/MEDIUM finding(s) — fixing on ${ctx.milestone_branch}.`)
    const fix = await agent(milestoneFixPrompt(ctx, blocking), { label: `mfix r${round}`, phase: 'Milestone Review', model: ctx.models.impl, schema: IMPL_SCHEMA })
    if (!fix || fix.status !== 'ok') {
      return { ok: false, halt: { stage: 'milestone-review', reason: 'milestone fix agent failed', detail: fix, findings: blocking } }
    }
    const retest = await agent(milestoneRetestPrompt(ctx, milestoneInfra), { label: `mretest r${round}`, phase: 'Milestone Review', model: ctx.models.review, schema: TEST_SCHEMA })
    if (!retest || !retest.passed) {
      return { ok: false, halt: { stage: 'milestone-review', reason: 'tests failed after milestone-review fix', output: retest ? retest.output : null } }
    }
  }
  // Unreachable: the loop returns on clean, on cap, or on fix/test failure.
  return { ok: false, halt: { stage: 'milestone-review', reason: 'milestone review loop exhausted unexpectedly' } }
}

// ── Continuous rolling scheduler ──────────────────────────────────────────────
// Replaces the wave loop. A single-threaded loop races ONE Promise.race over a Map of
// tagged in-flight promises (pipeline / fixer / merge lanes). Each turn: await the race,
// delete the winner, mutate the in-memory sets, then fill() re-derives readiness and
// refills every lane — so a merge-close and the scheduling of the newly-unblocked
// dependent happen on the SAME synchronous path (zero wave latency, no missed wakeups).
//
// Invariants:
//   • mvpN has exactly one writer — the serial merge lane (mergeBusy enforces ≤1).
//   • Issue closure has exactly one writer — the merge lane — so the in-memory `closed`
//     set can't drift from GitHub during a run. GitHub closed-state stays the sole
//     cross-run resume checkpoint.
//   • The escalation fixer never writes mvpN and never closes an issue.
//   • Drain-and-merge iff mvpN is healthy; a broken mvpN (post-merge re-test failure)
//     hard-stops and merges nothing further.
async function schedule(ctx, graph, closed) {
  const inFlight = new Set()      // issues currently in an inner pipeline
  const awaitingMerge = new Set() // green issues queued for / undergoing merge
  const held = new Set()          // stranded issues queued for / undergoing the fixer
  const escalated = new Set()     // issues that have used their one fixer pass (per-issue bound)
  const strandedNums = new Set()  // terminally stranded issue numbers
  const unreachable = new Set()   // subtree downstream of a stranded issue
  const infraByIssue = new Map()  // issue number → infra_needed (for TEST re-entry + milestone retest)

  const greenQueue = []           // {issue, infra} awaiting the serial merge lane
  const fixerQueue = []           // {issue, stage, reason} awaiting a fixer slot
  const resumeQueue = []          // issue objects fixed by the fixer, to re-enter at TEST

  const delivered = []
  const stranded = []             // {issue, stage, reason, branch, diagnosis}
  let milestoneInfra = false
  let hardStop = null

  const pending = new Map()       // id → promise resolving to a tagged {kind, id, ...}
  let idc = 0
  const nextId = () => ++idc
  let pipeCount = 0
  let fixerCount = 0
  let mergeBusy = false

  const branchOf = (n) => `${ctx.milestone_branch}-issue-${n}`

  function isReady(i) {
    return (
      i.state === 'open' &&
      !closed.has(i.number) &&
      !inFlight.has(i.number) &&
      !awaitingMerge.has(i.number) &&
      !held.has(i.number) &&
      !strandedNums.has(i.number) &&
      !unreachable.has(i.number) &&
      i.blocked_by.every((b) => closed.has(b.number))
    )
  }

  function terminal(issue, stage, reason, diagnosis) {
    held.delete(issue.number)
    strandedNums.add(issue.number)
    stranded.push({ issue: issue.number, stage, reason, branch: branchOf(issue.number), diagnosis: diagnosis || null })
    const subtree = dependentsOf(graph, [issue.number])
    for (const d of subtree) unreachable.add(d)
    log(`STRANDED #${issue.number} at ${stage}: ${reason}${subtree.size ? ` — subtree unreachable: ${[...subtree].map((n) => '#' + n).join(', ')}` : ''}`)
  }

  // An inner-pipeline halt or a merge conflict strands an issue. First strand → one fixer
  // pass; a second strand (or already-escalated) is terminal.
  function strand(issue, stage, reason) {
    if (escalated.has(issue.number)) {
      terminal(issue, stage, reason, null)
      return
    }
    escalated.add(issue.number)
    held.add(issue.number)
    fixerQueue.push({ issue, stage, reason })
  }

  function fill() {
    if (hardStop) return
    // Merge lane — serial, ≤1.
    if (!mergeBusy && greenQueue.length) {
      const g = greenQueue.shift()
      mergeBusy = true
      const id = nextId()
      pending.set(id, agent(mergePrompt(ctx, g.issue), { label: `merge:#${g.issue.number}`, phase: 'Merge', model: ctx.models.review, schema: MERGE_SCHEMA }).then((m) => ({ kind: 'merge', id, g, m })))
    }
    // Fixer lane — up to FIXER_CAP.
    while (fixerCount < FIXER_CAP && fixerQueue.length) {
      const f = fixerQueue.shift()
      fixerCount++
      const id = nextId()
      pending.set(id, agent(fixerPrompt(ctx, f.issue, f.stage, f.reason), { label: `fix!:#${f.issue.number}`, phase: 'Escalate', model: ctx.models.impl, effort: 'max', schema: FIXER_SCHEMA }).then((res) => ({ kind: 'fixer', id, issue: f.issue, stage: f.stage, reason: f.reason, res })))
    }
    // Pipeline lane — up to CAP; resume-at-TEST entries prioritized over fresh ready issues.
    while (pipeCount < CAP) {
      let issue
      let start
      if (resumeQueue.length) {
        issue = resumeQueue.shift()
        start = 'test'
      } else {
        issue = graph.issues.find(isReady)
        if (!issue) break
        start = 'plan'
      }
      inFlight.add(issue.number)
      pipeCount++
      const id = nextId()
      const infra = infraByIssue.get(issue.number) || false
      pending.set(id, runPipeline(ctx, issue, start, infra).then((r) => ({ kind: 'pipeline', id, ...r })))
    }
  }

  fill()
  while (pending.size > 0) {
    const winner = await Promise.race([...pending.values()])
    pending.delete(winner.id)

    if (winner.kind === 'pipeline') {
      pipeCount--
      const issue = winner.issue
      inFlight.delete(issue.number)
      infraByIssue.set(issue.number, !!winner.infra)
      if (winner.status === 'green') {
        awaitingMerge.add(issue.number)
        greenQueue.push({ issue, infra: !!winner.infra })
      } else {
        const h = winner.halt || { stage: 'unknown', reason: 'inner pipeline returned null (agent skipped or died)' }
        strand(issue, h.stage, h.reason)
      }
    } else if (winner.kind === 'fixer') {
      fixerCount--
      const { issue, stage, reason, res } = winner
      if (res && res.status === 'fixed') {
        held.delete(issue.number)
        resumeQueue.push(issue)  // re-enter at TEST → merge
        log(`Escalation fixer resolved #${issue.number} (was ${stage}); re-entering at TEST.`)
      } else {
        terminal(issue, stage, reason, res ? res.diagnosis : null)
      }
    } else if (winner.kind === 'merge') {
      mergeBusy = false
      const { g, m } = winner
      awaitingMerge.delete(g.issue.number)
      if (!m || !m.merged) {
        // Merge conflict (or merge agent failure) → strand so the fixer can rebase onto current mvpN.
        strand(g.issue, 'merge', m && m.output ? `merge conflict: ${String(m.output).slice(0, 200)}` : 'merge agent failed or produced no output')
      } else if (!m.retest_passed) {
        // Broken mvpN — HARD STOP. Merging onto a broken base cascades; stop the whole run.
        hardStop = { issue: g.issue.number, mvp_head: m.mvp_head || null, output: m.output || null }
      } else {
        // Merged + re-test green → delivered. The merge lane is the sole writer of `closed`.
        closed.add(g.issue.number)
        delivered.push(g.issue.number)
        if (g.infra) milestoneInfra = true
        if (!m.issue_closed) {
          log(`WARNING: #${g.issue.number} merged and green on ${ctx.milestone_branch} but GitHub close was unconfirmed; treating as delivered (a re-run may re-surface it as open).`)
        }
        log(`Merged #${g.issue.number} into ${ctx.milestone_branch} (HEAD ${m.mvp_head || '?'}); dependents scheduled this iteration.`)
      }
    }

    if (hardStop) break  // drop greenQueue, stop scheduling; isolated in-flight work unwinds (re-runs next invocation)
    fill()
  }

  return { hardStop, delivered, stranded, unreachable, milestoneInfra }
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!SPECS_ISSUE) {
  return { status: 'halted', stage: 'setup', error: 'No specs issue number provided. Invoke as /feature-sprint <issue#>.' }
}

phase('Setup')
const setup = await agent(setupPrompt(), { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA })
if (!setup || !setup.ok) {
  return { status: 'halted', stage: 'setup', error: setup ? setup.error : 'setup agent produced no output' }
}
const ctx = setup
log(`Milestone ${ctx.milestone_label} on branch ${ctx.milestone_branch} (specs #${SPECS_ISSUE}) — worktree ${ctx.milestone_worktree}`)

phase('Graph')
const graph = await agent(graphPrompt(ctx), { label: 'graph', phase: 'Graph', schema: GRAPH_SCHEMA })
if (!graph) return { status: 'halted', stage: 'graph', error: 'graph agent produced no output', milestone: ctx.milestone_branch }
const preclosed = graph.issues.filter((i) => i.state === 'closed').map((i) => i.number)
log(`${graph.issues.length} sub-issues (${preclosed.length} already closed — will be skipped on resume)`)

// Seed the in-memory `closed` set ONCE from the graph snapshot: every sub-issue GitHub reports
// closed, plus any closed blocker (blockers may be issues outside this milestone). From here the
// merge lane is the sole writer of `closed`, so it can't drift from GitHub during the run.
const closed = new Set()
for (const i of graph.issues) {
  if (i.state === 'closed') closed.add(i.number)
  for (const b of i.blocked_by) if (b.state === 'closed') closed.add(b.number)
}

// Run the continuous rolling scheduler to exhaustion (graceful wind-down) or a hard-stop.
const { hardStop, delivered, stranded, unreachable, milestoneInfra } = await schedule(ctx, graph, closed)

// Hard-stop: a post-merge re-test failure broke mvpN. Merging onto a broken base cascades, so
// the whole run halts here — the only whole-run halt in the fail-soft model.
if (hardStop) {
  phase('Report')
  log(`HALT: mvpN broken by #${hardStop.issue} (post-merge re-test failed). ${delivered.length} issues safely delivered before it.`)
  return {
    status: 'halted',
    stage: 'merge-retest',
    failed_issue: hardStop.issue,
    mvpN_head: hardStop.mvp_head,
    output: hardStop.output,
    milestone: ctx.milestone_branch,
    milestone_worktree: ctx.milestone_worktree,
    closed_issues: delivered,
  }
}

// Any open sub-issue that is neither delivered, stranded, nor unreachable is an unsatisfiable
// blocker (dependency cycle, or a blocker that never closed this run). Fold it into `stranded`
// with a distinct reason — consistent with fail-soft; the main agent handles it between runs.
const strandedNums = new Set(stranded.map((s) => s.issue))
for (const i of graph.issues) {
  if (i.state === 'open' && !closed.has(i.number) && !strandedNums.has(i.number) && !unreachable.has(i.number)) {
    stranded.push({ issue: i.number, stage: 'graph', reason: 'unsatisfiable blocker (dependency cycle or a blocker that never closed this run)', branch: `${ctx.milestone_branch}-issue-${i.number}`, diagnosis: null })
  }
}

const unreachableArr = [...unreachable]
const fullCleanDrain = graph.issues.every((i) => closed.has(i.number))

// Partial delivery (something stranded/unreachable) — skip the milestone review (the diff is
// incomplete) and hand the stranded residue to the main agent between runs.
if (!fullCleanDrain) {
  phase('Report')
  log(`${ctx.milestone_branch} PARTIAL — ${delivered.length} delivered, ${stranded.length} stranded, ${unreachableArr.length} unreachable. Milestone review skipped (partial diff).`)
  return {
    status: 'partial',
    milestone: ctx.milestone_branch,
    milestone_worktree: ctx.milestone_worktree,
    delivered,
    stranded,
    unreachable: unreachableArr,
    skipped_preclosed: preclosed,
    next: 'Between-runs handoff: for each stranded issue, read its gh comment/diagnosis, fix it on its branch, then merge + close it (the workflow owns closure during a run, but between runs the main agent may). Re-run /feature-sprint <specs#> — already-closed issues are skipped and each newly-unblocked subtree flows. Milestone review runs only after a full clean drain.',
  }
}

// Full clean drain — every sub-issue closed. Run the whole-diff milestone review + fix loop.
phase('Milestone Review')
const mreview = await milestoneReviewStage(ctx, milestoneInfra)
if (!mreview.ok) {
  const h = mreview.halt
  log(`HALT at milestone review: ${h.reason}`)
  return { status: 'halted', stage: 'milestone-review', detail: h, milestone: ctx.milestone_branch, milestone_worktree: ctx.milestone_worktree, closed_issues: delivered }
}

phase('Report')
log(`${ctx.milestone_branch} ready — ${delivered.length} issues delivered, milestone review clean (${mreview.deferred_low.length} LOW deferred). Next: spec-acceptance check + /pr from the main loop.`)
return {
  status: 'ready',
  milestone: ctx.milestone_branch,
  milestone_worktree: ctx.milestone_worktree,
  issues_delivered: delivered,
  skipped_preclosed: preclosed,
  deferred_low: mreview.deferred_low,
  next: 'Milestone gate (main loop): code-review (high) and security-review already ran in-workflow with HIGH+MEDIUM fixed on the branch. Verify the specs issue acceptance criteria, optionally run /code-review ultra for the cloud multi-agent pass, then /pr for mvpN → main. LOW findings in deferred_low ride along to the human PR.',
}
