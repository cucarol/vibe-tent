import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

export function SettingsSurface() {
  return (
    <SurfacePlaceholder
      surfaceId="settings"
      title="Settings"
      description="Machine-local and workspace collaboration settings. Mutations remain Service commands; credentials never enter concept bodies."
    />
  );
}
