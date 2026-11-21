/** The action against a scripted Treza: quote, cap, balance, one start, wait, outputs, summary, download. */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fileNameFor } from "../src/download.js";
import { nothingCharged, outputUrls, resolveBaseUrl, USER_AGENT, VERSION } from "../src/treza.js";
import { DONE, IMAGE_URL, KEY, VIDEO_QUOTE, VIDEO_URL, harness } from "./harness.js";

const video = (more: Record<string, string> = {}) => ({ "api-key": KEY, prompt: "a fox runs", "max-cost-usd": "1.00", ...more });

describe("video", () => {
  it("quotes, starts once with the quoteId, waits and sets the outputs", async () => {
    const h = harness(video({ "aspect-ratio": "9:16", duration: "4" }), {
      make_video: [[200, VIDEO_QUOTE]],
      run_pipeline: [[200, { runId: "r1", status: "running" }]],
      get_run: [[200, { status: "running", pollAfterSec: 5, progress: { done: 1, total: 3, current: ["Video"] } }], [200, DONE]],
    });
    const out = await h.run();

    expect(out.ok).toBe(true);
    expect(h.failed).toEqual([]);
    expect(h.asked("make_video")).toEqual([{ prompt: "a fox runs", durationSec: 4, aspectRatio: "9:16", maxPriceUsd: 1 }]);
    expect(h.asked("run_pipeline")).toEqual([{ pipelineId: "pipeline_1", quoteId: "q1" }]);
    expect(h.asked("get_run")).toEqual([
      { pipelineId: "pipeline_1", runId: "r1" },
      { pipelineId: "pipeline_1", runId: "r1" },
    ]);
    expect(h.sleeps).toEqual([5000]);
    expect(h.outputs).toEqual({
      "pipeline-id": "pipeline_1",
      "price-usd": "0.28",
      "run-id": "r1",
      status: "success",
      files: JSON.stringify([VIDEO_URL]),
      url: VIDEO_URL,
    });
    expect(h.outputNames).toEqual(["pipeline-id", "price-usd", "run-id", "status", "files", "url"]);
    expect(h.infos.join("\n")).toContain("Quoted $0.28 for a 4s 9:16 video on Veo 3.1 Lite. max-cost-usd is $1.00.");
    expect(h.infos.join("\n")).toContain("Rendering: 1 of 3 steps done (now: Video).");

    const headers = h.calls[0]!.headers;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["User-Agent"]).toBe(USER_AGENT);

    const summary = h.summaries.at(-1)!;
    expect(summary).toContain("### Treza video: success");
    expect(summary).toContain("| Price | $0.28 (max-cost-usd $1.00) |");
    expect(summary).toContain("| Model | Veo 3.1 Lite |");
    expect(summary).toContain("[pipeline_1](https://www.trezalabs.com/platform/pipelines/pipeline_1)");
    expect(summary).toContain(`[clip-1.mp4](${VIDEO_URL})`);
    expect(summary).not.toContain("<img");
  });

  it("masks the key before anything is sent", async () => {
    const h = harness(video(), { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] });
    await h.run();
    expect(h.secrets).toEqual([KEY]);
    expect(h.events[0]).toBe("secret");
  });

  it("refuses to run without max-cost-usd, and sends nothing", async () => {
    const h = harness({ "api-key": KEY, prompt: "a fox runs" }, {});
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toContain("max-cost-usd is required in video mode");
    expect(h.calls).toEqual([]);
    expect(h.secrets).toEqual([KEY]);
    expect(h.outputs).toEqual({ status: "not-started" });
    expect(h.summaries).toEqual([]);
  });

  it("a quote over the cap starts nothing", async () => {
    const h = harness(video({ "max-cost-usd": "0.10" }), { make_video: [[200, VIDEO_QUOTE]] });
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toBe(
      "This render costs $0.28, over max-cost-usd of $0.10. Nothing was started and nothing was charged. Raise max-cost-usd, or ask for less (a shorter clip or a cheaper model).",
    );
    expect(h.asked("run_pipeline")).toEqual([]);
    expect(h.asked("make_video")[0]!.maxPriceUsd).toBe(0.1);
    expect(h.outputs.status).toBe("not-started");
    expect(h.outputs["price-usd"]).toBe("0.28");
    expect(h.summaries.at(-1)).toContain("**Not started:** This render costs $0.28");
  });

  it("Treza's own over-budget refusal starts nothing", async () => {
    const h = harness(video({ "max-cost-usd": "0.10" }), {
      make_video: [[400, { error: "This video costs $0.28 ... Nothing was created or charged.", code: "OVER_BUDGET", estimatedChargeUsd: 0.28 }]],
    });
    await h.run();
    expect(h.failed[0]).toContain("This render costs $0.28, over max-cost-usd of $0.10. Nothing was started and nothing was charged.");
    expect(h.asked("run_pipeline")).toEqual([]);
  });

  it("a short balance starts nothing and says where to add credits", async () => {
    const h = harness(video(), {
      make_video: [[200, { ...VIDEO_QUOTE, sufficient: false, balanceUsd: 0.05, topUpUrl: "https://www.trezalabs.com/platform/settings?topup=1" }]],
    });
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toBe(
      "This render costs $0.28 and your Treza balance is $0.05. Nothing was started and nothing was charged. Add credits at https://www.trezalabs.com/platform/settings?topup=1",
    );
    expect(h.asked("run_pipeline")).toEqual([]);
  });

  it("a start that gets no answer is never tried again", async () => {
    const h = harness(video(), { make_video: [[200, VIDEO_QUOTE]], run_pipeline: ["network", [200, { runId: "r2" }]] });
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.asked("run_pipeline")).toHaveLength(1);
    expect(h.asked("get_run")).toEqual([]);
    expect(h.failed[0]).toContain("The render may have started, so it was not tried again");
    expect(h.failed[0]).not.toContain("Nothing was charged");
    expect(h.outputs.status).toBe("unknown");
  });

  it("a start that gets a server error is never tried again", async () => {
    const h = harness(video(), { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[502, { error: "The tool gave no answer (HTTP 502).", code: "NO_RESULT" }], [200, { runId: "r2" }]] });
    await h.run();
    expect(h.asked("run_pipeline")).toHaveLength(1);
    expect(h.failed[0]).toContain("Treza did not confirm the start (HTTP 502)");
  });

  it("a refused start says Treza's reason and that nothing was charged", async () => {
    const h = harness(video(), {
      make_video: [[200, VIDEO_QUOTE]],
      run_pipeline: [[400, { error: "The pipeline changed after quote q1 priced it at $0.28. Nothing was run or charged.", code: "STALE_QUOTE" }]],
    });
    await h.run();
    expect(h.asked("run_pipeline")).toHaveLength(1);
    expect(h.failed[0]).toBe("The pipeline changed after quote q1 priced it at $0.28. Nothing was run or charged.");
    expect(h.outputs.status).toBe("not-started");
  });

  it("a busy quote is asked again; the start still happens once", async () => {
    const h = harness(video(), {
      make_video: [[503, { error: "busy" }], "network", [200, VIDEO_QUOTE]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: [[200, DONE]],
    });
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.asked("make_video")).toHaveLength(3);
    expect(h.asked("run_pipeline")).toHaveLength(1);
  });

  it("times out, leaves the render running and says so", async () => {
    const running: [number, Record<string, unknown>] = [200, { status: "running", pollAfterSec: 20 }];
    const h = harness(video({ "timeout-minutes": "1" }), {
      make_video: [[200, VIDEO_QUOTE]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: Array.from({ length: 10 }, () => running),
    });
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toContain("Still rendering after 1 minutes");
    expect(h.failed[0]).toContain("The render was not cancelled");
    expect(h.asked("get_run")).toHaveLength(4); // at 0, 20, 40 and 60 seconds
    expect(h.clock()).toBe(60_000);
    expect(h.asked("cancel_run")).toEqual([]);
    expect(h.asked("run_pipeline")).toHaveLength(1);
    expect(h.outputs).toMatchObject({ "run-id": "r1", status: "running", "price-usd": "0.28" });
  });

  it("polls through brief outages and backs off when Treza gives no pause", async () => {
    const h = harness(video(), {
      make_video: [[200, VIDEO_QUOTE]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: [[502, { error: "bad gateway" }], "network", [200, { status: "running" }], [200, DONE]],
    });
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.sleeps).toEqual([3000, 5000, 8000]);
  });

  it("a broken render fails with the reason", async () => {
    const h = harness(video(), {
      make_video: [[200, VIDEO_QUOTE]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: [[200, { status: "error", statusNote: "The model refused the prompt.", nodes: [{ label: "Video", type: "video-gen", error: "Content policy." }] }]],
    });
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toContain("The render stopped before it finished. The model refused the prompt. Video: Content policy.");
    expect(h.outputs.status).toBe("error");
  });

  it("with wait false, ends once the render has started", async () => {
    const h = harness(video({ wait: "false" }), { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]] });
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.asked("get_run")).toEqual([]);
    expect(h.outputs).toMatchObject({ "run-id": "r1", "pipeline-id": "pipeline_1", status: "running" });
  });

  it("a summary that cannot be written does not fail a finished render", async () => {
    const h = harness(
      video(),
      { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] },
      {},
      { writeSummary: async () => Promise.reject(new Error("EACCES")) },
    );
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.failed).toEqual([]);
    expect(h.warnings.join("\n")).toContain("The job summary could not be written");
  });

  it("a bad key says what to check", async () => {
    const h = harness(video(), { make_video: [[401, { error: 'Send a Treza API key as "Authorization: Bearer treza_live_...".', code: "UNAUTHORIZED" }]] });
    await h.run();
    expect(h.failed[0]).toContain("Check the api-key input and the TREZA_API_KEY secret");
    expect(h.failed[0]).toContain("Nothing was charged.");
    expect(h.asked("make_video")).toHaveLength(1);
  });
});

