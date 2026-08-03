import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

export function SettingsSurface() {
  return (
    <SurfacePlaceholder
      surfaceId="settings"
      title="Settings"
      description="Machine-local and workspace collaboration settings. Mutations remain Service commands; launch secret values never enter Node bodies."
    />
  );
}
