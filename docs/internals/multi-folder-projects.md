# Multi-folder projects

A multi-folder project is an ordinary project whose workspace root is a folder T3 Code prepares in
its projects folder: a `.t3-multi-folder` marker and one link per chosen folder (a symlink on
Linux and macOS, a junction on Windows, which needs no elevation). [`MultiFolderWorkspace`](../../apps/server/src/workspace/MultiFolderWorkspace.ts) reads
membership from those links on every call, so a link made by hand is a member and there is no
stored list to drift from the disk.

## It is a parent folder, nothing more

Git, worktrees, and status treat the root exactly like any other project folder that contains
those folders, such as a `~/work` holding two repositories. There is deliberately no
per-repository fan-out: what works for a plain parent folder works here, and what does not, does
not. Keep it that way; a behaviour that only multi-folder projects get is a second model of the
same folder.

The root is also never claimed by a repository that happens to contain it (a T3 home inside a
checkout, or a home directory that is a dotfiles repository): `RepositoryIdentityResolver` gives a
marked folder no identity, so such projects are not all grouped under that repository.

The refusals are `vcs.init` on the root and checkpoints in it: `CheckpointStore.isGitRepository`
reports the root as not checkpointable and `restoreCheckpoint` refuses it. Git for Windows treats
a junction as an ordinary directory, so a repository made there would commit, a capture would
stage, and a restore's `git clean` would delete, the contents of every linked folder; elsewhere
the clean would remove the links themselves. The init guard covers T3 Code's own RPC; the
checkpoint guards cover a repository that got there another way (`git init` from a shell, or a
repository above the projects folder, such as a T3 home inside a checkout). The marker is the only
way to tell such a folder apart.

## Links are followed for the agent and the file finder

The marker exists for the two places where a link does not behave like the folder it points at:

- Provider sandboxes and permission checks compare real paths. The runtime policy passes linked
  targets as `additionalDirectories`, which each adapter maps to its own mechanism (Claude
  `additionalDirectories`, Codex `writableRoots`, ACP session directories, OpenCode
  `external_directory` rules, Cursor `local.dirs`; Grok has no path sandbox, so links suffice).
  The set is resolved per turn and reaches the agent at its next turn: Claude reopens its query
  (refused while background work runs), ACP restarts its runtime, and OpenCode rewrites the
  session's rules.
- The file finder does not follow links, so search, the file tree, and reads query each member's
  own index and prefix results with the member name
  ([`WorkspaceEntries`](../../apps/server/src/workspace/WorkspaceEntries.ts)).

Linking hands agents in the project a folder anywhere on the machine, the same reach as
registering a project at any path, so the link and unlink RPCs need the Operate scope and the
`t3_project_folders` tool is marked destructive.
