import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { fileBasename } from "@t3tools/shared/path";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The folders of each multi-folder checkout in the group. Renders nothing for other projects. */
export function ProjectFoldersSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  // Grouped checkouts each get a section, named by their folder, and by
  // environment too when the group spans several.
  const spansEnvironments = new Set(members.map((member) => member.environmentId)).size > 1;
  return members.map((member) => (
    <ProjectFoldersSection
      key={member.physicalProjectKey}
      member={member}
      title={
        members.length === 1
          ? "Folders"
          : `Folders in ${fileBasename(member.workspaceRoot)}${
              spansEnvironments ? ` on ${member.environmentLabel ?? "this environment"}` : ""
            }`
      }
    />
  ));
}

function ProjectFoldersSection({
  member,
  title,
}: {
  member: SidebarProjectGroupMember;
  title: string;
}) {
  const { environments } = useEnvironments();
  // Older servers lack the RPCs; skip the query rather than show its failure.
  const supported =
    environments.find((environment) => environment.environmentId === member.environmentId)
      ?.serverConfig?.environment.capabilities.multiFolderProjects === true;
  const linkedFoldersAtom = supported
    ? projectEnvironment.linkedFolders({
        environmentId: member.environmentId,
        input: { projectId: member.id },
      })
    : null;
  const query = useEnvironmentQuery(linkedFoldersAtom);
  const canLink = useAtomValue(projectEnvironment.linkFolder.permissionAtom(member.environmentId));
  const canUnlink = useAtomValue(
    projectEnvironment.unlinkFolder.permissionAtom(member.environmentId),
  );
  const unlinkFolder = useAtomCommand(projectEnvironment.unlinkFolder, { reportFailure: false });
  const [isPending, setIsPending] = useState(false);

  const folders = query.data?.folders ?? null;
  if (folders === null) return null;

  const removeFolder = async (name: string) => {
    if (isPending) return;
    setIsPending(true);
    try {
      const result = await unlinkFolder({
        environmentId: member.environmentId,
        input: { projectId: member.id, name },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not remove folder",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (linkedFoldersAtom) appAtomRegistry.refresh(linkedFoldersAtom);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <SettingsSection title={title}>
      {folders.map((folder) => (
        <SettingsRow
          key={folder.name}
          title={folder.name}
          description={folder.missing ? `${folder.path} (not found)` : folder.path}
          control={
            folder.linked && canUnlink ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isPending}
                aria-label={`Remove ${folder.name}`}
                onClick={() => void removeFolder(folder.name)}
              >
                Remove
              </Button>
            ) : null
          }
        />
      ))}
      {canLink ? (
        <SettingsRow
          title="Add folders"
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                openCommandPalette({
                  open: "link-folders",
                  linkFolders: {
                    environmentId: member.environmentId,
                    projectId: member.id,
                    projectName: member.title,
                  },
                })
              }
            >
              Add folders
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
