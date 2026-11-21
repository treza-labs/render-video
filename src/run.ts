/**
 * The action: read the inputs, quote, check the quote against max-cost-usd
 * and the balance, start the render once, wait for it, then set the outputs,
 * download the file and write the job summary.
 *
 * Everything the runner provides (inputs, outputs, logging, the summary file,
 * fetch, the clock) comes in through `Deps`, so tests can drive it.
 */
import { randomUUID } from "node:crypto";

import { downloadFile } from "./download.js";
import { readSettings, type GetInput, type Settings } from "./inputs.js";
import {
  TOP_UP_URL,
  TrezaClient,
  TrezaError,
  compact,
  modelName,
  nothingCharged,
  overBudget,
  pipelinePage,
  refusal,
  resolveBaseUrl,
  runFiles,
  stoppedMessage,
  toNumber,
  transient,
  usd,
  type Answer,
  type Data,
  type FetchFn,
  type SleepFn,
} from "./treza.js";

export type Deps = {
  getInput: GetInput;
  setOutput: (name: string, value: string) => void;
  setSecret: (value: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  setFailed: (message: string) => void;
  writeSummary: (markdown: string) => Promise<void>;
  fetch?: FetchFn;
  sleep?: SleepFn;
  now?: () => number;
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export type Outcome = { ok: boolean; outputs: Record<string, string>; message?: string };

/** What the summary reports, filled in as the step goes. */
type Report = {
  mode?: string;
  status?: string;
  priceUsd?: number;
  upTo?: boolean;
  free?: boolean;
  capUsd?: number;
  model?: string;
  runId?: string;
  pipelineId?: string;
  files: string[];
  path?: string;
  renderSeconds?: number;
  problem?: string;
  warning?: string;
};

const QUOTE_ATTEMPTS = 3;
/** Polls in a row that may fail (Treza briefly unreachable) before the step gives up. */
const POLL_FAILURES_ALLOWED = 6;
const MIN_POLL_SEC = 2;
const MAX_POLL_SEC = 30;
/** Pauses between polls when Treza does not say (it normally sends pollAfterSec). */
const BACKOFF_SEC = [3, 5, 8, 13, 20, 30];

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAction(deps: Deps): Promise<Outcome> {
  const outputs: Record<string, string> = {};
  const report: Report = { files: [] };
  let quoted = false;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;

  // Collected, then written once each when the step ends, so the runner never
  // sees a name twice (status goes from running to its final value).
  const output = (name: string, value: string) => {
    outputs[name] = value;
  };
  const flush = () => {
    for (const [name, value] of Object.entries(outputs)) deps.setOutput(name, value);
  };

  // A summary that cannot be written is worth a warning, never a failed step.
  const summarize = () =>
    deps.writeSummary(summaryMarkdown(report)).catch((err) => deps.warning(`The job summary could not be written: ${messageOf(err)}`));

  const fail = async (message: string): Promise<Outcome> => {
    report.problem = message;
    flush();
    deps.setFailed(message);
    if (quoted) await summarize();
    return { ok: false, outputs, message };
  };

  // Masked before anything else, so no log line can show it, even on a bad input.
  const rawKey = deps.getInput("api-key").trim();
  if (rawKey) deps.setSecret(rawKey);

  let settings: Settings;
  let client: TrezaClient;
  try {
    settings = readSettings(deps.getInput);
    client = new TrezaClient({ apiKey: settings.apiKey, baseUrl: resolveBaseUrl(env.TREZA_BASE_URL), fetch: deps.fetch });
  } catch (err) {
    output("status", "not-started");
    return fail(messageOf(err));
  }
  for (const name of settings.ignored) deps.warning(`${name} is not used in ${settings.mode} mode and was ignored.`);
  report.mode = settings.mode;
  if (Number.isFinite(settings.maxCostUsd)) report.capUsd = settings.maxCostUsd;

  try {
    // 1. The quote. Asking for one charges nothing, so a busy or unreachable Treza is asked again.
    quoted = true;
    const quote = await quoteWithRetry(client, settings, sleep);
    if (!quote.ok) {
      if (quote.body.code === "OVER_BUDGET") {
        report.priceUsd = toNumber(quote.body.estimatedChargeUsd);
        if (report.priceUsd !== undefined) output("price-usd", report.priceUsd.toFixed(2));
        throw overBudget(report.priceUsd, settings.maxCostUsd);
      }
      throw new TrezaError(nothingCharged(refusal(quote.status, quote.body).message), quote.status, quote.body.code);
    }
    const q = quote.body;
    const pipelineId = typeof q.pipelineId === "string" ? q.pipelineId : settings.pipelineId;
    const price = toNumber(q.estimatedChargeUsd);
    if (!pipelineId) throw new TrezaError("Treza's quote named no pipeline, so nothing was started. Nothing was charged.");
    report.pipelineId = pipelineId;
    report.model = modelName(q.model);
    report.upTo = q.upTo === true;
    report.free = q.freeImage === true;
    output("pipeline-id", pipelineId);
    if (price === undefined) throw new TrezaError("Treza's quote had no price, so nothing was started. Nothing was charged.");
    report.priceUsd = price;
    output("price-usd", price.toFixed(2));
    deps.info(quoteLine(settings, q, price));

    // 2. The checks. Both happen before anything starts.
    if (price > settings.maxCostUsd) throw overBudget(price, settings.maxCostUsd);
    if (q.sufficient === false) {
      const held = toNumber(q.reservedUsd);
      throw new TrezaError(
        `This render costs ${usd(price)} and your Treza balance is ${usd(toNumber(q.balanceUsd) ?? 0)}` +
          (held ? ` (${usd(held)} of it is held by renders still running)` : "") +
          `. Nothing was started and nothing was charged. Add credits at ${q.topUpUrl || TOP_UP_URL}`,
        402,
        "INSUFFICIENT_CREDITS",
      );
    }

    // 3. The start: one call, never repeated, so a run can never be paid for twice.
    const start = compact({
      pipelineId,
      inputs: settings.mode === "pipeline" ? settings.inputs : undefined,
      ...(typeof q.quoteId === "string" && q.quoteId ? { quoteId: q.quoteId } : { requestId: randomUUID() }),
    });
    let started: Answer;
    try {
      started = await client.request("run_pipeline", start);
    } catch (err) {
      throw unconfirmedStart(pipelineId, messageOf(err));
    }
    if (!started.ok) {
      if (started.status >= 500) throw unconfirmedStart(pipelineId, `HTTP ${started.status}`);
      throw new TrezaError(nothingCharged(refusal(started.status, started.body).message), started.status, started.body.code);
    }
    const runId = typeof started.body.runId === "string" || typeof started.body.runId === "number" ? String(started.body.runId) : "";
    if (!runId) throw unconfirmedStart(pipelineId, "its answer had no run ID");
    report.runId = runId;
    report.status = "running";
    output("run-id", runId);
    output("status", "running");
    if (started.body.charged === false) report.free = true;
    deps.info(`Started run ${runId}. Follow it at ${pipelinePage(pipelineId)}`);

    if (!settings.wait) {
      deps.info("wait is false, so the step ends here while the render goes on in Treza.");
      flush();
      await summarize();
      return { ok: true, outputs };
    }

    // 4. The wait.
    const run = await waitForRun(client, pipelineId, runId, settings.timeoutMinutes, { sleep, now, info: deps.info });
    if (!run) {
      throw new TrezaError(
        `Still rendering after ${settings.timeoutMinutes} minutes, so the step stopped waiting. ` +
          `The render was not cancelled: it carries on in Treza and is charged as quoted. Run ID ${runId}; follow it at ${pipelinePage(pipelineId)}. ` +
          "Raise timeout-minutes to wait longer.",
        0,
        "TIMEOUT",
      );
    }
    const status = String(run.status);
    report.status = status;
    output("status", status);
    const ms = toNumber(run.durationMs);
    if (ms !== undefined) report.renderSeconds = Math.round(ms / 100) / 10;
    const files = runFiles(run, settings.mode === "video" ? "video" : settings.mode === "image" ? "image" : undefined);
    report.files = files;
    output("files", JSON.stringify(files));
    output("url", files[0] ?? "");

    if (status === "error" || status === "cancelled") {
      throw new TrezaError(`${stoppedMessage(run)} See which step stopped at ${pipelinePage(pipelineId)}`, 0, status.toUpperCase());
    }
    if (status === "partial") {
      report.warning = stoppedMessage(run);
      deps.warning(`Some steps did not finish. ${report.warning}`);
    } else if (status !== "success") {
      throw new TrezaError(`Treza reported the run as "${status}". See ${pipelinePage(pipelineId)}`);
    }
    if (files[0]) deps.info(`Finished${report.renderSeconds !== undefined ? ` in ${report.renderSeconds}s` : ""}: ${files[0]}`);
    else deps.warning("The run finished but returned no file.");

    // 5. The file.
    if (settings.downloadPath) {
      if (!files[0]) throw new TrezaError("download-path is set, but the run returned no file to download.");
      const saved = await downloadFile(files[0], settings.downloadPath, { fetch: deps.fetch, sleep, cwd: deps.cwd ?? env.GITHUB_WORKSPACE });
      report.path = saved;
      output("path", saved);
      deps.info(`Saved to ${saved}`);
    }

    flush();
    await summarize();
    return { ok: true, outputs };
  } catch (err) {
    if (report.status === undefined) {
      // A start Treza did not confirm may have begun; anything earlier never did.
      report.status = err instanceof TrezaError && err.code === "START_UNCONFIRMED" ? "unknown" : "not-started";
      output("status", report.status);
    }
    return fail(messageOf(err));
  }
}

function messageOf(err: unknown): string {
  if (err instanceof TrezaError) return err.message;
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

/** The start call got no clear answer. It may have started, so it is not tried again. */
function unconfirmedStart(pipelineId: string, why: string): TrezaError {
  return new TrezaError(
    `Treza did not confirm the start (${why}). The render may have started, so it was not tried again: a second start could charge twice. ` +
      `Check the pipeline's runs at ${pipelinePage(pipelineId)} before running this step again.`,
    0,
    "START_UNCONFIRMED",
  );
}

async function quoteWithRetry(client: TrezaClient, settings: Settings, sleep: SleepFn): Promise<Answer> {
  const cap = Number.isFinite(settings.maxCostUsd) ? settings.maxCostUsd : undefined;
  const [tool, args] =
    settings.mode === "video"
      ? ["make_video", { prompt: settings.prompt, durationSec: settings.durationSec, aspectRatio: settings.aspectRatio, model: settings.model, maxPriceUsd: cap }]
      : settings.mode === "image"
        ? ["make_image", { prompt: settings.prompt, aspectRatio: settings.aspectRatio, model: settings.model, maxPriceUsd: cap }]
        : ["estimate_run_cost", { pipelineId: settings.pipelineId, inputs: settings.inputs }];
  let last: Answer | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
    try {
      last = await client.request(tool, args);
      lastError = undefined;
      if (!transient(last.status)) return last;
    } catch (err) {
      lastError = err;
    }
    if (attempt < QUOTE_ATTEMPTS) {
      const retryAfter = last?.status === 429 ? Math.min(toNumber(last.body.retryAfterSec) ?? 10, 60) : 3 * attempt;
      await sleep(retryAfter * 1000);
    }
  }
  if (last && lastError === undefined) return last;
  throw new TrezaError(`Treza could not be reached for a quote (${messageOf(lastError).replace(/^Unexpected error: /, "")}). Nothing was charged.`);
}

/** Poll get_run until the run finishes. Null when it is still going at the deadline. */
async function waitForRun(
  client: TrezaClient,
  pipelineId: string,
  runId: string,
  timeoutMinutes: number,
  { sleep, now, info }: { sleep: SleepFn; now: () => number; info: (m: string) => void },
): Promise<Data | null> {
  const deadline = now() + timeoutMinutes * 60_000;
  let failures = 0;
  let polls = 0;
  let lastLine = "";
  for (;;) {
    let run: Data | undefined;
    let pauseSec: number | undefined;
    try {
      const answer = await client.request("get_run", { pipelineId, runId });
      if (answer.ok) {
        failures = 0;
        run = answer.body;
      } else if (transient(answer.status)) {
        failures++;
        if (answer.status === 429) pauseSec = toNumber(answer.body.retryAfterSec);
      } else {
        throw refusal(answer.status, answer.body);
      }
    } catch (err) {
      if (err instanceof TrezaError) throw err;
      failures++;
    }
    if (failures > POLL_FAILURES_ALLOWED) {
      throw new TrezaError(
        `Treza stopped answering while the render was going (${failures} checks in a row failed). The render was not cancelled. Run ID ${runId}; see ${pipelinePage(pipelineId)}`,
      );
    }
    if (run) {
      if (run.status !== "running") return run;
      const line = progressLine(run);
      if (line && line !== lastLine) info(line);
      lastLine = line || lastLine;
      pauseSec = toNumber(run.pollAfterSec);
    }
    const left = deadline - now();
    if (left <= 0) return null;
    const pause = Math.min(Math.max(pauseSec ?? BACKOFF_SEC[Math.min(polls, BACKOFF_SEC.length - 1)]!, MIN_POLL_SEC), MAX_POLL_SEC) * 1000;
    polls++;
    await sleep(Math.min(pause, left));
  }
}

function progressLine(run: Data): string {
  if (run.waiting === true) return "Queued behind other renders; it starts on its own.";
  const p = run.progress;
  if (p && typeof p === "object" && typeof p.done === "number" && typeof p.total === "number") {
    const current = Array.isArray(p.current) && p.current.length ? ` (now: ${p.current.join(", ")})` : "";
    return `Rendering: ${p.done} of ${p.total} steps done${current}.`;
  }
  return "Rendering.";
}

function quoteLine(settings: Settings, q: Data, price: number): string {
  const what =
    settings.mode === "video"
      ? `a ${q.durationSec ?? settings.durationSec ?? "4"}s ${q.aspectRatio ?? settings.aspectRatio ?? "16:9"} video`
      : settings.mode === "image"
        ? "a picture"
        : `pipeline ${settings.pipelineId}`;
  const model = modelName(q.model);
  const longer = toNumber(q.requestedDurationSec) !== undefined ? ` (this model renders ${q.durationSec}s, not ${q.requestedDurationSec}s)` : "";
  const cost = q.freeImage === true ? "free (one of today's free images)" : `${q.upTo === true ? "up to " : ""}${usd(price)}`;
  const cap = Number.isFinite(settings.maxCostUsd) ? ` max-cost-usd is ${usd(settings.maxCostUsd)}.` : "";
  return `Quoted ${cost} for ${what}${model ? ` on ${model}` : ""}${longer}.${cap}`;
}

// ------------------------------------------------------------------ summary

const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ");
const code = (text: string) => `<code>${cell(text)}</code>`;
const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const linkTarget = (url: string) => url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

function fileLabel(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
  } catch {
    return "file";
  }
}

const isImage = (url: string) => {
  try {
    return IMAGE_FILE.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** The job summary: price, status, links, and the picture inline for an image. */
export function summaryMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`### Treza ${r.mode ?? "render"}: ${r.status ?? "not started"}`, "");
  lines.push("| | |", "| --- | --- |");
  if (r.status) lines.push(`| Status | ${cell(r.status)} |`);
  if (r.priceUsd !== undefined) {
    const price = r.free ? "free" : `${r.upTo ? "up to " : ""}${usd(r.priceUsd)}`;
    lines.push(`| Price | ${price}${r.capUsd !== undefined ? ` (max-cost-usd ${usd(r.capUsd)})` : ""} |`);
  } else if (r.capUsd !== undefined) {
    lines.push(`| Max cost | ${usd(r.capUsd)} |`);
  }
  if (r.model) lines.push(`| Model | ${cell(r.model)} |`);
  if (r.renderSeconds !== undefined) lines.push(`| Render time | ${r.renderSeconds}s |`);
  if (r.runId) lines.push(`| Run ID | ${code(r.runId)} |`);
  if (r.pipelineId) lines.push(`| Pipeline | [${cell(r.pipelineId)}](${pipelinePage(r.pipelineId)}) |`);
  r.files.forEach((url, i) => lines.push(`| ${i === 0 ? "File" : `File ${i + 1}`} | [${cell(fileLabel(url))}](${linkTarget(url)}) |`));
  if (r.path) lines.push(`| Saved to | ${code(r.path)} |`);
  lines.push("");
  const pictures = r.files.filter(isImage).slice(0, 4);
  for (const url of pictures) lines.push(`<img src="${attr(url)}" alt="${attr(fileLabel(url))}" width="480">`, "");
  if (r.warning) lines.push(`**Not every step finished:** ${cell(r.warning)}`, "");
  if (r.problem) lines.push(`**${r.status === "not-started" ? "Not started" : "Failed"}:** ${cell(r.problem)}`, "");
  return lines.join("\n");
}
