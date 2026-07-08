# Releasing & keeping the changelog current

The Partner Portal ships from **two repos** (`t4a-partner-portal-api`, `t4a-partner-portal-ui`)
but presents **one unified changelog** to partners at **`/changelog`** in the portal.

There is **one source of truth**:
[`t4a-partner-portal-ui/src/lib/changelog.js`](https://github.com/time-4-action/t4a-partner-portal-ui/blob/main/src/lib/changelog.js).
Everything else (the `/changelog` page, `CHANGELOG.md` in **both** repos, and the git tags) is
mirrored from it. Keep them in lockstep — a release is not "done" until all four are updated.

## Versioning

[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking API/contract changes for integrators.
- **MINOR** — new user-facing capability, backwards compatible (this is the common one).
- **PATCH** — bug fixes / polish only, no new capability.

Each changelog entry has a `scope` listing which repos it touched (`"api"`, `"ui"`). If a
release only changes one repo, only tag that repo.

## Checklist for cutting a release `vX.Y.Z`

1. **Decide the version** from the rules above based on what merged since the last tag.
2. **Edit `src/lib/changelog.js`** in the **UI repo** — prepend a new object to `RELEASES`
   (newest first); move `latest: true` onto it; fill `added` / `changed` / `fixed` with plain,
   partner-readable sentences and the tagged short-SHA per repo in `commits`.
3. **Mirror `CHANGELOG.md`** in **both** repos (identical wording + the `[X.Y.Z]` link).
4. **Commit** the docs/data changes in each repo.
5. **Tag & push** the exact commit each repo ships from:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — <Title>

   <one-line summary>

   Added:   …
   Changed: …
   Fixed:   …"
   git push origin vX.Y.Z
   ```

6. **(Optional) GitHub Release** — `gh release create vX.Y.Z --notes-file <notes>`.

## Handy commands

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline   # changes since last tag
git tag -l --sort=-v:refname                                # tags, newest first
git tag -n99 vX.Y.Z                                         # inspect a tag's message
```

## Notes / gotchas

- **The old `v1.0.0` was wrong.** A stray lightweight `v1.0.0` once pointed at an early-January
  "improved website design" commit and had been pushed. It was deleted (local + remote) and
  recreated as an annotated tag on the real June GA-readiness commit (`7c56410`). Don't
  resurrect the old one.
- Tags are **annotated** (`-a`), never lightweight.
- The `/changelog` page is **public** — keep internal infra, credentials and customer names
  out of changelog entries.
