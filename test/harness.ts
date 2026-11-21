/** A scripted Treza and a stand-in runner, so the action can be driven without a key or a network. */
import { runAction, type Deps, type Outcome } from "../src/run.js";

/** An HTTP answer, or "network" for a request that fails before any answer. */
export type Reply = [number, Record<string, unknown>] | "network";

export const BASE = "https://treza.test";

export type Harness = {
  run: () => Promise<Outcome>;
  calls: { tool: string; args: Record<string, unknown>; headers: Record<string, string> }[];
  asked: (tool: string) => Record<string, unknown>[];
  media: { url: string; headers: Record<string, string> }[];
  outputs: Record<string, string>;
  /** Every setOutput call's name, in order. */
  outputNames: string[];
  secrets: string[];
  failed: string[];
  infos: string[];
  warnings: string[];
  summaries: string[];
  sleeps: number[];
  /** "secret" and "fetch" in the order they happened. */
  events: string[];
  clock: () => number;
};

export function harness(
  inputs: Record<string, string>,
  answers: Record<string, Reply[]>,
  files: Record<string, { body: string; type: string; status?: number }[]> = {},
  extra: Partial<Deps> = {},
): Harness {
  let t = 0;
  const h: Omit<Harness, "run"> = {
    calls: [],
    asked: (tool) => h.calls.filter((c) => c.tool === tool).map((c) => c.args),
    media: [],
    outputs: {},
    outputNames: [],
    secrets: [],
    failed: [],
    infos: [],
    warnings: [],
    summaries: [],
    sleeps: [],
    events: [],
    clock: () => t,
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    h.events.push("fetch");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith(`${BASE}/api/v1/tools/`)) {
      const tool = url.slice(`${BASE}/api/v1/tools/`.length);
      h.calls.push({ tool, args: JSON.parse(String(init?.body ?? "{}")), headers });
      const next = answers[tool]?.shift();
      if (!next) throw new Error(`no scripted answer for ${tool}`);
      if (next === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(next[1]), { status: next[0], headers: { "content-type": "application/json" } });
    }
    h.media.push({ url, headers });
    const file = files[url]?.shift();
    if (!file) return new Response("not found", { status: 404 });
    return new Response(file.body, { status: file.status ?? 200, headers: { "content-type": file.type } });
  }) as typeof fetch;

  const deps: Deps = {
    getInput: (name) => inputs[name] ?? "",
    setOutput: (name, value) => {
      h.outputNames.push(name);
      h.outputs[name] = value;
    },
    setSecret: (value) => {
      h.events.push("secret");
      h.secrets.push(value);
    },
    info: (m) => h.infos.push(m),
    warning: (m) => h.warnings.push(m),
    setFailed: (m) => h.failed.push(m),
    writeSummary: async (md) => {
      h.summaries.push(md);
    },
    fetch: fetchFn,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    env: { TREZA_BASE_URL: BASE },
    ...extra,
  };
  return { ...h, run: () => runAction(deps) } as Harness;
}

export const KEY = "treza_live_test_key";
export const VIDEO_URL = "https://media.trezalabs.test/api/media/generated/video/clip-1.mp4?s=sig";
export const IMAGE_URL = "https://media.trezalabs.test/api/media/generated/image/pic-1.png?s=sig";

/** What make_video answers (lib/mcp/server.ts estimatePayload plus the prepared video). */
export const VIDEO_QUOTE = {
  pipelineId: "pipeline_1",
  pipelineName: "Video: a fox runs",
  quoteId: "q1",
  estimatedChargeUsd: 0.28,
  balanceUsd: 20.76,
  enforced: true,
  sufficient: true,
  model: { id: "google/veo-3.1-lite", name: "Veo 3.1 Lite" },
  durationSec: 4,
  aspectRatio: "9:16",
  withAudio: true,
};

export const DONE = {
  runId: "r1",
  pipelineId: "pipeline_1",
  status: "success",
  durationMs: 56000,
  outputs: { video: VIDEO_URL },
  nodes: [],
};
