import type { Decorator, Preview } from "@storybook/react-vite";

import "../src/desktop/renderer-next/styles/tokens.css";
import "../src/desktop/renderer-next/styles/shell.css";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== "undefined" && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = new URL(
    "/excalidraw-assets/",
    window.location.href
  ).href;
}

const withTentRoot: Decorator = (Story) => (
  <div className="tn-storybook-root" data-testid="storybook-root">
    <Story />
  </div>
);

const preview: Preview = {
  decorators: [withTentRoot],
  parameters: {
    layout: "fullscreen",
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    options: {
      storySort: {
        order: ["基础", "控件", "状态", "主界面", "Canvas V5"],
      },
    },
    backgrounds: {
      default: "Tent 工作台",
      values: [
        { name: "Tent 工作台", value: "#e8e7e4" },
        { name: "Canvas", value: "#e1e1de" },
        { name: "纸面", value: "#f7f6f3" },
      ],
    },
  },
};

export default preview;
