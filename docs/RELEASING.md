# Releasing CrewCoder

Create a coordinated release from a clean branch with one command:

```sh
npm run release -- 0.7.0
```

The command updates the umbrella, agent, browser client, and SDK package versions as one coordinated release group. It preserves the TUI package version and the umbrella package's existing exact TUI dependency. It also updates the release group's exact internal dependencies, runtime version constants, generated client and SDK version API baselines, and `package-lock.json`; runs the SDK release checks; creates a `chore(release): v0.7.0` commit and annotated `v0.7.0` tag; then atomically pushes the current branch and tag to its configured remote.

Only `crewcoder-client/api/version.d.ts` and `crewcoder-sdk/api/version.d.ts` may change during the automatic API baseline refresh. Any other public declaration change stops the release for explicit review.

Only stable semantic versions in `major.minor.patch` form are accepted. Do not include the leading `v`; it is added to the Git tag automatically.

## Safety checks

The release stops before changing files when:

- the worktree is not completely clean;
- the target version is not newer than every package in the coordinated release group;
- the current checkout is detached;
- the release tag already exists;
- the current branch is behind or diverged from its remote branch.

It also stops before committing if version metadata, lockfile generation, or release checks fail. A failure after metadata generation intentionally leaves those changes visible for inspection. A failed atomic push leaves the local release commit and tag intact; fix the remote issue and retry the exact `git push --atomic` command printed by the release script.

Preview local validation without changing files or contacting the remote:

```sh
npm run release -- 0.7.0 --dry-run
```

Pushing the tag does not publish npm packages by itself. Publishing remains controlled by the protected `CrewCoder SDK release` GitHub Actions workflow.
