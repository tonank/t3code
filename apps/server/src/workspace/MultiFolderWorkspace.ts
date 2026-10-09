// @effect-diagnostics nodeBuiltinImport:off - links need `junction` on Windows, which Effect's FileSystem cannot request.
/**
 * MultiFolderWorkspace - a project folder prepared to gather folders that live
 * elsewhere.
 *
 * A multi-folder root is a plain directory holding a marker file and one link
 * per member folder. Everything else treats it exactly like any parent folder
 * of those folders; the marker only tells providers and the file finder to
 * follow its links. The entries are the membership; nothing else records it,
 * so linking a folder by hand works too. See docs/internals/multi-folder-projects.md.
 *
 * @module MultiFolderWorkspace
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const MULTI_FOLDER_MARKER_FILE = ".t3-multi-folder";

const MARKER_CONTENTS = `This folder is a T3 Code multi-folder project.
Each folder here links to one folder of the project. Add one by linking a
folder into this one.
`;

/** Whether `cwd` holds the marker: one stat, for callers outside the service. */
export const isMultiFolderRoot = (cwd: string): Promise<boolean> =>
  NodeFSP.stat(NodePath.join(cwd, MULTI_FOLDER_MARKER_FILE)).then(
    (stat) => stat.isFile(),
    () => false,
  );

export interface MultiFolderMember {
  /** Entry name inside the root, which is also the member's path prefix. */
  readonly name: string;
  /** `<root>/<name>`. */
  readonly path: string;
  /** The real folder a linked member points at; null for a folder in place. */
  readonly linkTarget: string | null;
  /**
   * The link's target is gone. The member is listed so it can be seen and
   * removed; nothing else (search, provider access) uses it.
   */
  readonly missing: boolean;
}

const MultiFolderWorkspaceErrorReason = Schema.Literals([
  "not-multi-folder",
  "target-missing",
  "target-not-absolute",
  "target-not-folder",
  "target-contains-root",
  "target-inside-root",
  "target-overlaps-member",
  "names-exhausted",
  "member-not-linked",
  "filesystem",
]);

const REASON_MESSAGES: Record<typeof MultiFolderWorkspaceErrorReason.Type, string> = {
  "not-multi-folder": "This project is not a multi-folder project.",
  "target-missing": "The folder to link does not exist.",
  "target-not-absolute": "The folder to link must be an absolute path.",
  "target-not-folder": "Only folders can be linked into a project.",
  "target-contains-root": "A project cannot include itself or a folder that contains it.",
  "target-inside-root": "A folder inside the project folder is already part of it.",
  "target-overlaps-member":
    "A folder inside, or containing, a folder of the project cannot be linked too.",
  "names-exhausted": "Every member name for this folder is taken.",
  "member-not-linked": "The project has no linked folder with that name.",
  filesystem: "The multi-folder project folder could not be updated.",
};

export class MultiFolderWorkspaceError extends Schema.TaggedError<MultiFolderWorkspaceError>()(
  "MultiFolderWorkspaceError",
  {
    root: Schema.String,
    reason: MultiFolderWorkspaceErrorReason,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const message = REASON_MESSAGES[this.reason];
    // Name the folder, so a create with several folders says which one failed.
    return this.path === undefined ? message : `${message.replace(/\.$/, "")}: ${this.path}`;
  }
}

export class MultiFolderWorkspace extends Context.Service<
  MultiFolderWorkspace,
  {
    /** Members of a multi-folder root, dangling links included, or null when `cwd` is not one. Never fails. */
    readonly members: (cwd: string) => Effect.Effect<ReadonlyArray<MultiFolderMember> | null>;
    /**
     * Real folders a provider must be allowed to use beyond `cwd`: the targets
     * of linked members. Empty for anything but a multi-folder root.
     */
    readonly linkedTargets: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
    /** Marks `root` (created if missing) as a multi-folder root. */
    readonly initialize: (root: string) => Effect.Effect<void, MultiFolderWorkspaceError>;
    /** Links the absolute `target` (`~` expanded) into `root` under a free name derived from its basename. */
    readonly link: (input: {
      readonly root: string;
      readonly target: string;
    }) => Effect.Effect<MultiFolderMember, MultiFolderWorkspaceError>;
    /**
     * Removes the marker and then the root folder, which must be empty by then
     * (its links removed); anything left in it keeps the folder, still marked.
     */
    readonly dispose: (root: string) => Effect.Effect<void, MultiFolderWorkspaceError>;
    /** Removes a linked member. The folder it points at is never touched. */
    readonly unlink: (input: {
      readonly root: string;
      readonly name: string;
    }) => Effect.Effect<void, MultiFolderWorkspaceError>;
  }
