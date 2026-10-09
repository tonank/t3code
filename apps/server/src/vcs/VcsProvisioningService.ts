import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import { isMultiFolderRoot } from "../workspace/MultiFolderWorkspace.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  {
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "A concrete VCS driver kind is required for repository provisioning.",
      }),
    );
  }
  return Effect.succeed(kind);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const initRepository: VcsProvisioningService["Service"]["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    // A multi-folder project's folder only links other folders. Git for
    // Windows reads a junction as a plain directory, so a repository there
    // would commit, and a restore could clean, every linked folder's files.
    if (yield* Effect.promise(() => isMultiFolderRoot(input.cwd))) {
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.initRepository",
        kind,
        detail:
          "This project folder links other folders. Initialize a repository in one of them instead.",
      });
    }
    const driver = yield* registry.get(kind);
    return yield* driver.initRepository(input);
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make);
