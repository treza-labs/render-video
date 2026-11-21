/**
 * The bundled action (dist/index.js) run the way the runner runs it: a node
 * process with INPUT_* variables, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY files,
 * against a local stand-in for Treza's API.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startMockTreza } from "./mock-treza.mjs";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const KEY = "treza_live_e2e_key";

/** Every input action.yml declares, named and defaulted the way the runner sets them. */
const DECLARED: Record<string, string> = {
  "api-key": "",
  mode: "video",
  prompt: "",
  model: "",
  duration: "",
  "aspect-ratio": "",
  "pipeline-id": "",
  inputs: "",
  "max-cost-usd": "",
  wait: "true",
  "timeout-minutes": "15",
  "download-path": "",
};

type Mock = Awaited<ReturnType<typeof startMockTreza>>;
let mock: Mock;

beforeAll(async () => {
  mock = await startMockTreza();
});
afterAll(async () => {
  await mock.close();
});

/** GITHUB_OUTPUT holds `name<<delimiter`, the value, then the delimiter. */
function parseOutputFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^([^<]+)<<(.+)$/);
    if (!head) continue;
    const value: string[] = [];
    for (i++; i < lines.length && lines[i] !== head[2]; i++) value.push(lines[i]!);
    out[head[1]!] = value.join("\n");
  }
  return out;
}

async function runDist(withInputs: Record<string, string>) {
  const workspace = await mkdtemp(path.join(tmpdir(), "render-video-e2e-"));
  const outputFile = path.join(workspace, "github_output");
  const summaryFile = path.join(workspace, "step_summary");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");
  const inputs = { ...DECLARED, ...withInputs };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    RUNNER_TEMP: workspace,
    TREZA_BASE_URL: mock.url,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;

  const child = spawn(process.execPath, [DIST], { cwd: workspace, env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    code,
    stdout,
    workspace,
    outputFile: await readFile(outputFile, "utf8"),
    outputs: parseOutputFile(await readFile(outputFile, "utf8")),
    summary: await readFile(summaryFile, "utf8"),
  };
}

const starts = () => mock.calls.filter((c: { tool: string }) => c.tool === "run_pipeline").length;

describe("dist/index.js", () => {
  it("renders, writes the outputs and the summary, and downloads the file", async () => {
    const before = starts();
    const r = await runDist({
      "api-key": KEY,
      prompt: "A paper boat on a pond",
      "aspect-ratio": "9:16",
      "max-cost-usd": "1.00",
      "download-path": "out/",
    });

    expect(r.code, r.stdout).toBe(0);
    expect(starts() - before).toBe(1);
    expect(r.outputs).toMatchObject({ status: "success", "price-usd": "0.28" });
    expect(r.outputFile.match(/^status<</gm)).toHaveLength(1);
    expect(r.outputs["run-id"]).toMatch(/#\d+$/);
    expect(r.outputs["pipeline-id"]).toMatch(/^pipeline_mock_/);
    expect(r.outputs.url).toBe(`${mock.url}/media/clip.mp4?s=sig`);
    expect(JSON.parse(r.outputs.files!)).toEqual([`${mock.url}/media/clip.mp4?s=sig`]);
    expect(r.outputs.path).toBe(path.join(r.workspace, "out", "clip.mp4"));
    expect(await readFile(r.outputs.path!, "utf8")).toBe("fake clip.mp4 bytes");

    expect(r.summary).toContain("### Treza video: success");
    expect(r.summary).toContain("| Price | $0.28 (max-cost-usd $1.00) |");

    // The key is masked first and appears nowhere else.
    expect(r.stdout.split("\n")[0]).toBe(`::add-mask::${KEY}`);
    expect(r.stdout.split(KEY).length - 1).toBe(1);
    expect(r.stdout).toContain("Rendering: 1 of 3 steps done (now: Video).");

    const quote = mock.calls.filter((c: { tool: string }) => c.tool === "make_video").at(-1);
    expect(quote.args).toEqual({ prompt: "A paper boat on a pond", aspectRatio: "9:16", maxPriceUsd: 1 });
    expect(quote.userAgent).toMatch(/^treza-render-video\//);
  }, 30_000);

  it("over the cap: exits 1, starts nothing, says nothing was charged", async () => {
    const before = starts();
    const r = await runDist({ "api-key": KEY, prompt: "A paper boat", "max-cost-usd": "0.10" });
    expect(r.code).toBe(1);
    expect(starts() - before).toBe(0);
    expect(r.stdout).toContain("::error::This render costs $0.28, over max-cost-usd of $0.10. Nothing was started and nothing was charged.");
    expect(r.outputs).toMatchObject({ status: "not-started", "price-usd": "0.28" });
    expect(r.summary).toContain("**Not started:**");
  }, 30_000);

  it("image mode shows the picture in the summary", async () => {
    const r = await runDist({ "api-key": KEY, mode: "image", prompt: "A red kite", wait: "true" });
    expect(r.code, r.stdout).toBe(0);
    expect(r.outputs.url).toBe(`${mock.url}/media/picture.png?s=sig`);
    expect(r.summary).toContain(`<img src="${mock.url}/media/picture.png?s=sig"`);
  }, 30_000);

  it("a missing cap fails before anything is sent", async () => {
    const before = mock.calls.length;
    const r = await runDist({ "api-key": KEY, prompt: "A paper boat" });
    expect(r.code).toBe(1);
    expect(mock.calls.length).toBe(before);
    expect(r.stdout).toContain("::error::max-cost-usd is required in video mode");
  }, 30_000);
});
