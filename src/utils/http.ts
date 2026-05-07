import { ExternalServiceError, RetryableError } from "./errors.js";
import { withTimeout } from "./timeout.js";

type RequestOptions = RequestInit & {
  timeoutMs: number;
  retryCount?: number;
  retryableStatuses?: number[];
};

async function fetchWithPolicy(url: string, options: RequestOptions) {
  const retryableStatuses = options.retryableStatuses ?? [408, 425, 429, 500, 502, 503, 504];
  let attempt = 0;
  const maxAttempts = (options.retryCount ?? 0) + 1;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const response = await withTimeout(
        (signal) => fetch(url, { ...options, signal }),
        options.timeoutMs,
        `Request timed out: ${url}`
      );

      if (response.ok) {
        return response;
      }

      if (retryableStatuses.includes(response.status) && attempt < maxAttempts) {
        continue;
      }

      throw new ExternalServiceError(
        "HTTP_ERROR",
        `Request failed with status ${response.status}`,
        response.status
      );
    } catch (error) {
      if (attempt < maxAttempts && error instanceof RetryableError) {
        continue;
      }

      throw error;
    }
  }

  throw new ExternalServiceError("HTTP_EXHAUSTED", `Request retries exhausted: ${url}`);
}

export async function fetchJson<T>(url: string, options: RequestOptions) {
  const response = await fetchWithPolicy(url, options);
  return (await response.json()) as T;
}

export async function fetchText(url: string, options: RequestOptions) {
  const response = await fetchWithPolicy(url, options);
  return response.text();
}

export async function fetchBuffer(url: string, options: RequestOptions) {
  const response = await fetchWithPolicy(url, options);
  return Buffer.from(await response.arrayBuffer());
}
