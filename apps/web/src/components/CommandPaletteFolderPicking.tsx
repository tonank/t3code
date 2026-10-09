import { CheckIcon, FolderGit2Icon, FolderIcon, XIcon } from "lucide-react";

import type { PickedFolder } from "@t3tools/client-runtime/operations/projects";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Folders picked in Local folder for a multi-folder project: pinned as chips
// under the path, marked on their browse rows, and listed in the name step.

export const PICKED_FOLDER_ITEM_PREFIX = "browse:multi-folder:picked:";

export const FOLDER_INCLUDED_TRAILING = (
  <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70 text-xs">
    <CheckIcon className="size-3.5" />
    Included
  </span>
);

/** The name step's rows: the folders the project will gather. Back returns to the chips to change them. */
export function buildPickedFolderItems(
  picked: ReadonlyArray<PickedFolder>,
): CommandPaletteActionItem[] {
  return picked.map((folder) => ({
    kind: "action",
    value: `${PICKED_FOLDER_ITEM_PREFIX}${folder.path}`,
    searchTerms: [],
    title: folder.name,
    description: folder.path,
    icon: folder.isGitRepository ? (
      <FolderGit2Icon className={ITEM_ICON_CLASS} />
    ) : (
      <FolderIcon className={ITEM_ICON_CLASS} />
    ),
    keepOpen: true,
    run: async () => {},
  }));
}

export function PickedFolderChips(props: {
  folders: ReadonlyArray<PickedFolder>;
  onRemove: (folder: PickedFolder) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {props.folders.map((folder) => (
        <Tooltip key={folder.path}>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                size="control"
                render={<button type="button" />}
                aria-label={`Remove ${folder.name}`}
                // Keep focus in the palette input so typing and Enter keep working.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onRemove(folder)}
              />
            }
          >
            {folder.isGitRepository ? <FolderGit2Icon /> : <FolderIcon />}
            <span className="max-w-40 truncate">{folder.name}</span>
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{folder.path}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
