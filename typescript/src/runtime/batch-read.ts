import { Cause, Effect, Option } from "effect";
import { OperationFailure } from "./operation-failure.js";
import { answer, described } from "./http-operation.js";
import type { HttpFailure, SiteHttpRequest, SiteHttpResult, SiteHttpService } from "./site-http.js";

/**
 * Many independent reads at once, such as the site's own data request for each returned row,
 * with the number in flight adapting to how the site answers. `batchRead` sends them over an HTTP
 * version's `SiteHttp`; `batchFetchCode` declares `batchFetch`, which sends them with the page's
 * own `fetch` inside one `evaluate`. Both run the same loop:
 *
 * - Requests go out in batches, `start` (4) at once. After a batch with no 429, 503 or block,
 *   the next batch is half as large again, rounded up, up to `max` (16, which no option raises).
 *   Once the site has throttled, it grows by one per clean batch instead.
 * - A 429 or 503 halves the batch size (at least 1), waits the longest `Retry-After` in the batch,
 *   or a backoff that doubles from `backoffMs` without one, and sends the throttled requests again
 *   first, each at most `maxAttempts` times in all. A `Retry-After` longer than `maxWaitMs` stops
 *   the batch as `rate_limited`, since waiting it out would outlast the call.
 * - A block stops the batch at once, and nothing more is sent: a challenge page the host found, a
 *   403 that is not JSON, a 503 HTML page where JSON was asked for, or a 2xx HTML page where JSON
 *   was asked for. It never retries through a block; the challenge and proxy paths deal with it.
 * - Reads only: a request marked `write: true`, or a PUT, PATCH or DELETE, refuses the whole batch
 *   before anything is sent. A POST the site uses to read, such as a search or a GraphQL query,
 *   is a read.
 * - Results come back in input order, one for every request, never dropped: an answer, a failure,
 *   or `not_sent` for each request a stop kept back.
 */

/** The batch size: where it starts, the most it reaches and the least it falls to. */
export const batchReadConcurrency = { start: 4, max: 16, min: 1 } as const;

/** The loop's defaults: tries per request, the longest wait, the first backoff, a fetch's limit. */
export const batchReadDefaults = {
  maxAttempts: 3,
  maxWaitMs: 10_000,
  backoffMs: 1_000,
  timeoutMs: 15_000,
} as const;

/** How the site answered one send, as the loop sorts it. */
export type BatchAnswerKind = "answered" | "throttled" | "blocked";

/** One send of a request: its kind, the value to report, and a throttle's `Retry-After`. */
export interface BatchAnswer<A> {
  readonly kind: BatchAnswerKind;
  readonly value: A;
  readonly retryAfterMs?: number | undefined;
}

/** Each request's end: its last answer, the send's own failure, or not sent. */
export type BatchOutcome<A> =
  | {
      readonly index: number;
      readonly state: "answered" | "throttled" | "blocked";
      readonly value: A;
      readonly attempts: number;
    }
  | { readonly index: number; readonly state: "failed"; readonly error: string; readonly attempts: number }
  | {
      readonly index: number;
      readonly state: "not_sent";
      readonly reason: "blocked" | "rate_limited" | "budget";
      readonly attempts: number;
    };

/** Why a batch stopped early, and the request that stopped it. */
export type BatchStop =
  | { readonly reason: "blocked"; readonly index: number }
  | { readonly reason: "rate_limited"; readonly index: number; readonly retryAfterMs: number }
  | { readonly reason: "budget" };

export interface BatchRun<A> {
  readonly outcomes: readonly BatchOutcome<A>[];
  readonly stopped: BatchStop | undefined;
  /** The size of each batch sent, in order. */
  readonly batches: readonly number[];
}

/** The time the loop reads and waits on; tests pass their own. */
export interface BatchClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface BatchSettings extends BatchClock {
  readonly start: number;
  readonly max: number;
  readonly maxAttempts: number;
  readonly maxWaitMs: number;
  readonly backoffMs: number;
  /** Stop before a batch or wait would start past this many milliseconds; none by default. */
  readonly budgetMs?: number | undefined;
}

/**
 * The loop both helpers share. It refers to nothing outside its own body, because `batchFetchCode`
 * pastes its source into the page.
 */
