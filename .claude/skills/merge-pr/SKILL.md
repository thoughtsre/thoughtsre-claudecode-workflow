---
name: merge-pr
description: Merge a GitHub pull request (merge commit by default, or squash via `--squash`), ensuring linked issues will auto-close on merge.
#model: sonnet
---

# Merge Pull Request

Merge a GitHub pull request using a merge commit by default, with squash available as an opt-in via `--squash` (never rebase), ensuring linked issues will auto-close on merge.

## Arguments

- Optional: PR number (e.g., `/merge-pr 42`)
- If not specified, detects the PR for the current branch
- Optional: `--squash` flag (e.g., `/merge-pr 42 --squash` or `/merge-pr --squash`) — when present, the PR is merged with `gh pr merge <number> --squash` (gh uses the PR title + body as the squash commit message); when absent, the default is a merge commit. The flag can be combined with a PR number in any order.

## Process

1. **Identify the PR**:
   - If a PR number is provided as an argument, use it directly
   - Otherwise, run `gh pr view --json number,url` on the current branch to detect the associated PR
   - If no PR is found, abort with a clear message

2. **Fetch PR details**:
   - Run `gh pr view <number> --json number,title,body,state,url,headRefName,statusCheckRollup,reviewDecision,commits`
   - If the PR is not `OPEN`, abort (report if it's already merged or closed)

3. **Issue-linking check**:
   - Parse the PR body for existing `Closes #N`, `Fixes #N`, or `Resolves #N` references (case-insensitive)
   - Also scan for issue references in:
     - **Branch name**: extract issue numbers (e.g., `fix/123-bug`, `feat/gh-45`, `issue-99`)
     - **Commit messages**: from the commits field, scan for `#N`, `fixes #N`, `closes #N`, `resolves #N`
   - Deduplicate all found issue numbers
   - For each discovered issue not already tagged in the body, run `gh issue view <number> --json title,state` to verify it exists and is open
   - If there are verified open issues found in branch/commits but **missing** from the PR body:
     - Show the user which issues were found and ask for confirmation to add them
     - If confirmed, append `Closes #N` lines to the PR body using `gh pr edit <number> --body` (preserve existing body content)
   - If no issues are found anywhere, proceed without tags

4. **Pre-merge checks**:
   - Check `statusCheckRollup` for CI status:
     - If any checks are failing or pending, warn the user and ask whether to proceed
   - Check `reviewDecision`:
     - If not `APPROVED` (e.g., `REVIEW_REQUIRED`, `CHANGES_REQUESTED`), warn the user and ask whether to proceed

5. **Merge the PR**:
   - If the `--squash` flag was passed, run `gh pr merge <number> --squash` (gh uses the PR title + body as the squash commit message)
   - Otherwise, run `gh pr merge <number> --merge` (merge commit, the default)
   - Do NOT pass `--delete-branch` unless the user explicitly asked to delete the branch

6. **Report result**:
   - Confirm the merge was successful, noting whether it was a merge commit or a squash
   - Show the PR URL
   - List any issues that should auto-close from the `Closes #N` tags

## Rules

- Default to `--merge`; only use `--squash` when the `--squash` flag is explicitly provided; NEVER use `--rebase`
- NEVER delete the remote branch unless the user explicitly requests it
- Always warn the user before merging if CI checks are failing or reviews are missing
- Each issue gets its own `Closes #N` line — do not combine them
- Only add issue tags for issues that were verified as open via `gh issue view`
- Preserve the entire existing PR body when appending `Closes` lines
