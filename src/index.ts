/** Entry point the runner starts (action.yml: runs.main = dist/index.js). */
import * as core from "@actions/core";

import { runAction } from "./run.js";

await runAction({
  getInput: (name) => core.getInput(name),
  setOutput: (name, value) => core.setOutput(name, value),
  setSecret: (value) => core.setSecret(value),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  setFailed: (message) => core.setFailed(message),
  writeSummary: async (markdown) => {
    // Outside a runner (no GITHUB_STEP_SUMMARY) there is nowhere to write it.
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    await core.summary.addRaw(markdown, true).write();
  },
}).catch((err: unknown) => core.setFailed(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`));