>()("t3/workspace/MultiFolderWorkspace") {}

const isVisibleMemberName = (name: string) => !name.startsWith(".");

const make = Effect.gen(function* () {
  const path = yield* Path.Path;

  const isRoot = (cwd: string) => Effect.promise(() => isMultiFolderRoot(cwd));

  const members: MultiFolderWorkspace["Service"]["members"] = (cwd) =>
    Effect.gen(function* () {
      if (!(yield* isRoot(cwd))) return null;
      const entries = yield* Effect.promise(() =>
        NodeFSP.readdir(cwd, { withFileTypes: true }).catch(() => []),
      );
      const found = yield* Effect.forEach(
        entries.filter((entry) => isVisibleMemberName(entry.name)),
        (entry) =>
          Effect.promise(async (): Promise<MultiFolderMember | null> => {
            const memberPath = path.join(cwd, entry.name);
            if (entry.isDirectory()) {
              return { name: entry.name, path: memberPath, linkTarget: null, missing: false };
            }
            if (!entry.isSymbolicLink()) return null;
            const target = await NodeFSP.realpath(memberPath).catch(() => null);
            if (target === null) {
              // Dangling: keep it visible under the path it was linked to, so it can be removed.
              const linked = await NodeFSP.readlink(memberPath).catch(() => null);
              return linked === null
                ? null
                : {
                    name: entry.name,
                    path: memberPath,
                    // Windows reports a junction's target with the `\\?\` prefix.
                    linkTarget: path.resolve(cwd, linked.replace(/^\\\\\?\\/, "")),
                    missing: true,
                  };
            }
            // A link to a file is not a member.
            const stat = await NodeFSP.stat(target).catch(() => null);
            return stat?.isDirectory()
              ? { name: entry.name, path: memberPath, linkTarget: target, missing: false }
              : null;
          }),
        { concurrency: "unbounded" },
      );
      return found
        .filter((member) => member !== null)
        .toSorted((left, right) => left.name.localeCompare(right.name));
    });

  const linkedTargets: MultiFolderWorkspace["Service"]["linkedTargets"] = (cwd) =>
    members(cwd).pipe(
      Effect.map((found) =>
        found === null
          ? []
          : [
              ...new Set(
                found.flatMap((member) => (member.missing ? [] : (member.linkTarget ?? []))),
              ),
            ].toSorted(),
      ),
    );

  const fail =
    (root: string, reason: MultiFolderWorkspaceError["reason"], failedPath?: string) =>
    (cause: unknown) =>
      new MultiFolderWorkspaceError({
        root,
        reason,
        ...(failedPath === undefined ? {} : { path: failedPath }),
        cause,
      });

  const initialize: MultiFolderWorkspace["Service"]["initialize"] = (root) =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(root, { recursive: true });
        await NodeFSP.writeFile(path.join(root, MULTI_FOLDER_MARKER_FILE), MARKER_CONTENTS);
      },
      catch: fail(root, "filesystem", root),
    });

  const freeName = Effect.fn("MultiFolderWorkspace.freeName")(function* (
    root: string,
    preferred: string,
  ) {
    const base = preferred.replace(/^\.+/, "") || "folder";
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const name = attempt === 1 ? base : `${base}-${attempt}`;
      const taken = yield* Effect.promise(() =>
        NodeFSP.lstat(path.join(root, name)).then(
          () => true,
          () => false,
        ),
      );
      if (!taken) return name;
    }
    return yield* new MultiFolderWorkspaceError({ root, reason: "names-exhausted", path: base });
  });

  const link: MultiFolderWorkspace["Service"]["link"] = Effect.fn("MultiFolderWorkspace.link")(
    function* (input) {
      // Agents and clients send what they have; `~/code/api` works, like for a
      // project path, while a relative path has no base to resolve against.
      const requested = expandHomePath(input.target.trim(), yield* HostProcess.HomeDirectory);
      if (!path.isAbsolute(requested)) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "target-not-absolute",
          path: input.target,
        });
      }
      const target = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requested),
        catch: fail(input.root, "target-missing", input.target),
      });
      const stat = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(target),
        catch: fail(input.root, "target-missing", target),
      });
      if (!stat.isDirectory()) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "target-not-folder",
          path: target,
        });
      }
      const realRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.root),
        catch: fail(input.root, "not-multi-folder"),
      });
      const relative = path.relative(target, realRoot);
      // `..` alone or `../x` leaves the target; `..x` is a sibling named that way.
      const outside =
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      if (!outside) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "target-contains-root",
          path: target,
        });
      }
      // A folder in place is a member already; a link to it would list it twice.
      const fromRoot = path.relative(realRoot, target);
      if (!(fromRoot.startsWith("..") || path.isAbsolute(fromRoot))) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "target-inside-root",
          path: target,
        });
      }
      const existing = yield* members(input.root);
      if (existing === null) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "not-multi-folder",
        });
      }
      const already = existing.find((member) => !member.missing && member.linkTarget === target);
      if (already) return already;
      // A folder inside a member, or holding one, would list every file twice.
      const overlapping = existing.find((member) => {
        if (member.missing) return false;
        const memberRoot = member.linkTarget ?? member.path;
        const nested = path.relative(memberRoot, target);
        const holds = path.relative(target, memberRoot);
        const inside = (relative: string) =>
          !(relative.startsWith("..") || path.isAbsolute(relative));
        return inside(nested) || inside(holds);
      });
      if (overlapping) {
        return yield* new MultiFolderWorkspaceError({
          root: input.root,
          reason: "target-overlaps-member",
          path: target,
        });
      }
      // Two clients linking same-named folders at once race for the name; the
      // loser picks the next free one.
      for (let attempt = 0; ; attempt += 1) {
        const name = yield* freeName(input.root, path.basename(target));
        const memberPath = path.join(input.root, name);
        // Junctions need no elevation on Windows; the type is ignored elsewhere.
        const outcome = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.symlink(target, memberPath, "junction").then(
              () => "linked" as const,
              (error: NodeJS.ErrnoException) => {
                if (error.code === "EEXIST" && attempt < 3) return "taken" as const;
                throw error;
              },
            ),
          catch: fail(input.root, "filesystem", memberPath),
        });
        if (outcome === "linked") {
          return {
            name,
            path: memberPath,
            linkTarget: target,
            missing: false,
          } satisfies MultiFolderMember;
        }
        // The other side may have linked this very folder; one member, not two.
        const raced = (yield* members(input.root))?.find(
          (member) => !member.missing && member.linkTarget === target,
        );
        if (raced) return raced;
      }
    },
  );

  const unlink: MultiFolderWorkspace["Service"]["unlink"] = Effect.fn(
    "MultiFolderWorkspace.unlink",
  )(function* (input) {
    if (!(yield* isRoot(input.root))) {
      return yield* new MultiFolderWorkspaceError({ root: input.root, reason: "not-multi-folder" });
    }
    // Any link directly in the root can go, dangling ones included; a name
    // that would leave the root is not a member name.
    const memberPath = path.join(input.root, input.name);
    const isLink =
      path.basename(input.name) === input.name &&
      isVisibleMemberName(input.name) &&
      (yield* Effect.promise(() =>
        NodeFSP.lstat(memberPath).then(
          (stat) => stat.isSymbolicLink(),
          () => false,
        ),
      ));
    if (!isLink) {
      return yield* new MultiFolderWorkspaceError({
        root: input.root,
        reason: "member-not-linked",
        path: input.name,
      });
    }
    // `unlink` removes the link (or junction) itself, never the target's files.
    yield* Effect.tryPromise({
      try: () => NodeFSP.unlink(memberPath),
      catch: fail(input.root, "filesystem", memberPath),
    });
  });

  const dispose: MultiFolderWorkspace["Service"]["dispose"] = (root) =>
    Effect.tryPromise({
      try: async () => {
        const marker = path.join(root, MULTI_FOLDER_MARKER_FILE);
        await NodeFSP.rm(marker, { force: true });
        await NodeFSP.rmdir(root).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return;
          // Something else is left: keep the folder, still marked, so its
          // contents are never lost.
          if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
            await NodeFSP.writeFile(marker, MARKER_CONTENTS);
            return;
          }
          throw error;
        });
      },
      catch: fail(root, "filesystem", root),
    });

  return MultiFolderWorkspace.of({
    members,
    linkedTargets,
    initialize,
    dispose,
    link,
    unlink,
  });
});

export const layer = Layer.effect(MultiFolderWorkspace, make);
