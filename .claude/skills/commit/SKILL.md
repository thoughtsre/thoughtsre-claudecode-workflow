---
name: commit
description: Commit only the files that were changed during this session with a descriptive commit message.
#model:sonnet
---

# Commit Changes

Commit only the files that were changed during this session with a descriptive commit message.

## Process

1. Identify which files were modified during this session (only those you edited or created)
2. Run `git diff` on those specific files to review the changes
3. Run `git log -3 --oneline` to see recent commit message style
4. Stage only the session-modified files by name
5. Write a concise commit message that:
   - Summarizes the "why" not just the "what"
   - Follows the repository's existing commit style
   - Is 1-2 sentences max
6. Commit using a HEREDOC for the message
7. Run `git status` to confirm success
8. Report the commit hash

## Rules

- Only commit files that were changed in this session - ignore other uncommitted changes
- Do NOT commit files that may contain secrets (.env, credentials, etc.)
- Do NOT push unless explicitly asked
- Do NOT use --amend unless explicitly asked
- If no files were changed this session, say so and stop
