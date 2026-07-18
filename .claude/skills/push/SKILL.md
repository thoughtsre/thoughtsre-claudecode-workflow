---
name: push
description: Push the current branch to the remote repository.
#model: sonnet
---

# Push to Remote

Push the current branch to the remote repository.

## Process

1. Run `git status` to confirm there are no uncommitted changes (warn if there are)
2. Run `git branch --show-current` to get the current branch name
3. Check if the branch has an upstream with `git rev-parse --abbrev-ref @{upstream} 2>/dev/null`
4. If no upstream, push with `-u origin <branch>`
5. If upstream exists, push normally
6. Report success and the remote URL

## Rules

- Do NOT force push unless explicitly asked
- Do NOT push to main/master without confirming with the user first
- Warn if there are uncommitted changes but still push if asked
