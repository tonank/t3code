import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectLinkedFolder } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { fileBasename } from "@t3tools/shared/path";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { ListRowLayout } from "../../components/ListRowLayout";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProjectOverviewRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const selectedEnvironmentIds = new Set(selectedTargets.map((entry) => entry.environmentId));
  const members =
    group?.members
      .map((entry) => entry.project)
      .filter((project) => selectedEnvironmentIds.has(project.environmentId)) ?? [];

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Project overview" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {members.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              This project has no checkout on the selected connected environments. Change the filter
              above.
            </Text>
          ) : (
            <ProjectOverviewContent
              key={`${selectedProjectKey}:${members.map((member) => member.id).join(",")}`}
              members={members}
              environments={selectedTargets}
            />
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function ProjectOverviewContent(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const representative = props.members[0]!;
  const displayName = deriveProjectGroupLabel({ representative, members: props.members });
  // Grouped checkouts each get a Folders section, named by their folder, and by
  // environment too when the group spans several.
  const spansEnvironments = new Set(props.members.map((member) => member.environmentId)).size > 1;
  const [draftName, setDraftName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project name update",
    reportFailure: true,
  });
  const nextName = (draftName ?? displayName).trim();
  const canSave = !isSaving && nextName.length > 0 && nextName !== displayName;

  const saveName = () => {
    if (!canSave) return;
    setIsSaving(true);
    void (async () => {
      try {
        const results = await Promise.all(
          props.members.map((member) =>
            updateProject({
              environmentId: member.environmentId,
              input: { projectId: member.id, title: nextName },
            }),
          ),
        );
        if (results.every((result) => result._tag !== "Failure")) setDraftName(null);
      } finally {
        setIsSaving(false);
      }
    })();
  };

  return (
    <>
      <View className="flex-row items-center gap-4 px-2">
        <ProjectFavicon
          environmentId={representative.environmentId}
          projectTitle={representative.title}
          workspaceRoot={representative.workspaceRoot}
          faviconPath={representative.faviconPath}
          projectIcon={representative.projectIcon}
          size={48}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-semibold text-foreground" numberOfLines={2}>
            {displayName}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {props.members.length === 1 ? "1 checkout" : `${props.members.length} checkouts`}
          </Text>
        </View>
      </View>

      <SettingsSection title="Project">
        <View className="gap-3 p-4">
          <Text className="text-sm font-t3-medium text-foreground-muted">Name</Text>
          <View className="flex-row items-center gap-3">
            <AppTextInput
              accessibilityLabel="Project name"
              className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              value={draftName ?? displayName}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              editable={!isSaving}
            />
            {canSave ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save project name"
                onPress={saveName}
                className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">Save</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Checkouts">
        {props.members.map((member, index) => {
          const environment = props.environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          return (
            <View
              key={`${member.environmentId}:${member.id}`}
              className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
            >
              <Text
                className={
                  Platform.OS === "android"
                    ? "text-base text-foreground"
                    : "text-lg text-foreground"
                }
              >
                {environment?.label ?? "Environment"}
              </Text>
              {environment?.displayUrl ? (
                <Text className="text-sm leading-normal text-foreground-muted">
                  {environment.displayUrl}
                </Text>
              ) : null}
              <Text className="text-sm leading-normal text-foreground-muted" selectable>
                {member.workspaceRoot}
              </Text>
            </View>
          );
        })}
      </SettingsSection>

      {props.members.map((member) => {
        const environmentLabel =
          props.environments.find((entry) => entry.environmentId === member.environmentId)?.label ??
          "this environment";
        const title =
          props.members.length === 1
            ? "Folders"
            : spansEnvironments
              ? `Folders in ${fileBasename(member.workspaceRoot)} on ${environmentLabel}`
              : `Folders in ${fileBasename(member.workspaceRoot)}`;
        return (
          <ProjectFoldersSection
            key={`${member.environmentId}:${member.id}`}
            project={member}
            title={title}
          />
        );
      })}
    </>
  );
}

/** A multi-folder project's folders on one environment; nothing for any other project. */
function ProjectFoldersSection(props: {
  readonly project: EnvironmentProject;
  readonly title: string;
}) {
  const navigation = useNavigation();
  const { environmentId, id: projectId } = props.project;
  // Older servers do not know the linked-folders RPC.
  const supportsMultiFolderProjects =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.multiFolderProjects ===
    true;
  const foldersQuery = useEnvironmentQuery(
    supportsMultiFolderProjects
      ? projectEnvironment.linkedFolders({ environmentId, input: { projectId } })
      : null,
  );
  const canLink = useAtomValue(projectEnvironment.linkFolder.permissionAtom(environmentId));
  const canUnlink = useAtomValue(projectEnvironment.unlinkFolder.permissionAtom(environmentId));
  const unlinkFolder = useAtomCommand(projectEnvironment.unlinkFolder, { reportFailure: false });
  const [removingName, setRemovingName] = useState<string | null>(null);
  const folders = foldersQuery.data?.folders ?? null;
  if (folders === null) return null;

  const remove = async (folder: ProjectLinkedFolder) => {
    setRemovingName(folder.name);
    try {
      const result = await unlinkFolder({
        environmentId,
        input: { projectId, name: folder.name },
      });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not remove folder",
          error instanceof Error ? error.message : "The folder could not be removed.",
        );
        return;
      }
      foldersQuery.refresh();
    } finally {
      setRemovingName(null);
    }
  };
  return (
    <SettingsSection title={props.title}>
      {folders.map((folder) => (
        <ListRowLayout
          key={folder.name}
          icon="folder"
          label={folder.name}
          description={folder.missing ? `${folder.path} (not found)` : folder.path}
          disabled={removingName === folder.name}
          accessory={
            // Only links can be removed; a folder made inside the project holds its files.
            folder.linked && canUnlink ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${folder.name}`}
                disabled={removingName !== null}
                hitSlop={8}
                onPress={() => void remove(folder)}
                className="active:opacity-70"
              >
                <SymbolView
                  name="xmark.circle.fill"
                  size={Platform.OS === "android" ? 22 : 20}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            ) : null
          }
        />
      ))}
      {canLink ? (
        <View className={folders.length > 0 ? "border-t border-border-subtle" : undefined}>
          <SettingsActionRow
            icon="folder.badge.plus"
            label="Add folders"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsProjectAddFolders",
                  params: {
                    environmentId: String(environmentId),
                    linkProjectId: String(projectId),
                    linkProjectName: props.project.title,
                  },
                },
              })
            }
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
