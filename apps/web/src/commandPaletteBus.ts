import type { EnvironmentId, ProjectId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

/** A multi-folder project to add folders to, from its settings. */
export interface CommandPaletteLinkFoldersTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in" | "link-folders";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** With `open: "link-folders"`: the project the chosen folders are linked into. */
  readonly linkFolders?: CommandPaletteLinkFoldersTarget;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
