/**
 * A small client for Treza's REST API: POST /api/v1/tools/<name> with the
 * tool's arguments as JSON and `Authorization: Bearer <key>`.
 *
 * Ported from the treza-ai-sdk client. A render is always: quote, check the
 * quote against the cap and the balance, start it once with the quoteId,
 * then poll get_run until it finishes.
 */

export const VERSION = "1.0.0";
export const USER_AGENT = `treza-render-video/${VERSION}`;
export const DEFAULT_BASE_URL = "https://www.trezalabs.com";
export const TOP_UP_URL = "https://www.trezalabs.com/platform/settings";
export const KEYS_PAGE = "https://www.trezalabs.com/platform/api-keys";
export const pipelinePage = (pipelineId: string) => `https://www.trezalabs.com/platform/pipelines/${encodeURIComponent(pipelineId)}`;

/** How long one API call may take before it is given up on. */
const REQUEST_TIMEOUT_MS = 120_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Data = Record<string, any>;
export type Answer = { ok: boolean; status: number; body: Data };
export type FetchFn = typeof globalThis.fetch;
export type SleepFn = (ms: number) => Promise<void>;

/** A refusal or failure, worded for the person reading the workflow log. */
export class TrezaError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "TrezaError";
    this.status = status;
    this.code = code;
  }
}

/** Drop empty values, so an input left out gets Treza's default. */
export function compact(fields: Data): Data {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
  );
}

export function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Add "Nothing was charged." unless Treza's own message already says so. */
export function nothingCharged(message: string): string {
  if (/nothing was (?:\w+ )*(?:charged|spent)/i.test(message)) return message;
  return `${message.trim()} Nothing was charged.`;
}

/**
 * Treza's address. Tests and the self-test workflow point TREZA_BASE_URL at a
 * mock; anything but https is refused unless it is this machine, since the
 * API key is sent there.
 */
export function resolveBaseUrl(fromEnv: string | undefined): string {
  const raw = (fromEnv || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TrezaError(`TREZA_BASE_URL is not a URL: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TrezaError("TREZA_BASE_URL must be an https address, so the API key is never sent in the clear.");
  }
  return raw;
}

export type TrezaClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
};

export class TrezaClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(options: TrezaClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Call one tool. A refusal (HTTP 4xx/5xx) comes back as `ok: false` with
   * Treza's JSON; a network failure or timeout throws.
   */
  async request(tool: string, args: Data = {}): Promise<Answer> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/tools/${tool}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(compact(args)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: Data;
    try {
      const parsed = JSON.parse(text);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { ok: response.status < 400, status: response.status, body };
  }
}

/** Treza's refusal as an error, with what to do next for the common ones. */
export function refusal(status: number, body: Data): TrezaError {
  const message = typeof body.error === "string" && body.error ? body.error : `Treza answered HTTP ${status}.`;
  const code = typeof body.code === "string" ? body.code : undefined;
  if (status === 401) {
    return new TrezaError(`${message} Check the api-key input and the TREZA_API_KEY secret (make a key at ${KEYS_PAGE}).`, status, code);
  }
  if (status === 402) return new TrezaError(`${message} Add credits at ${body.topUpUrl || TOP_UP_URL}`, status, code ?? "INSUFFICIENT_CREDITS");
  if (status === 429) return new TrezaError(`${message} Wait ${Math.trunc(toNumber(body.retryAfterSec) ?? 60)} seconds and try again.`, status, code);
  return new TrezaError(message, status, code);
}

/** Worth asking again: Treza was busy or briefly unreachable. Never used for starting a render. */
export const transient = (status: number) => status === 429 || status >= 500;

export function overBudget(price: number | undefined, maxCostUsd: number): TrezaError {
  return new TrezaError(
    `This render costs ${price !== undefined ? usd(price) : "more"}, over max-cost-usd of ${usd(maxCostUsd)}. ` +
      "Nothing was started and nothing was charged. Raise max-cost-usd, or ask for less (a shorter clip or a cheaper model).",
    400,
    "OVER_BUDGET",
  );
}

/** The finished files: every http(s) link among the run's outputs, in order, once each. */
export function outputUrls(outputs: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && !found.includes(value)) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(outputs, 0);
  return found;
}

/** The file a step made: the named output (video, image) first, then the other files. */
export function runFiles(run: Data, preferredKey?: string): string[] {
  const outputs: Data = run.outputs && typeof run.outputs === "object" ? run.outputs : {};
  const all = outputUrls(outputs);
  const preferred = preferredKey ? outputUrls(outputs[preferredKey])[0] : undefined;
  return preferred ? [preferred, ...all.filter((u) => u !== preferred)] : all;
}

/** Why a finished run stopped short, from its notes and the first step that broke. */
export function stoppedMessage(run: Data): string {
  if (run.status === "cancelled") {
    return `The render was cancelled${typeof run.cancelReason === "string" && run.cancelReason ? `: ${run.cancelReason}` : ""}.`;
  }
  const reasons: unknown[] = [run.statusNote, run.refusalNote];
  const broken = (Array.isArray(run.nodes) ? run.nodes : []).find((n: Data) => n && typeof n.error === "string");
  if (broken) reasons.push(`${broken.label || broken.type}: ${broken.error}`);
  const said = reasons.filter((r): r is string => typeof r === "string" && r.length > 0).join(" ");
  return `The render stopped before it finished. ${said}`.trim();
}

/** The model a quote names: make_video answers {id, name}, make_image a plain id. */
export function modelName(model: unknown): string | undefined {
  if (typeof model === "string" && model) return model;
  if (model && typeof model === "object") {
    const m = model as Data;
    if (typeof m.name === "string" && m.name) return m.name;
    if (typeof m.id === "string" && m.id) return m.id;
  }
  return undefined;
}
