// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import bun from "@wyattjoh/astro-bun-adapter";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://seriously-quizzacious.blog",

  adapter: bun(),

  security: {
    checkOrigin: true,
  },

  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },

  integrations: [mdx(), sitemap()],

  vite: {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@layouts": fileURLToPath(new URL("./src/layouts", import.meta.url)),
        "@pages": fileURLToPath(new URL("./src/pages", import.meta.url)),
        "@styles": fileURLToPath(new URL("./src/styles", import.meta.url)),
        "@components": fileURLToPath(
          new URL("./src/components", import.meta.url),
        ),
        "@lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
        "@schemas": fileURLToPath(new URL("./src/schemas", import.meta.url)),
        "@content": fileURLToPath(new URL("./src/content", import.meta.url)),
      },
    },
    optimizeDeps: {
      include: ["arktype"],
    },
  },
});
