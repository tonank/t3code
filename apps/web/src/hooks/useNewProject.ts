import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getNewProjectRepository,
  type NewProjectPublishTarget,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/** Opens a new thread draft in a project the server just created. */
function useOpenCreatedProject() {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (environmentId: EnvironmentId, projectId: ProjectId): Promise<void> => {
      const projectRef = scopeProjectRef(environmentId, projectId);
      // Drafts key off the project's stored path, so wait for the create event
      // to reach the store before opening one.
      const project = await waitForProject(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
          }),
        );
        return null;
      });
      if (project === null) return;
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: errorMessage(error),
          }),
        );
      });
    },
    [handleNewThread],
  );
}

/**
 * Starts a project from just a name. The server makes a folder under its
 * `newProjectsRoot` with a README, an icon, and a first commit; this then
 * opens a new thread draft in it. With `publishTo`, it also publishes the
 * repository as private on that host, without holding up the draft.
 *
 * Resolves to whether the project was created.
 */
export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const openCreatedProject = useOpenCreatedProject();

  const publishNewRepository = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
      readonly target: NewProjectPublishTarget;
    }) => {
      const { label } = input.target.definition;
      const result = await publishRepository({
        environmentId: input.environmentId,
        input: {
          cwd: input.workspaceRoot,
          provider: input.target.definition.kind,
          repository: getNewProjectRepository(input.target, input.workspaceRoot),
          visibility: "private",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not create the ${label} repository`,
              description: `${errorMessage(squashAtomCommandFailure(result))} Use Publish Repository in the Git menu to try again.`,
            }),
          );
        }
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Published to ${label}`,
          description: result.value.repository.nameWithOwner,
        }),
      );
    },
    [publishRepository],
  );

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly publishTo: NewProjectPublishTarget | null;
    }): Promise<boolean> => {
      const result = await createNew({
        environmentId: input.environmentId,
        input: { name: input.name },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }

      const { projectId, workspaceRoot, commitError } = result.value;
      // The folder sits in T3 Code's data directory, so always say where.
      toastManager.add(
        stackedThreadToast(
          commitError === undefined
            ? { type: "success", title: `Created ${input.name}`, description: workspaceRoot }
            : {
                type: "warning",
                title: `Created ${input.name} without a first commit`,
                description: `${commitError} The project is in ${workspaceRoot}.`,
              },
        ),
      );
      if (input.publishTo) {
        void publishNewRepository({
          environmentId: input.environmentId,
          workspaceRoot,
          target: input.publishTo,
        });
      }

      await openCreatedProject(input.environmentId, projectId);
      return true;
    },
    [createNew, openCreatedProject, publishNewRepository],
  );
}

/**
 * Starts a project gathering existing folders. The server makes a folder under
 * its `newProjectsRoot` linking each one; this then opens a new thread draft in
 * it. Resolves to whether the project was created.
 */
export function useNewMultiFolderProject() {
  const createMultiFolder = useAtomCommand(projectEnvironment.createMultiFolder, {
    reportFailure: false,
  });
  const openCreatedProject = useOpenCreatedProject();
  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly folders: ReadonlyArray<string>;
    }): Promise<boolean> => {
      const result = await createMultiFolder({
        environmentId: input.environmentId,
        input: { name: input.name, folders: input.folders },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }
      const { projectId, workspaceRoot } = result.value;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Created ${input.name}`,
          description: workspaceRoot,
        }),
      );
      await openCreatedProject(input.environmentId, projectId);
      return true;
    },
    [createMultiFolder, openCreatedProject],
  );
}

/**
 * Links folders into a multi-folder project one at a time, stopping at the
 * first failure. Returns the folders that were linked, so a retry can leave
 * them out.
 */
export function useLinkProjectFolders() {
  const linkFolder = useAtomCommand(projectEnvironment.linkFolder, { reportFailure: false });
  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly folders: ReadonlyArray<string>;
    }): Promise<ReadonlyArray<string>> => {
      const linked: string[] = [];
      for (const folder of input.folders) {
        const result = await linkFolder({
          environmentId: input.environmentId,
          input: { projectId: input.projectId, folder },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Could not add ${fileBasename(folder)}`,
                description: errorMessage(squashAtomCommandFailure(result)),
              }),
            );
          }
          break;
        }
        linked.push(folder);
      }
      if (linked.length > 0) {
        // Settings -> Folders lists them from this query.
        appAtomRegistry.refresh(
          projectEnvironment.linkedFolders({
            environmentId: input.environmentId,
            input: { projectId: input.projectId },
          }),
        );
      }
      return linked;
    },
    [linkFolder],
  );
}
