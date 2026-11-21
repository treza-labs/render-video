/**
 * A stand-in for Treza's REST API, for the end-to-end test and the workflow
 * that runs the action itself. Shapes follow lib/mcp/server.ts in treza-xyz.
 *
 *   node test/mock-treza.mjs --port 8787
 *
 * POST /api/v1/tools/<tool>  make_video, make_image, estimate_run_cost, run_pipeline, get_run
 * GET  /media/<name>         the finished files
 * GET  /calls                every tool call so far, for checks
 * GET  /health               ready check
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

const PRICES = { make_video: 0.28, make_image: 0.06, estimate_run_cost: 1.5 };

export function startMockTreza({ port = 0 } = {}) {
  const calls = [];
  const runs = new Map();
  /** What each quoted pipeline makes, so its run returns a picture or a clip. */
  const kinds = new Map();
  let origin = "";

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/calls") return send(200, { calls });
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      if (req.headers.authorization) return send(400, { error: "media links are signed; no key expected" });
      const name = url.pathname.slice("/media/".length);
      return send(200, `fake ${name} bytes`, name.endsWith(".png") ? "image/png" : "video/mp4");
    }
    const match = req.method === "POST" && url.pathname.match(/^\/api\/v1\/tools\/([a-z_]+)$/);
    if (!match) return send(404, { error: "not found" });

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const tool = match[1];
    const args = raw ? JSON.parse(raw) : {};
    calls.push({ tool, args, userAgent: req.headers["user-agent"] ?? "" });
    if (!/^Bearer treza_live_\S+$/.test(req.headers.authorization ?? "")) {
      return send(401, { error: 'Send a Treza API key as "Authorization: Bearer treza_live_...".', code: "UNAUTHORIZED" });
    }

    if (tool in PRICES) {
      const price = PRICES[tool];
      if (typeof args.maxPriceUsd === "number" && price > args.maxPriceUsd) {
        return send(400, {
          error: `This video costs $${price.toFixed(2)}, over the $${args.maxPriceUsd.toFixed(2)} limit. Nothing was created or charged.`,
          code: "OVER_BUDGET",
          estimatedChargeUsd: price,
        });
      }
      const pipelineId = tool === "estimate_run_cost" ? args.pipelineId : `pipeline_mock_${calls.length}`;
      kinds.set(pipelineId, tool === "make_image" ? "image" : "video");
      return send(200, {
        pipelineId,
        pipelineName: "Mock",
        quoteId: `quote_${calls.length}`,
        estimatedChargeUsd: price,
        balanceUsd: 10,
        enforced: true,
        sufficient: true,
        ...(tool === "make_video"
          ? { model: { id: "google/veo-3.1-lite", name: "Veo 3.1 Lite" }, durationSec: args.durationSec ?? 4, aspectRatio: args.aspectRatio ?? "16:9" }
          : tool === "make_image"
            ? { model: "google/gemini-2.5-flash-image" }
            : {}),
      });
    }
    if (tool === "run_pipeline") {
      const runId = `2026-11-20T00:00:00.000Z#${runs.size + 1}`;
      runs.set(runId, { polls: 0, kind: kinds.get(args.pipelineId) ?? "video", pipelineId: args.pipelineId });
      return send(200, { runId, status: "running", startedAt: new Date().toISOString() });
    }
    if (tool === "get_run") {
      const run = runs.get(args.runId);
      if (!run) return send(404, { error: "Run not found." });
      run.polls++;
      if (run.polls === 1) {
        return send(200, { runId: args.runId, pipelineId: run.pipelineId, status: "running", pollAfterSec: 1, progress: { done: 1, total: 3, current: ["Video"] }, nodes: [] });
      }
      const file = run.kind === "image" ? `${origin}/media/picture.png?s=sig` : `${origin}/media/clip.mp4?s=sig`;
      return send(200, {
        runId: args.runId,
        pipelineId: run.pipelineId,
        status: "success",
        durationMs: 4200,
        outputs: { [run.kind]: file },
        nodes: [],
      });
    }
    return send(404, { error: `There is no tool named "${tool}".`, code: "UNKNOWN_TOOL" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: origin, calls, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const at = process.argv.indexOf("--port");
  const mock = await startMockTreza({ port: at > 0 ? Number(process.argv[at + 1]) : 8787 });
  console.log(`Mock Treza listening at ${mock.url}`);
}