describe("image", () => {
  it("needs no cap, reports a free picture and shows it inline", async () => {
    const h = harness({ "api-key": KEY, mode: "image", prompt: "a red kite", "aspect-ratio": "4:5" }, {
      make_image: [[200, { ...VIDEO_QUOTE, estimatedChargeUsd: 0, listChargeUsd: 0.06, freeImage: true, model: "google/gemini-2.5-flash-image" }]],
      run_pipeline: [[200, { runId: "r1", charged: false }]],
      get_run: [[200, { status: "success", outputs: { image: IMAGE_URL } }]],
    });
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.asked("make_image")).toEqual([{ prompt: "a red kite", aspectRatio: "4:5" }]);
    expect(h.outputs).toMatchObject({ "price-usd": "0.00", url: IMAGE_URL, status: "success" });
    const summary = h.summaries.at(-1)!;
    expect(summary).toContain("| Price | free |");
    expect(summary).toContain(`<img src="${IMAGE_URL}" alt="pic-1.png" width="480">`);
  });

  it("checks a cap when one is given", async () => {
    const h = harness({ "api-key": KEY, mode: "image", prompt: "a red kite", "max-cost-usd": "0.05" }, {
      make_image: [[200, { ...VIDEO_QUOTE, estimatedChargeUsd: 0.06, model: "google/gemini-2.5-flash-image" }]],
    });
    await h.run();
    expect(h.asked("make_image")[0]!.maxPriceUsd).toBe(0.05);
    expect(h.asked("run_pipeline")).toEqual([]);
    expect(h.failed[0]).toContain("over max-cost-usd of $0.05");
  });

  it("refuses a shape Treza does not render", async () => {
    const h = harness({ "api-key": KEY, mode: "image", prompt: "x", "aspect-ratio": "7:3" }, {});
    await h.run();
    expect(h.failed[0]).toContain('aspect-ratio "7:3" is not one Treza renders in image mode');
    expect(h.calls).toEqual([]);
  });
});

