# CLAUDE.md

## Branches

- This is Calliope's fork of scratch-vm (via xcratch). Work happens on
  `calliope-main`: branch off it and merge back into it. Other branches
  (upstream's and older Calliope ones such as `calliope-controller`) are not
  worked on.
- The fork is not shipped on its own and has no tags. Blocks
  (`calliope-edu/scratch-gui`) pins its commit in its `package-lock.json`, from
  `git+https://github.com/calliope-edu/scratch-vm.git#calliope-main`.
- Every push to `calliope-main` commits the new pin to the app's `calliope-main`
  (workflow `calliope-app-lockfile`), which makes the app's dev build; the app's
  next tag takes it live.
- The plan behind this: calliope-campus `docs/design/2026-editor-channels.md`,
  "Library forks".
