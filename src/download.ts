/**
 * Saving the finished file into the workspace. The file's link is signed, so
 * it is fetched as it is, without the API key.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { TrezaError, type FetchFn, type SleepFn } from "./treza.js";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ATTEMPTS = 3;

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

/** A safe file name for a link: its last path part, or treza-output plus the type's extension. */
export function fileNameFor(url: string, contentType?: string | null): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    base = "";
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "");
  if (!base) base = "treza-output";
  if (!path.extname(base)) {
    const type = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
    base += EXTENSIONS[type] ?? "";
  }
  return base;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Download `url` to `downloadPath`. A path that ends in a slash or is an
 * existing folder gets the file's own name inside it. Returns the absolute path.
 */
export async function downloadFile(
  url: string,
  downloadPath: string,
  opts: { fetch?: FetchFn; sleep?: SleepFn; cwd?: string } = {},
): Promise<string> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const resolved = path.resolve(opts.cwd ?? process.cwd(), downloadPath);
  const intoFolder = /[\\/]$/.test(downloadPath) || (await isDirectory(resolved));

  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok || !response.body) {
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break;
      } else {
        const target = intoFolder ? path.join(resolved, fileNameFor(url, response.headers.get("content-type"))) : resolved;
        await mkdir(path.dirname(target), { recursive: true });
        const partial = `${target}.part`;
        try {
          await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(partial));
          await rename(partial, target);
        } catch (err) {
          await rm(partial, { force: true });
          throw err;
        }
        return target;
      }
    } catch (err) {
      lastError = (err as Error).message || String(err);
    }
    if (attempt < ATTEMPTS) await sleep(2000 * attempt);
  }
  throw new TrezaError(
    `The render finished, but its file could not be downloaded (${lastError}). It is still at the url output, and in your Treza library.`,
    0,
    "DOWNLOAD_FAILED",
  );
}
