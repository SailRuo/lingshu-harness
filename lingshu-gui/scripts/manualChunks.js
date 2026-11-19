/**
 * Manual chunk splitting strategy for Vite/Rollup.
 * Keeps heavy vendor modules in stable, cache-friendly chunks.
 */

const chunkMap = {
  "@arco-design/web-vue": "arco",
  "@xterm/xterm": "terminal",
  marked: "markdown",
  "@tauri-apps/api": "tauri-bridge",
  "vue-router": "vue-core",
  "lodash-es": "vendor",
};

export function createManualChunks() {
  return (id) => {
    if (!id.includes("node_modules")) return;
    for (const [pattern, chunk] of Object.entries(chunkMap)) {
      if (id.includes(pattern)) return chunk;
    }
  };
}
