// Loads the Rust addon built from native/ and answers the page's commands with it.
import { createRequire } from "node:module";

export default async function activate({ dir, dataDir, handle, log }) {
  const native = createRequire(import.meta.url)(`${dir}/native/plugin.node`);
  native.init(dataDir);
  handle("invoke", async ({ cmd, args }) => JSON.parse(await native.invoke(cmd, JSON.stringify(args ?? null))));
  log("JPerformance recorder started, data in " + dataDir);
}
