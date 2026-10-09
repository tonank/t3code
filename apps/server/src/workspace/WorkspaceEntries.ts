// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MultiFolderWorkspace from "./MultiFolderWorkspace.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/**
 * A member's index lives at its real folder, so a repo opened as its own
 * project under that same path shares one index (and one watcher) with the
 * multi-folder root.
 */
const memberIndexRoot = (member: MultiFolderWorkspace.MultiFolderMember) =>
  member.linkTarget ?? member.path;

const prefixMemberPath = (member: MultiFolderWorkspace.MultiFolderMember, entryPath: string) =>
  `${member.name}/${entryPath}`;

/** Round-robin by rank so no single member fills a result page. */
function interleave<A>(lists: ReadonlyArray<ReadonlyArray<A>>): A[] {
  const merged: A[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const list of lists) {
      const item = list[rank];
      if (item !== undefined) merged.push(item);
    }
  }
  return merged;
}

/** Groups consecutive matches of one file so interleaving keeps a file's matches together. */
function groupByPath<A extends { readonly path: string }>(matches: ReadonlyArray<A>): A[][] {
  const groups: A[][] = [];
  for (const match of matches) {
    const last = groups.at(-1);
    if (last?.[0]?.path === match.path) last.push(match);
    else groups.push([match]);
  }
  return groups;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const multiFolderWorkspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
  // A dangling link is listed for removal only; it has no files to index.
  const presentMembers = (cwd: string) =>
    multiFolderWorkspace
      .members(cwd)
      .pipe(
        Effect.map((members) =>
          members === null ? null : members.filter((member) => !member.missing),
        ),
      );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const withSearchIndex = <A, E>(
    indexRoot: string,
    variant: WorkspaceSearchIndex.WorkspaceSearchIndexVariant,
    use: (searchIndex: WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.flatMap(WorkspaceSearchIndex.WorkspaceSearchIndex, use).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(indexRoot, variant),
        ),
      ),
    );

  const refreshIndexRoot = Effect.fn("WorkspaceEntries.refreshIndexRoot")(function* (
    indexRoot: string,
  ) {
    for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
      const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(indexRoot, variant);
      if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
        continue;
      }
      const recoverRefreshFailure = (
        cause:
          | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
          | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
          | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
      ) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to refresh workspace search index", {
            cwd: indexRoot,
            variant,
            cause,
          });
          yield* workspaceSearchIndexes.invalidate(indexKey);
        });
      yield* withSearchIndex(indexRoot, variant, (searchIndex) => searchIndex.refresh()).pipe(
        Effect.catchTags({
          WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
          WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
          WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
        }),
      );
    }
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      const members = yield* presentMembers(normalizedCwd);
      yield* Effect.forEach(
        members === null ? [normalizedCwd] : members.map(memberIndexRoot),
        refreshIndexRoot,
        { concurrency: "unbounded", discard: true },
      );
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      // A `.git` folder (or a worktree's `.git` file) marks a repository root,
      // so pickers can point at whole repositories rather than folders in one.
      const withRepositories = yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.promise(() =>
            NodeFSP.access(path.join(entry.fullPath, ".git")).then(
              () => ({ ...entry, isGitRepository: true }),
              () => entry,
            ),
          ),
        { concurrency: 32 },
      );

      return {
        parentPath,
        entries: withRepositories.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  // A multi-folder root is searched through its members' own indexes: the
  // root's index would not follow member links, and its loose files are only
  // the marker, so they are left out.
  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      const searchIn = (indexRoot: string, query: string) =>
        withSearchIndex(indexRoot, "paths", (searchIndex) =>
          searchIndex.search(query, input.limit, input.kind, input.imageOnly),
        );
      const members = yield* presentMembers(normalizedCwd);
      if (members === null) return yield* searchIn(normalizedCwd, normalizedQuery);

      const searchMember = (member: MultiFolderWorkspace.MultiFolderMember, query: string) =>
        searchIn(memberIndexRoot(member), query).pipe(
          Effect.map((result) => ({
            entries: result.entries.map((entry) => ({
              ...entry,
              path: prefixMemberPath(member, entry.path),
            })),
            truncated: result.truncated,
          })),
        );

      // `<member>/rest` searches only that member for `rest`.
      const separatorIndex = normalizedQuery.indexOf("/");
      const scopedMember =
        separatorIndex > 0
          ? members.find(
              (member) => member.name.toLowerCase() === normalizedQuery.slice(0, separatorIndex),
            )
          : undefined;
      if (scopedMember) {
        const scoped = yield* searchMember(scopedMember, normalizedQuery.slice(separatorIndex + 1));
        // A member named like a common folder (`src/`) must not swallow a path
        // typed for another member: with nothing in it, search everything.
        if (scoped.entries.length > 0) return scoped;
      }

      const memberDirectories: ProjectEntry[] =
        input.kind === "file" || input.imageOnly
          ? []
          : members
              .filter((member) => member.name.toLowerCase().includes(normalizedQuery))
              .map((member) => ({ path: member.name, kind: "directory" }));
      const results = yield* Effect.forEach(
        members,
        (member) => searchMember(member, normalizedQuery),
        { concurrency: "unbounded" },
      );
      const merged = [...memberDirectories, ...interleave(results.map((result) => result.entries))];
      return {
        entries: merged.slice(0, input.limit),
        truncated: merged.length > input.limit || results.some((result) => result.truncated),
      };
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    const searchIn = (indexRoot: string) =>
      withSearchIndex(indexRoot, "content", (searchIndex) => searchIndex.searchContents(input));
    const members = yield* presentMembers(normalizedCwd);
    if (members === null) return yield* searchIn(normalizedCwd);

    const results = yield* Effect.forEach(
      members,
      (member) =>
        searchIn(memberIndexRoot(member)).pipe(
          Effect.map((result) => ({
            ...result,
            matches: result.matches.map((match) => ({
              ...match,
              path: prefixMemberPath(member, match.path),
            })),
          })),
        ),
      { concurrency: "unbounded" },
    );
    const merged = interleave(results.map((result) => groupByPath(result.matches))).flat();
    const regexFallbackError = results.find(
      (result) => result.regexFallbackError !== undefined,
    )?.regexFallbackError;
    return {
      matches: merged.slice(0, input.limit),
      truncated: merged.length > input.limit || results.some((result) => result.truncated),
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const members = yield* presentMembers(normalizedCwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        // Linked members are the multi-folder root's top-level directories.
        const memberNames =
          members !== null && target.relativePath === ""
            ? new Set(members.map((member) => member.name))
            : null;
        const entries = yield* Effect.tryPromise({
          try: async () => {
            // A linked member's folder counts as inside the workspace.
            const allowedRoots = [
              await NodeFSP.realpath(normalizedCwd),
              ...(members ?? []).flatMap((member) => member.linkTarget ?? []),
            ];
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = allowedRoots
              .map((root) => path.relative(root, directory))
              .find(
                (candidate) =>
                  candidate !== ".." &&
                  !candidate.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(candidate),
              );
            if (
              relative === undefined ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            return children.flatMap((child): ProjectEntry[] => {
              if (child.name === ".git") return [];
              if (memberNames?.has(child.name)) return [{ path: child.name, kind: "directory" }];
              if (memberNames && child.name === MultiFolderWorkspace.MULTI_FOLDER_MARKER_FILE) {
                return [];
              }
              if (!child.isDirectory() && !child.isFile()) return [];
              return [
                {
                  path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                  kind: child.isDirectory() ? "directory" : "file",
                },
              ];
            });
          },
          catch: toError,
        });
        // A multi-folder root is not a repository; classify a member's entries
        // inside that member, and leave the root's own entries unclassified.
        const firstSegment = target.relativePath.split("/")[0];
        const ignoreScopeMember = members?.find((member) => member.name === firstSegment);
        const ignoreScope =
          members === null
            ? { cwd: normalizedCwd, prefix: "", entries }
            : ignoreScopeMember
              ? { cwd: ignoreScopeMember.path, prefix: `${ignoreScopeMember.name}/`, entries }
              : { cwd: normalizedCwd, prefix: "", entries: [] };
        // Use stdin so large directories cannot exceed the command-line argument limit.
        // Ignore classification is optional in non-git workspaces or when git is unavailable.
        const ignored = new Set<string>();
        for (let offset = 0; offset < ignoreScope.entries.length; offset += 1000) {
          const chunk = ignoreScope.entries.slice(offset, offset + 1000);
          const result = yield* vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: ignoreScope.cwd,
              stdin: `${chunk.map((entry) => entry.path.slice(ignoreScope.prefix.length)).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) {
            if (ignoredPath) ignored.add(`${ignoreScope.prefix}${ignoredPath}`);
          }
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      if (members === null) {
        return yield* withSearchIndex(normalizedCwd, "paths", (searchIndex) => searchIndex.list());
      }
      const results = yield* Effect.forEach(
        members,
        (member) =>
          withSearchIndex(memberIndexRoot(member), "paths", (searchIndex) =>
            searchIndex.list(),
          ).pipe(
            Effect.map((result) => ({
              entries: result.entries.map((entry) => ({
                ...entry,
                path: prefixMemberPath(member, entry.path),
              })),
              truncated: result.truncated,
            })),
          ),
        { concurrency: "unbounded" },
      );
      // Members come sorted by name and each index sorted by path, so their
      // lists join in order, each after its own folder, up to the cap.
      const max = WorkspaceSearchIndex.WORKSPACE_INDEX_MAX_ENTRIES;
      const entries: ProjectEntry[] = [];
      let truncated = results.some((result) => result.truncated);
      for (const [index, member] of members.entries()) {
        const memberEntries = results[index]!.entries;
        if (entries.length + 1 + memberEntries.length > max) truncated = true;
        if (entries.length >= max) break;
        entries.push({ path: member.name, kind: "directory" });
        entries.push(...memberEntries.slice(0, max - entries.length));
      }
      return { entries, truncated };
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(MultiFolderWorkspace.layer),
);
