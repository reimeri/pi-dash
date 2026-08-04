import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  vitePlugin: {
    inspector: {
      toggleKeyCombo: "alt-x",
      holdMode: false,
      showToggleButton: "always",
      toggleButtonPos: "bottom-right",
    },
  },
};