describe("pipeline", () => {
  const inputs = { "api-key": KEY, mode: "pipeline", "pipeline-id": "pipeline_9", "max-cost-usd": "2", inputs: '{"prompt_1": "a lighthouse"}' };

  it("quotes with the inputs and starts with the same inputs", async () => {
    const h = harness(inputs, {
      estimate_run_cost: [[200, { pipelineId: "pipeline_9", quoteId: "q9", estimatedChargeUsd: 1.5, sufficient: true }]],
      run_pipeline: [[200, { runId: "r9" }]],
      get_run: [[200, { status: "success", outputs: { final: "https://media.trezalabs.test/f.mp4", thumb: ["https://media.trezalabs.test/t.jpg"], note: "ok" } }]],
    });
    const out = await h.run();
    expect(out.ok).toBe(true);
    expect(h.asked("estimate_run_cost")).toEqual([{ pipelineId: "pipeline_9", inputs: { prompt_1: "a lighthouse" } }]);
    expect(h.asked("run_pipeline")).toEqual([{ pipelineId: "pipeline_9", inputs: { prompt_1: "a lighthouse" }, quoteId: "q9" }]);
    expect(h.outputs.url).toBe("https://media.trezalabs.test/f.mp4");
    expect(JSON.parse(h.outputs.files!)).toEqual(["https://media.trezalabs.test/f.mp4", "https://media.trezalabs.test/t.jpg"]);
    expect(h.summaries.at(-1)).toContain('<img src="https://media.trezalabs.test/t.jpg"');
  });

  it("over the cap starts nothing", async () => {
    const h = harness({ ...inputs, "max-cost-usd": "1" }, {
      estimate_run_cost: [[200, { pipelineId: "pipeline_9", quoteId: "q9", estimatedChargeUsd: 1.5, sufficient: true }]],
    });
    await h.run();
    expect(h.asked("run_pipeline")).toEqual([]);
    expect(h.failed[0]).toContain("This render costs $1.50, over max-cost-usd of $1.00");
  });

  it("needs a cap", async () => {
    const { "max-cost-usd": _cap, ...uncapped } = inputs;
    const h = harness(uncapped, {});
    await h.run();
    expect(h.failed[0]).toContain("max-cost-usd is required in pipeline mode");
    expect(h.calls).toEqual([]);
  });

  it("refuses inputs that are not a JSON object", async () => {
    for (const bad of ["{prompt_1: x}", '["a"]']) {
      const h = harness({ ...inputs, inputs: bad }, {});
      await h.run();
      expect(h.failed[0]).toMatch(/^inputs (is not valid JSON|must be a JSON object)/);
      expect(h.calls).toEqual([]);
    }
  });

  it("without a quoteId, starts once with a request ID", async () => {
    const h = harness(inputs, {
      estimate_run_cost: [[200, { pipelineId: "pipeline_9", estimatedChargeUsd: 1.5, sufficient: true }]],
      run_pipeline: [[200, { runId: "r9" }]],
      get_run: [[200, { status: "success", outputs: {} }]],
    });
    await h.run();
    const start = h.asked("run_pipeline");
    expect(start).toHaveLength(1);
    expect(start[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start[0]!.quoteId).toBeUndefined();
  });
});

describe("download", () => {
  it("saves the file into a folder under its own name, without the API key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "render-video-"));
    const h = harness(
      video({ "download-path": "out/" }),
      { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] },
      { [VIDEO_URL]: [{ body: "MP4DATA", type: "video/mp4" }] },
      { cwd: dir },
    );
    const out = await h.run();
    expect(out.ok).toBe(true);
    const saved = path.join(dir, "out", "clip-1.mp4");
    expect(h.outputs.path).toBe(saved);
    expect(await readFile(saved, "utf8")).toBe("MP4DATA");
    expect(h.media).toHaveLength(1);
    expect(JSON.stringify(h.media[0]!.headers)).not.toContain(KEY);
    expect(h.summaries.at(-1)).toContain(`| Saved to | <code>${saved}</code> |`);
  });

  it("saves to an exact file path, trying again after a server error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "render-video-"));
    const h = harness(
      video({ "download-path": "release/clip.mp4" }),
      { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] },
      { [VIDEO_URL]: [{ body: "", type: "text/plain", status: 503 }, { body: "MP4DATA", type: "video/mp4" }] },
      { cwd: dir },
    );
    await h.run();
    expect(h.failed).toEqual([]);
    expect(h.outputs.path).toBe(path.join(dir, "release", "clip.mp4"));
    expect(await readdir(path.join(dir, "release"))).toEqual(["clip.mp4"]);
  });

  it("a failed download fails the step but keeps the url output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "render-video-"));
    const h = harness(
      video({ "download-path": "out/" }),
      { make_video: [[200, VIDEO_QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] },
      { [VIDEO_URL]: [{ body: "gone", type: "text/plain", status: 403 }] },
      { cwd: dir },
    );
    const out = await h.run();
    expect(out.ok).toBe(false);
    expect(h.failed[0]).toContain("its file could not be downloaded (HTTP 403)");
    expect(h.outputs.url).toBe(VIDEO_URL);
    expect(h.outputs.path).toBeUndefined();
    expect(h.media).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("file names are safe", () => {
    expect(fileNameFor("https://x.test/a/clip%201.mp4?s=1")).toBe("clip_1.mp4");
    expect(fileNameFor("https://x.test/a/..", "image/png")).toBe("treza-output.png");
    expect(fileNameFor("https://x.test/", "video/mp4")).toBe("treza-output.mp4");
  });

  it("finds every file once", () => {
    expect(outputUrls({ a: "https://x/1.mp4", b: ["https://x/1.mp4", "https://x/2.png"], c: { d: "http://x/3.wav" }, e: "text" })).toEqual([
      "https://x/1.mp4",
      "https://x/2.png",
      "http://x/3.wav",
    ]);
  });

  it("never adds a second 'nothing charged'", () => {
    expect(nothingCharged("No. Nothing was run or charged.")).toBe("No. Nothing was run or charged.");
    expect(nothingCharged("Pipeline not found or access denied.")).toBe("Pipeline not found or access denied. Nothing was charged.");
  });

  it("sends the key only over https, or to this machine", () => {
    expect(resolveBaseUrl(undefined)).toBe("https://www.trezalabs.com");
    expect(resolveBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(() => resolveBaseUrl("http://example.com")).toThrow(/https/);
  });

  it("the version matches package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
