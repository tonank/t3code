import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as MultiFolderWorkspace from "./MultiFolderWorkspace.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(MultiFolderWorkspace.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeFolders = Effect.fn("makeFolders")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-multi-folder-" }),
  );
  const make = (name: string) =>
    fileSystem
      .makeDirectory(path.join(base, name), { recursive: true })
      .pipe(Effect.orDie, Effect.as(path.join(base, name)));
  return { base, root: path.join(base, "project"), make };
});

it.layer(layerTest)("MultiFolderWorkspace", (it) => {
  describe("members", () => {
    it.effect("is null for a folder without the marker", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const { make } = yield* makeFolders();
        const plain = yield* make("plain");
        yield* make("plain/child");

        expect(yield* workspace.members(plain)).toBeNull();
        expect(yield* workspace.linkedTargets(plain)).toEqual([]);
      }),
    );

    it.effect("lists linked folders and folders in place, skipping hidden entries", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, make } = yield* makeFolders();
        const api = yield* make("repos/api");
        yield* workspace.initialize(root);
        yield* workspace.link({ root, target: api });
        yield* make("project/web");
        yield* make("project/.cache");
        yield* fileSystem.writeFileString(path.join(root, "notes.md"), "");

        const members = yield* workspace.members(root);

        expect(members).toEqual([
          { name: "api", path: path.join(root, "api"), linkTarget: api, missing: false },
          { name: "web", path: path.join(root, "web"), linkTarget: null, missing: false },
        ]);
        expect(yield* workspace.linkedTargets(root)).toEqual([api]);
      }),
    );

    it.effect("lists a dangling link as missing and ignores a link to a file", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { base, root, make } = yield* makeFolders();
        const api = yield* make("api");
        yield* workspace.initialize(root);
        yield* workspace.link({ root, target: api });
        yield* fileSystem.writeFileString(path.join(base, "notes.md"), "");
        yield* fileSystem.symlink(path.join(base, "notes.md"), path.join(root, "notes"));
        yield* fileSystem.symlink(path.join(base, "gone"), path.join(root, "gone"));

        expect(
          (yield* workspace.members(root))?.map((member) => [member.name, member.missing]),
        ).toEqual([
          ["api", false],
          ["gone", true],
        ]);
        expect(yield* workspace.linkedTargets(root)).toEqual([api]);
      }),
    );
  });

  describe("link", () => {
    it.effect(
      "names a second folder with the same basename apart and reuses an existing link",
      () =>
        Effect.gen(function* () {
          const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
          const { root, make } = yield* makeFolders();
          const first = yield* make("one/app");
          const second = yield* make("two/app");
          yield* workspace.initialize(root);

          const a = yield* workspace.link({ root, target: first });
          const b = yield* workspace.link({ root, target: second });
          const again = yield* workspace.link({ root, target: first });

          expect([a.name, b.name, again.name]).toEqual(["app", "app-2", "app"]);
        }),
    );

    it.effect("refuses the project folder itself or a folder containing it", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const path = yield* Path.Path;
        const { base, root, make } = yield* makeFolders();
        yield* workspace.initialize(root);

        const self = yield* workspace.link({ root, target: root }).pipe(Effect.flip);
        const parent = yield* workspace.link({ root, target: base }).pipe(Effect.flip);
        const inside = yield* workspace
          .link({ root, target: yield* make("project/checkout") })
          .pipe(Effect.flip);

        expect(self.reason).toBe("target-contains-root");
        expect(parent.reason).toBe("target-contains-root");
        expect(inside.reason).toBe("target-inside-root");

        // Members never overlap: a folder of a member, or one holding a member.
        const repo = yield* make("repos/mono");
        yield* make("repos/mono/packages/a");
        yield* workspace.link({ root, target: repo });
        const nested = yield* workspace
          .link({ root, target: path.join(repo, "packages", "a") })
          .pipe(Effect.flip);
        const holding = yield* workspace
          .link({ root, target: path.join(base, "repos") })
          .pipe(Effect.flip);
        expect(nested.reason).toBe("target-overlaps-member");
        expect(holding.reason).toBe("target-overlaps-member");
      }),
    );

    it.effect("expands a home path and refuses a relative one", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const { root } = yield* makeFolders();
        yield* workspace.initialize(root);

        const relative = yield* workspace.link({ root, target: "repos/app" }).pipe(Effect.flip);
        // `~` becomes the real home, so the missing folder is looked for there
        // rather than refused as relative.
        const home = yield* workspace
          .link({ root, target: "~/t3code-multi-folder-test-does-not-exist" })
          .pipe(Effect.flip);

        expect(relative.reason).toBe("target-not-absolute");
        expect(home.reason).toBe("target-missing");
      }),
    );

    it.effect("refuses a folder that is not a multi-folder project", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const { make } = yield* makeFolders();
        const plain = yield* make("plain");
        const target = yield* make("target");

        const error = yield* workspace.link({ root: plain, target }).pipe(Effect.flip);

        expect(error.reason).toBe("not-multi-folder");
      }),
    );
  });

  describe("unlink", () => {
    it.effect("removes the link and leaves the target's files alone", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, make } = yield* makeFolders();
        const api = yield* make("repos/api");
        yield* fileSystem.writeFileString(path.join(api, "keep.txt"), "kept");
        yield* workspace.initialize(root);
        yield* workspace.link({ root, target: api });

        yield* workspace.unlink({ root, name: "api" });

        expect(yield* workspace.members(root)).toEqual([]);
        expect(yield* fileSystem.readFileString(path.join(api, "keep.txt"))).toBe("kept");
      }),
    );

    it.effect("lists a link whose folder is gone as missing, and still removes it", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, make } = yield* makeFolders();
        const api = yield* make("repos/api");
        yield* workspace.initialize(root);
        yield* workspace.link({ root, target: api });
        yield* fileSystem.remove(api, { recursive: true });

        expect(yield* workspace.members(root)).toEqual([
          { name: "api", path: path.join(root, "api"), linkTarget: api, missing: true },
        ]);
        expect(yield* workspace.linkedTargets(root)).toEqual([]);

        yield* workspace.unlink({ root, name: "api" });

        expect(yield* workspace.members(root)).toEqual([]);
      }),
    );

    it.effect("refuses to remove a member that is not a link, or a name that leaves the root", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { base, root, make } = yield* makeFolders();
        yield* workspace.initialize(root);
        yield* make("project/checkout");
        const api = yield* make("repos/api");
        yield* fileSystem.symlink(api, path.join(base, "outside-link"));

        const inPlace = yield* workspace.unlink({ root, name: "checkout" }).pipe(Effect.flip);
        const traversal = yield* workspace
          .unlink({ root, name: path.join("..", "outside-link") })
          .pipe(Effect.flip);

        expect(inPlace.reason).toBe("member-not-linked");
        expect(traversal.reason).toBe("member-not-linked");
        expect(yield* fileSystem.exists(path.join(base, "outside-link"))).toBe(true);
      }),
    );

    it.effect("dispose removes an empty root and keeps a non-empty one marked", () =>
      Effect.gen(function* () {
        const workspace = yield* MultiFolderWorkspace.MultiFolderWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, make } = yield* makeFolders();
        yield* workspace.initialize(root);
        yield* make("project/checkout");

        yield* workspace.dispose(root);
        expect(yield* workspace.members(root)).toHaveLength(1);
        expect(yield* fileSystem.exists(path.join(root, "checkout"))).toBe(true);

        yield* fileSystem.remove(path.join(root, "checkout"), { recursive: true });
        yield* workspace.dispose(root);
        expect(yield* fileSystem.exists(root)).toBe(false);
      }),
    );
  });
});
