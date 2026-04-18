---
name: git-commit
description: Stage, review, and commit changes in a git repository with a clean, informative commit message. Use whenever the user asks to "commit", "make a commit", "commit this", "commit my changes", "git commit", "save this to git", or describes wanting to record work-in-progress as a commit. Also use when the user says the work is "done" or "ready to commit" and a commit is the obvious next step. This skill handles the full flow: reviewing what's actually changed, deciding what belongs in the commit vs. what should be held back or split out, drafting a message that matches the repo's existing style (Conventional Commits or plain), and running the commit. Do NOT use this skill for branch management, pushing, rebasing, or opening PRs — this is commit-only.
---

# git-commit

Turn a working directory full of changes into a clean commit — or several — that the future reader (often the user, six months later, in `git log`) will actually find useful.

A good commit is not "all my uncommitted changes with a one-line message." A good commit is a coherent, self-contained unit of work with a message that explains what changed and, when non-obvious, why. This skill's job is to produce that.

## Core principles

**Review before committing.** Never run `git commit` blind. Always inspect what's about to go in first — unstaged changes, staged changes, untracked files. Surprises at commit time become surprises in history forever.

**One commit, one idea.** If the working tree contains two unrelated changes (a bug fix and an unrelated refactor), that's two commits, not one. Split them.

**Match the repo's style, don't impose.** Before writing a message, look at the last 5–10 commits with `git log --oneline -20` or `git log -10`. If the repo uses Conventional Commits (`feat:`, `fix:`, `chore:`), match it. If it uses plain imperative English, match that. If it's a chaotic mix, lean toward the cleaner pattern but don't lecture the user about it.

**The user reviews the message, not you.** After drafting, show it. Let them confirm or edit. Do not commit on auto-pilot.

## Workflow

### 1. Survey the state of the working tree

Run, in order:

```
git status
git diff --stat
git diff
git diff --staged
```

- `git status` — what's modified, staged, untracked, deleted.
- `git diff --stat` — file-level summary of unstaged changes.
- `git diff` — the actual unstaged changes.
- `git diff --staged` — already-staged changes (if anything is pre-staged).

For large diffs, read the stat first and then inspect specific files. Don't dump thousands of lines into context when the stat tells you what's up.

Also check:
- Untracked files (`git status` shows these) — are any of them intentional additions, or are they build artifacts, logs, `.env` files, or editor junk that should be in `.gitignore`?
- Deleted files — is the deletion intentional?

### 2. Decide scope

Based on the diff, decide:

**Single commit** when:
- All changes serve one purpose (fixing one bug, implementing one feature, refactoring one thing).
- The changes are tightly coupled even if they span many files.

**Multiple commits** when:
- There are clearly unrelated changes (e.g., a bug fix AND an unrelated docs update AND a dependency bump).
- A refactor and a feature are mixed — these almost always want to be separate so the refactor can be reviewed on its own.
- Some changes are WIP and shouldn't go in yet.

If multiple commits are needed, propose the split to the user before doing it. Use `git add -p` or selective `git add <path>` to stage commit-by-commit. Do not try to be clever with partial-file staging without confirming — it's easy to commit a file in a broken intermediate state.

### 3. Check the repo's commit style

Run `git log --oneline -20` and scan:

- Do subjects start with `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `style:`, `perf:`, `build:`, `ci:`? → Conventional Commits. Match it.
- Do subjects start with a scope in parens, like `feat(auth): ...`? → Scoped Conventional Commits. Match it, and infer the scope from which part of the code changed.
- Are subjects plain imperative English ("Add login form", "Fix timezone bug")? → Plain style. Match it.
- Is it a mess? → Default to plain imperative English, which is always readable.

If there are fewer than ~5 commits in the repo, there's no established style — default to Conventional Commits since it scales better, unless the user signals otherwise.

### 4. Stage what should be in the commit

```
git add <specific files>      # preferred — explicit
git add -p                    # for partial-file staging if truly needed
git add -A                    # only when the entire working tree is one coherent change
```

Prefer explicit file paths. `git add .` and `git add -A` are fine when the whole tree is one change, but they're the most common way to accidentally commit `.env` files, `node_modules/` slipping through, or half-finished experimental files. Be deliberate.

After staging, run `git diff --staged` one more time and confirm that's actually what you want to commit.

### 5. Write the message

**Subject line**:
- Imperative mood: "Add X", "Fix Y", "Remove Z" — not "Added", "Adding", "Fixes".
- 50 characters is the classic target; 72 is the hard ceiling.
- No trailing period.
- Capitalized (first word, for plain style; after the `type:` prefix for Conventional).
- Specific. `Fix bug` is useless. `Fix timezone offset in invoice due date` is useful.

**Body** (optional but frequently worth writing):
- Blank line between subject and body.
- Wrap at ~72 characters.
- Explain **what changed** at a higher level than the diff, and **why** when the why isn't obvious from the code.
- Don't restate the diff. "Changed `foo()` to call `bar()` instead of `baz()`" is noise. "Switched from `baz()` to `bar()` because `baz()` was deprecated in v3" is useful.
- Mention side effects: "Note: this changes the default timeout from 30s to 60s."
- Reference issues/tickets when relevant: `Fixes #123` or `Refs PROJ-456` on its own line.

