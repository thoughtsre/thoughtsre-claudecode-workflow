---
name: pr
description: Create a pull request for the current branch, linking and auto-closing related GitHub issues.
#model: sonnet
---

# Create Pull Request

Create a pull request for the current branch, linking and auto-closing related GitHub issues.

## Arguments

- Optional: base branch name (e.g., `/pr develop`)
- If not specified, defaults to main or master (auto-detected)

## Process

1. Run `git branch --show-current` to get the current branch
2. Determine base branch:
   - Use the provided argument if specified
   - Otherwise, detect main or master
3. Check if the branch is pushed with `git rev-parse --abbrev-ref @{upstream}`
   - If not pushed, push with `-u origin <branch>` first
4. Run `git log <base>..HEAD --oneline` to see all commits in this branch
5. Run `git diff <base>..HEAD --stat` to see summary of changes
6. **Collect related GitHub issues** from all of these sources:
   - **Branch name**: extract issue numbers (e.g., `fix/123-bug`, `feat/gh-45`, `issue-99`)
   - **Commit messages**: scan for `#N`, `fixes #N`, `closes #N`, `resolves #N` patterns
   - **Session context**: review the current conversation for any GitHub issue numbers or URLs discussed (e.g., `#123`, `org/repo#45`, `github.com/.../issues/78`)
   - Deduplicate all collected issue numbers
7. For each discovered issue, run `gh issue view <number> --json title,state` to verify it exists and is open. Drop any that don't exist or are already closed.
8. Create PR using `gh pr create --base <base>` with:
   - A concise title (under 70 chars) based on the changes
   - A body following the format below, including `Closes #N` lines for every verified open issue
   - Use HEREDOC for the body

## PR Body Format

```
## Summary
- <bullet points describing changes>

## Test plan
- <how to test the changes>

Closes #<issue1>
Closes #<issue2>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

If no issues are found, omit the `Closes` lines entirely.

## Rules

- Keep the title short and descriptive
- If PR already exists for this branch, report the existing PR URL instead
- Return the PR URL when done
- Each issue gets its own `Closes #N` line — do not combine them
- Only include issues that were verified as open via `gh issue view`
