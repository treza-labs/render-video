/**
 * The step's inputs, read and checked before anything is sent to Treza. A
 * mistake here fails the step at once, with nothing quoted or charged.
 */
import { TrezaError, toNumber, type Data } from "./treza.js";

export const MODES = ["video", "image", "pipeline"] as const;
export type Mode = (typeof MODES)[number];

/** The shapes Treza's make_video and make_image take (lib/mcp/make-video.ts, make-image.ts). */
export const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"];
export const IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_PROMPT_CHARS = 2000;

export type Settings = {
  apiKey: string;
  mode: Mode;
  prompt?: string;
  model?: string;
  durationSec?: number;
  aspectRatio?: string;
  pipelineId?: string;
  inputs?: Data;
  /** Infinity when no cap was given (image mode only). */
  maxCostUsd: number;
  wait: boolean;
  timeoutMinutes: number;
  downloadPath?: string;
  /** Inputs that were set but mean nothing in this mode. */
  ignored: string[];
};

export type GetInput = (name: string) => string;

function bad(message: string): never {
  throw new TrezaError(`${message} Nothing was sent to Treza.`, 0, "INVALID_INPUT");
}

function parseBool(name: string, raw: string, fallback: boolean): boolean {
  if (raw === "") return fallback;
  if (/^(true|yes|on|1)$/i.test(raw)) return true;
  if (/^(false|no|off|0)$/i.test(raw)) return false;
  return bad(`${name} must be true or false, not "${raw}".`);
}

/** Read every input. `get` returns "" for an input that was not set, as core.getInput does. */
export function readSettings(get: GetInput): Settings {
  const value = (name: string) => get(name).trim();
  const apiKey = value("api-key");
  if (!apiKey) {
    bad(
      "api-key is empty. Add your Treza API key as the repository secret TREZA_API_KEY and pass `api-key: ${{ secrets.TREZA_API_KEY }}`. " +
        "Workflows started from a fork get no secrets.",
    );
  }

  const modeRaw = (value("mode") || "video").toLowerCase();
  if (!(MODES as readonly string[]).includes(modeRaw)) bad(`mode must be video, image or pipeline, not "${modeRaw}".`);
  const mode = modeRaw as Mode;

  const ignored: string[] = [];
  const onlyFor = (name: string, modes: Mode[]) => {
    if (value(name) && !modes.includes(mode)) ignored.push(name);
  };
  onlyFor("prompt", ["video", "image"]);
  onlyFor("model", ["video", "image"]);
  onlyFor("duration", ["video"]);
  onlyFor("aspect-ratio", ["video", "image"]);
  onlyFor("pipeline-id", ["pipeline"]);
  onlyFor("inputs", ["pipeline"]);

  const settings: Settings = {
    apiKey,
    mode,
    maxCostUsd: Infinity,
    wait: parseBool("wait", value("wait"), true),
    timeoutMinutes: 15,
    ignored,
  };

  if (mode === "video" || mode === "image") {
    const prompt = value("prompt");
    if (!prompt) bad(`prompt is required in ${mode} mode: describe what the ${mode === "video" ? "clip" : "picture"} shows.`);
    if (prompt.length > MAX_PROMPT_CHARS) bad(`prompt is ${prompt.length} characters; Treza takes at most ${MAX_PROMPT_CHARS}.`);
    settings.prompt = prompt;
    settings.model = value("model") || undefined;
    const aspect = value("aspect-ratio");
    if (aspect) {
      const allowed = mode === "video" ? VIDEO_ASPECTS : IMAGE_ASPECTS;
      if (!allowed.includes(aspect)) bad(`aspect-ratio "${aspect}" is not one Treza renders in ${mode} mode. Use one of: ${allowed.join(", ")}.`);
      settings.aspectRatio = aspect;
    }
  }

  if (mode === "video") {
    const raw = value("duration").replace(/s$/i, "");
    if (raw) {
      const duration = toNumber(raw);
      if (duration === undefined || duration < 1 || duration > 60) bad(`duration must be a number of seconds from 1 to 60, not "${value("duration")}".`);
      settings.durationSec = duration;
    }
  }

  if (mode === "pipeline") {
    const pipelineId = value("pipeline-id");
    if (!pipelineId) bad("pipeline-id is required in pipeline mode. It is in the pipeline's address in Treza and starts with pipeline_.");
    settings.pipelineId = pipelineId;
    const raw = value("inputs");
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        bad(`inputs is not valid JSON (${(err as Error).message}). Pass an object keyed by input step, like {"prompt_1": "a lighthouse at dawn"}.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        bad('inputs must be a JSON object keyed by input step, like {"prompt_1": "a lighthouse at dawn"}.');
      }
      if (Object.keys(parsed as Data).length > 0) settings.inputs = parsed as Data;
    }
  }

  const capRaw = value("max-cost-usd").replace(/^\$/, "");
  if (capRaw) {
    const cap = toNumber(capRaw);
    if (cap === undefined || cap <= 0) bad(`max-cost-usd must be a price in US dollars above 0, like 1.50, not "${value("max-cost-usd")}".`);
    settings.maxCostUsd = cap;
  } else if (mode !== "image") {
    bad(
      `max-cost-usd is required in ${mode} mode, so this step can never spend more than you meant. ` +
        "Set it to the most one run may cost in US dollars, like `max-cost-usd: '1.00'`.",
    );
  }

  const timeoutRaw = value("timeout-minutes");
  if (timeoutRaw) {
    const minutes = toNumber(timeoutRaw);
    if (minutes === undefined || minutes <= 0 || minutes > 360) bad(`timeout-minutes must be a number of minutes above 0 and at most 360, not "${timeoutRaw}".`);
    settings.timeoutMinutes = minutes;
  }

  const downloadPath = value("download-path");
  if (downloadPath) settings.downloadPath = downloadPath;
  return settings;
}
