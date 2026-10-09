import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  ProjectLinkedFolder,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts. A multi-folder project also lists its linkedFolders.",
  parameters: Schema.Struct({ projectId: ProjectId }),
  success: Schema.Struct({
    ...Project.fields,
    linkedFolders: Schema.optional(Schema.Array(ProjectLinkedFolder)),
  }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Omit workspaceRoot to start a new project from just its title: the app makes a Git repository for it in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Omit workspaceRoot and pass linkedFolders to start a multi-folder project instead: the app makes a folder in its projects folder that links each one, and agents in it can read and edit every folder; it otherwise behaves like any project folder that holds those folders. Each call creates a new request; an existing registered workspace is rejected. Clone separately with t3_project_clone when needed.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
    linkedFolders: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)).annotate({
        description:
          "Absolute folder paths for a multi-folder project, each linked under its folder name. Only without workspaceRoot.",
      }),
    ),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectFoldersTool = Tool.make("t3_project_folders", {
  ...shared,
  description:
    "Link or unlink the folders of a multi-folder project, and list the result. Linking adds a folder anywhere on this machine under its folder name; unlinking removes only the link, never the folder's files. To only list, read the project with t3_project_read. folders is null for a project that is not a multi-folder project.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    link: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({ description: "Absolute folder paths." }),
    ),
    unlink: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({ description: "Folder names in the project." }),
    ),
  }),
  success: Schema.Struct({ folders: Schema.NullOr(Schema.Array(ProjectLinkedFolder)) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with t3_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    'Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts. Use this when the user requests independent work, a new thread, or a PR stack in its own worktree; use delegate_task for child subagents. Set workspaceStrategy to {type:"worktree",baseRef:"parent-branch",branch:"new-branch",startFromOrigin:false} for a new worktree based on local commits, or {type:"existing_worktree",worktreePath:"/absolute/path",branch:"existing-branch"} to use an existing checkout. For upstream commits, set startFromOrigin:true. Omitted workspaceStrategy means the project root, NOT the caller\'s worktree. Omit projectId/modelSelection/modes to inherit those settings from the calling thread; a caller outside a T3 thread must pass projectId and gets the project\'s default model. Set scratch:true instead of projectId for a thread without a project: it runs in a fresh folder of its own, outside any repository. Put the task in message. Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Each call creates a new launch with no retry key; retain threadId and use t3_thread_read/t3_thread_wait to follow preparation. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; T3 Code shows the thread\'s current title. After errors or lost responses, inspect t3_thread_list before retrying. Attachments must be pending uploads. The new thread may not run with broader runtime or interaction modes than the caller: the calling T3 thread\'s own modes, or the permission mode an outside agent was approved with.',
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef; existing_worktree binds worktreePath, which must be one of the project's git worktrees; root uses the project checkout. Omitted means root, not the caller's worktree. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectFoldersTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
