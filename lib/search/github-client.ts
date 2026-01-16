import { Octokit } from "@octokit/rest";

export interface RetryOptions {
  maxRetries?: number;
  minDelayMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  verbose?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerToNumber(value: string | string[] | undefined): number | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number | null {
  const err = error as { status?: number; response?: { headers?: Record<string, string | string[]> } };
  const status = err?.status;
  const headers = err?.response?.headers ?? {};

  const retryAfter = headerToNumber(headers["retry-after"]);
  if (retryAfter !== null) {
    return Math.max(0, retryAfter * 1000);
  }

  const reset = headerToNumber(headers["x-ratelimit-reset"]);
  if (status && (status === 403 || status === 429) && reset !== null) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 2000;
    return waitMs;
  }

  if (status && [500, 502, 503, 504].includes(status)) {
    return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  }

  return null;
}

async function respectRateLimit(headers: Record<string, string | string[]>, minDelayMs: number) {
  const remaining = headerToNumber(headers["x-ratelimit-remaining"]) ?? 1;
  const reset = headerToNumber(headers["x-ratelimit-reset"]);

  if (remaining <= 0 && reset !== null) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 2000;
    await sleep(waitMs);
    return;
  }

  if (minDelayMs > 0) {
    await sleep(minDelayMs);
  }
}

export function createOctokit(verbose: boolean = false): Octokit {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  return new Octokit({
    auth: GITHUB_TOKEN,
    log: verbose
      ? undefined
      : {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
  });
}

export async function requestWithRetry<T>(
  requestFn: () => Promise<{ data: T; headers: Record<string, string | string[]> }>,
  options: RetryOptions = {}
): Promise<{ data: T; headers: Record<string, string | string[]> }> {
  const {
    maxRetries = 5,
    minDelayMs = 0,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    verbose = false,
  } = options;

  let attempt = 0;
  while (true) {
    try {
      const response = await requestFn();
      await respectRateLimit(response.headers, minDelayMs);
      return response;
    } catch (error) {
      const retryDelayMs = getRetryDelayMs(error, attempt, baseDelayMs, maxDelayMs);
      if (retryDelayMs === null || attempt >= maxRetries) {
        throw error;
      }

      if (verbose) {
        console.warn(`WARN: Request failed, retrying in ${Math.round(retryDelayMs)}ms`, error);
      }

      await sleep(retryDelayMs);
      attempt += 1;
    }
  }
}