export async function adaptiveBatch<A>(
  count: number,
  send: (index: number) => Promise<BatchAnswer<A>>,
  settings: BatchSettings,
): Promise<BatchRun<A>> {
  const outcomes: (BatchOutcome<A> | undefined)[] = Array.from({ length: count }, () => undefined);
  const attempts: number[] = Array.from({ length: count }, () => 0);
  const queue: number[] = Array.from({ length: count }, (_, index) => index);
  const batches: number[] = [];
  const started = settings.now();
  const overBudget = (waitMs: number) =>
    settings.budgetMs !== undefined && settings.now() - started + waitMs >= settings.budgetMs;
  let limit = Math.max(1, Math.min(settings.start, settings.max));
  let throttledBefore = false;
  let backoffs = 0;
  let stopped: BatchStop | undefined;
  while (queue.length > 0 && stopped === undefined) {
    if (overBudget(0)) {
      stopped = { reason: "budget" };
      break;
    }
    const batch = queue.splice(0, limit);
    batches.push(batch.length);
    const sent = await Promise.all(
      batch.map(async (index) => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        try {
          return { index, answer: await send(index), error: "" };
        } catch (error) {
          return {
            index,
            answer: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const again: number[] = [];
    let throttled = false;
    let waitMs = 0;
    let blockedAt: number | undefined;
    let rateLimited: { index: number; retryAfterMs: number } | undefined;
    for (const { index, answer, error } of sent) {
      const tries = attempts[index] ?? 0;
      if (answer === undefined) {
        outcomes[index] = { index, state: "failed", error, attempts: tries };
        continue;
      }
      if (answer.kind === "answered" || answer.kind === "blocked") {
        outcomes[index] = { index, state: answer.kind, value: answer.value, attempts: tries };
        if (answer.kind === "blocked" && blockedAt === undefined) blockedAt = index;
        continue;
      }
      throttled = true;
      outcomes[index] = { index, state: "throttled", value: answer.value, attempts: tries };
      const retryAfterMs = answer.retryAfterMs;
      if (retryAfterMs !== undefined && retryAfterMs > settings.maxWaitMs) {
        if (rateLimited === undefined) rateLimited = { index, retryAfterMs };
        continue;
      }
      if (tries >= settings.maxAttempts) continue;
      again.push(index);
      waitMs = Math.max(
        waitMs,
        retryAfterMs ?? Math.min(settings.maxWaitMs, settings.backoffMs * 2 ** backoffs),
      );
    }
    if (blockedAt !== undefined) stopped = { reason: "blocked", index: blockedAt };
    else if (rateLimited !== undefined) stopped = { reason: "rate_limited", ...rateLimited };
    else if (throttled && again.length > 0 && overBudget(waitMs)) stopped = { reason: "budget" };
    if (stopped !== undefined) {
      const reason = stopped.reason;
      for (const index of [...again, ...queue])
        outcomes[index] = { index, state: "not_sent", reason, attempts: attempts[index] ?? 0 };
      queue.length = 0;
      break;
    }
    if (throttled) {
      limit = Math.max(1, Math.floor(limit / 2));
      throttledBefore = true;
      backoffs += 1;
      queue.unshift(...again.sort((left, right) => left - right));
      if (again.length > 0 && waitMs > 0) await settings.sleep(waitMs);
    } else {
      backoffs = 0;
      limit = Math.min(settings.max, throttledBefore ? limit + 1 : Math.ceil(limit * 1.5));
    }
  }
  return {
    outcomes: outcomes.map(
      (outcome, index) =>
        outcome ?? { index, state: "not_sent", reason: "budget", attempts: attempts[index] ?? 0 },
    ),
    stopped,
    batches,
  };
}

/**
 * Sorts one answer: a block, a throttle or the site's answer. `challenge` is the host's finding;
 * `expectJson` says the request asked for JSON. Pasted into the page with `adaptiveBatch`.
 */
export function classifyBatchAnswer(
  status: number,
  contentType: string,
  challenge: boolean,
  expectJson: boolean,
): BatchAnswerKind {
  const json = /json/i.test(contentType);
  const html = /html/i.test(contentType);
  if (challenge) return "blocked";
  if (status === 429) return "throttled";
  if (status === 403 && !json) return "blocked";
  if (status === 503) return expectJson && html ? "blocked" : "throttled";
  if (status >= 200 && status < 300 && expectJson && html) return "blocked";
  return "answered";
}

/** A `Retry-After` header as milliseconds from `nowMs`: seconds or an HTTP date. */
export function batchRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  const text = (header ?? "").trim();
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

const writeMethods = new Set(["PUT", "PATCH", "DELETE"]);

/** The index and method of the first request that is a write, if any. */
const firstWrite = (
  requests: readonly { readonly method?: string | undefined; readonly write?: boolean | undefined }[],
) => {
  const index = requests.findIndex(
    (request) => request.write === true || writeMethods.has((request.method ?? "GET").toUpperCase()),
  );
  return index === -1 ? undefined : { index, method: requests[index]?.method ?? "GET" };
};

const settingsOf = (options: BatchReadOptions, clock: BatchClock): BatchSettings => ({
  start: Math.max(1, Math.min(options.start ?? batchReadConcurrency.start, batchReadConcurrency.max)),
  max: Math.max(1, Math.min(options.max ?? batchReadConcurrency.max, batchReadConcurrency.max)),
  maxAttempts: Math.max(1, options.maxAttempts ?? batchReadDefaults.maxAttempts),
  maxWaitMs: options.maxWaitMs ?? batchReadDefaults.maxWaitMs,
  backoffMs: options.backoffMs ?? batchReadDefaults.backoffMs,
  budgetMs: options.budgetMs,
  now: clock.now,
  sleep: clock.sleep,
});

/** One read for `batchRead`: a `SiteHttp` request, with `write: true` on any write. */
export type BatchReadRequest = SiteHttpRequest & { readonly write?: boolean };

export interface BatchReadOptions {
  /** Requests in the first batch, from 1 to 16; 4 by default. */
  readonly start?: number;
  /** The most in one batch, from 1 to 16; 16 by default. Lower it for a site that refuses more. */
  readonly max?: number;
  /** Sends of one throttled request in all; 3 by default. */
  readonly maxAttempts?: number;
  /** The longest wait after a throttle; a longer `Retry-After` stops the batch. 10 s by default. */
  readonly maxWaitMs?: number;
  /** The first wait after a throttle with no `Retry-After`, doubled each time; 1 s by default. */
  readonly backoffMs?: number;
  /** Stop before a batch or wait would start past this many milliseconds; none by default. */
  readonly budgetMs?: number;
  /** The clock; the system's by default. */
  readonly clock?: BatchClock;
}

/** Each request's end in `batchRead`, in input order. */
export type BatchReadItem =
  | { readonly ok: true; readonly response: SiteHttpResult }
  | {
      readonly ok: false;
      /** `throttled`: still 429 or 503 after its tries; `failed`: `SiteHttp` failed it; `not_sent`. */
      readonly reason: "throttled" | "failed" | "not_sent";
      readonly response?: SiteHttpResult;
      readonly failure?: HttpFailure;
    };

export interface BatchReadResult {
  readonly items: readonly BatchReadItem[];
  /** The size of each batch sent, in order. */
  readonly batches: readonly number[];
}

const systemClock: BatchClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Sent =
  | { readonly response: SiteHttpResult; readonly failure?: undefined }
  | { readonly response?: undefined; readonly failure: HttpFailure };

/**
 * Sends independent reads over an HTTP version's `SiteHttp`, as the module comment says, and
 * returns one item per request in input order. A site answer of any status is `ok: true`; check
 * its status as `readText` does. It fails with an `OperationFailure`, sending nothing, when a
 * request is a write, and with an `OperationFailure` that says what came back when the site
 * blocks or rate-limits the batch, so the call fails and a host may give the read another browser
 * or proxy. It never sends a blocked request again.
 */
export const batchRead = (
  http: SiteHttpService,
  requests: readonly BatchReadRequest[],
  options: BatchReadOptions = {},
): Effect.Effect<BatchReadResult, OperationFailure> =>
  Effect.gen(function* () {
    const write = firstWrite(requests);
    if (write !== undefined)
      return yield* Effect.fail(
        new OperationFailure(
          `batchRead sends reads only, and request ${write.index} is a write (${write.method}${requests[write.index]?.write === true ? ", write: true" : ""}). Nothing was sent. Send a write on its own with http.request, under the write's commit rules.`,
          { dispatch: "not_sent" },
        ),
      );
    const clock = options.clock ?? systemClock;
    const run = yield* Effect.promise((signal) =>
      adaptiveBatch<Sent>(
        requests.length,
        async (index) => {
          const request = requests[index];
          if (request === undefined || signal.aborted) throw new Error("not sent");
          const { write: _write, ...siteRequest } = request;
          const exit = await Effect.runPromiseExit(http.request(siteRequest), { signal });
          if (exit._tag === "Failure") {
            const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
            if (failure === undefined) throw new Error(Cause.pretty(exit.cause));
            return { kind: "answered", value: { failure } };
          }
          const response = exit.value;
          const contentType = Object.entries(response.headers)
            .filter(([name]) => name.toLowerCase() === "content-type")
            .flatMap(([, values]) => values)
            .join(", ");
          const accept = Object.entries(siteRequest.headers ?? {})
            .filter(([name]) => name.toLowerCase() === "accept")
            .map(([, value]) => value)
            .join(", ");
          const kind = classifyBatchAnswer(
            response.status,
            contentType,
            response.challenge === true,
            /json/i.test(accept),
          );
          const retryAfter = Object.entries(response.headers)
            .find(([name]) => name.toLowerCase() === "retry-after")?.[1]
            .join(", ");
          return {
            kind,
            value: { response },
            retryAfterMs: kind === "throttled" ? batchRetryAfterMs(retryAfter, clock.now()) : undefined,
          };
        },
        settingsOf(options, clock),
      ),
    );
    const stopped = run.stopped;
    if (stopped !== undefined && stopped.reason !== "budget") {
      const outcome = run.outcomes[stopped.index];
      const request = requests[stopped.index];
      const response =
        outcome !== undefined && "value" in outcome ? outcome.value.response : undefined;
      const answered = run.outcomes.filter((each) => each.state === "answered").length;
      const what =
        stopped.reason === "blocked"
          ? "The site blocked the batch"
          : `The site rate-limited the batch for ${Math.ceil(stopped.retryAfterMs / 1000)} s`;
      return yield* Effect.fail(
        new OperationFailure(
          `${what} at request ${stopped.index}, after ${answered} of ${requests.length} answered; nothing more was sent. ${request !== undefined && response !== undefined ? described(request, response) : ""}`.trim(),
          {
            dispatch: "sent",
            ...(request !== undefined && response !== undefined
              ? { http: answer("destination_status", request, response) }
              : {}),
          },
        ),
      );
    }
    return {
      items: run.outcomes.map((outcome): BatchReadItem => {
        if (outcome.state === "not_sent" || outcome.state === "failed")
          return { ok: false, reason: outcome.state === "failed" ? "failed" : "not_sent" };
        const { response, failure } = outcome.value;
        if (failure !== undefined) return { ok: false, reason: "failed", failure };
        return outcome.state === "answered"
          ? { ok: true, response }
          : { ok: false, reason: "throttled", response };
      }),
      batches: run.batches,
    };
  });

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it once at the top of the
 * code string. It declares `batchFetch(requests, options?)`, which sends every request with the
 * page's own `fetch`, with the page's cookies, inside one `evaluate`, as the module comment says,
 * and returns `{ results, stopped, batches }`.
 *
 * - Each request is `{ url, method?, headers?, body?, as?, write? }`: `method` GET by default,
 *   `body` text, `as` `"json"` (the default, which asks for JSON unless `headers` name an
 *   `accept`) or `"text"`. A write refuses the whole batch with an `Error` named
 *   `BatchFetchRefused` before anything is sent.
 * - `options` takes `start`, `max`, `maxAttempts`, `maxWaitMs`, `backoffMs` and `timeoutMs` (each
 *   fetch's limit, 15 s by default), and `budgetMs`: pass the call's remaining time, less a
 *   margin, so it returns before the call's timeout with `not_sent` for what it kept back.
 * - `results` holds one entry per request, in input order: `{ ok: true, status, data }` (`data`
 *   the parsed JSON or the text), or `{ ok: false, status?, error, snippet? }` with `error` one
 *   of `http_status` (a status outside 2xx), `not_json`, `throttled`, `blocked`, `network` or
 *   `not_sent`. `stopped` is null, or `{ reason, index }` with `reason` `blocked`,
 *   `rate_limited` or `budget`.
 *
 * When `stopped` is `blocked` or `rate_limited`, return it from the call and fail the read in the
 * script, after `waitPastChallenge` when the page shows a challenge, as the core skill's 429 rule
 * says. Never send the batch again in the same call.
 */
export const batchFetchCode = String.raw`
const batchFetch = async (requests, options = {}) => {
  const writeAt = requests.findIndex((request) => request.write === true || ["PUT", "PATCH", "DELETE"].includes(String(request.method ?? "GET").toUpperCase()));
  if (writeAt !== -1) {
    const refused = new Error("batchFetch sends reads only, and request " + writeAt + " is a write. Nothing was sent.");
    refused.name = "BatchFetchRefused";
    throw refused;
  }
  const clamp = (value, fallback) => Math.max(1, Math.min(value ?? fallback, ${batchReadConcurrency.max}));
  const settings = {
    start: clamp(options.start, ${batchReadConcurrency.start}),
    max: clamp(options.max, ${batchReadConcurrency.max}),
    maxAttempts: Math.max(1, options.maxAttempts ?? ${batchReadDefaults.maxAttempts}),
    maxWaitMs: options.maxWaitMs ?? ${batchReadDefaults.maxWaitMs},
    backoffMs: options.backoffMs ?? ${batchReadDefaults.backoffMs},
    timeoutMs: options.timeoutMs ?? ${batchReadDefaults.timeoutMs},
    budgetMs: options.budgetMs,
  };
  return await page.evaluate(async ({ requests, settings }) => {
    const adaptiveBatch = ${adaptiveBatch.toString()};
    const classifyBatchAnswer = ${classifyBatchAnswer.toString()};
    const batchRetryAfterMs = ${batchRetryAfterMs.toString()};
    const snippetOf = (text) => text.replace(/\s+/g, " ").slice(0, 300);
    const run = await adaptiveBatch(requests.length, async (index) => {
      const request = requests[index];
      const as = request.as === "text" ? "text" : "json";
      const headers = new Headers(request.headers ?? {});
      if (as === "json" && !headers.has("accept")) headers.set("accept", "application/json");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      try {
        let response;
        try {
          response = await fetch(request.url, {
            method: request.method ?? "GET",
            headers,
            body: request.body,
            credentials: "include",
            signal: controller.signal,
          });
        } catch (error) {
          return { kind: "answered", value: { ok: false, error: "network", snippet: snippetOf(String(error?.message ?? error)) } };
        }
        const contentType = response.headers.get("content-type") ?? "";
        const text = await response.text();
        const kind = classifyBatchAnswer(response.status, contentType, false, /json/i.test(headers.get("accept") ?? ""));
        const status = response.status;
        if (kind !== "answered")
          return {
            kind,
            value: { ok: false, status, error: kind, snippet: snippetOf(text) },
            retryAfterMs: kind === "throttled" ? batchRetryAfterMs(response.headers.get("retry-after"), Date.now()) : undefined,
          };
        if (status < 200 || status > 299)
          return { kind, value: { ok: false, status, error: "http_status", snippet: snippetOf(text) } };
        if (as === "text") return { kind, value: { ok: true, status, data: text } };
        try {
          return { kind, value: { ok: true, status, data: JSON.parse(text) } };
        } catch {
          return { kind, value: { ok: false, status, error: "not_json", snippet: snippetOf(text) } };
        }
      } finally {
        clearTimeout(timer);
      }
    }, { ...settings, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    return {
      results: run.outcomes.map((outcome) =>
        outcome.state === "not_sent"
          ? { ok: false, error: "not_sent" }
          : outcome.state === "failed"
            ? { ok: false, error: "network", snippet: snippetOf(outcome.error) }
            : outcome.value),
      stopped: run.stopped === undefined ? null : run.stopped,
      batches: run.batches,
    };
  }, { requests, settings });
};
`;
