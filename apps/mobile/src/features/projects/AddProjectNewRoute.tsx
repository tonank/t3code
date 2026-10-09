import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectNewScreen } from "./AddProjectScreen";

type AddProjectNewRouteParams = {
  readonly environmentId?: string | string[];
  /** From Local folder: the project gathers these folders instead of starting empty. */
  readonly folders?: string | string[];
  /** The subset of `folders` that are Git repositories, for their icon. */
  readonly repositories?: string | string[];
};

export function AddProjectNewRoute({
  route,
}: StaticScreenProps<AddProjectNewRouteParams | undefined>) {
  return <AddProjectNewScreen {...(route.params ?? {})} />;
}