**When a body is worth writing**:
- The change is non-trivial and future-you won't remember why.
- There's a gotcha or surprising decision embedded in the change.
- The change is part of a larger effort that needs context.

**When a body is not needed**:
- Trivial changes: typo fixes, formatting, obvious renames.
- The subject line is already self-explanatory.

### 6. Show the draft, get confirmation, commit

Show the user the full message (subject + body) before committing. Do not sneak in the commit without review. Something like:

```
Proposed commit:

  fix(auth): handle expired refresh tokens gracefully

  Previously the refresh endpoint threw a 500 when given an expired
  token, leaking the underlying JWT error. Now it returns 401 with
  a clean message so the client can prompt for reauthentication.

  Fixes #234

Run? (y / edit / cancel)
```

Then, on approval, commit with:

```
git commit -m "subject" -m "body paragraph 1" -m "body paragraph 2"
```

Or, for a multi-line message, use a heredoc:

```
git commit -m "$(cat <<'EOF'
subject line here

body paragraph here, wrapped at ~72 chars, explaining what and
why without restating the diff.

Fixes #234
EOF
)"
```

The `<<'EOF'` (with quotes) prevents shell expansion inside the message, which matters if the message contains backticks, `$`, or `!`.

### 7. Verify and report

After committing, run `git log -1 --stat` and show the user the result. Confirm:

- The message landed correctly (line breaks preserved, no shell-escape artifacts).
- The files committed match what was intended.
- Nothing unexpected was staged at the last moment.

## What this skill does not do

- **Does not push.** `git push` is a separate step and often has consequences (CI, shared branches). Ask if the user wants to push after committing.
- **Does not manage branches.** Creating, switching, or deleting branches is out of scope.
- **Does not rewrite history.** Amending, rebasing, squashing — separate skills or explicit user requests, not part of a normal commit flow. The exception: if the user just committed and immediately says "oh wait, the message was wrong," `git commit --amend` is fine.
- **Does not open PRs.** Also out of scope.
- **Does not auto-`git add -A` without thinking.** The most common commit disaster is committing something that shouldn't be committed. Be specific about what's staged.

## Edge cases

**Pre-commit hooks fail**: if `git commit` fails because of a linter/formatter hook, the hook's output tells you what's wrong. Fix the lint/format issues, restage the affected files, commit again. Don't bypass hooks with `--no-verify` unless the user explicitly asks — the hooks exist for a reason.

**Nothing to commit**: if the working tree is clean, say so and stop. Don't invent a commit.

**Untracked files that look important**: if there's an untracked file that looks like real work (e.g., a new component that matches the diff's intent), ask whether to include it. Don't silently skip it, and don't silently add it.

**Merge conflicts visible**: if `git status` shows an unresolved merge, stop. Committing with conflict markers in the code is a disaster. Tell the user, and do not proceed until conflicts are resolved.

**Detached HEAD**: if `git status` shows a detached HEAD state, warn the user before committing — the commit will be orphaned if they check out a branch without creating one here first.

## Examples

**Simple case**

User: "Commit this."
State: three files modified, all part of implementing user avatar uploads. Repo uses Conventional Commits.
Action:
```
git status && git diff --stat && git diff
git log --oneline -10         # → uses Conventional Commits
git add app/profile/avatar-upload.tsx lib/upload.ts components/ui/avatar.tsx
```
Propose:
```
feat(profile): add avatar upload with S3-backed storage
```
Confirm, commit, show `git log -1 --stat`.

**Split case**

User: "Commit my changes."
State: bug fix in auth middleware + unrelated README typo fix + new experimental file (`scratch.ts`).
Action: propose three actions — (1) commit the auth fix, (2) commit the README typo separately, (3) ask whether `scratch.ts` should be added to `.gitignore`, stashed, or committed. Do not lump them.

**Refusal**

User: "Just commit everything."
State: includes a `.env.local` with an API key.
Action: stop. Point out the `.env.local`. Refuse to commit secrets. Propose adding it to `.gitignore` and committing that instead.