import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const config: StorybookConfig = {
  stories: ["../src/desktop/renderer-next/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: [
    {
      from: "../node_modules/@excalidraw/excalidraw/dist/prod",
      to: "/excalidraw-assets",
    },
  ],
  docs: {
    defaultName: "文档",
  },
  async viteFinal(viteConfig, { configType }) {
    return mergeConfig(viteConfig, {
      define: {
        __TENT_STORYBOOK__: JSON.stringify("true"),
        "import.meta.env.STORYBOOK": JSON.stringify("true"),
        "process.env.STORYBOOK": JSON.stringify("true"),
        "process.env.NODE_ENV": JSON.stringify(
          configType === "PRODUCTION" ? "production" : "development"
        ),
      },
      resolve: {
        alias: {
          "@renderer-next": path.join(root, "src/desktop/renderer-next"),
        },
        extensions: [".mjs", ".js", ".ts", ".tsx", ".json"],
      },
      server: {
        fs: {
          allow: [root],
        },
      },
      css: {
        devSourcemap: true,
      },
    });
  },
};

export default config;
