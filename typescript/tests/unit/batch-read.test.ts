import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchFetchCode, batchRead } from "../../src/browser/index.js";
import type { BatchClock, SiteHttpRequest, SiteHttpResult, SiteHttpService } from "../../src/browser/index.js";
import { OperationFailure } from "../../src/runtime/operation-failure.js";

// The batch-read helpers against a scripted site: each request's answers in order, a controlled
// clock, and a count of requests in flight.

interface Scripted {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly challenge?: true;
}

const json = (body: unknown, status = 200): Scripted => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const fakeClock = () => {
  let now = 0;
  const waits: number[] = [];
  const clock: BatchClock = {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  return { clock, waits };
};

/** A site whose answers to each URL come from `script`, in order, the last one repeating. */
const scriptedSite = (script: (url: string) => readonly Scripted[]) => {
  const sent: string[] = [];
  const tries = new Map<string, number>();
  let inFlight = 0;
  let mostInFlight = 0;
  const pending: (() => void)[] = [];
  const answerFor = (url: string) => {
    const attempt = tries.get(url) ?? 0;
    tries.set(url, attempt + 1);
    const answers = script(url);
    return answers[Math.min(attempt, answers.length - 1)] ?? json(null);
  };
  /** Answers once every request in flight has arrived, so each batch is counted whole. */
  const respond = async (url: string) => {
    sent.push(url);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const scripted = answerFor(url);
    await new Promise<void>((resolve) => {
      pending.push(resolve);
      setTimeout(() => {
        const ready = pending.splice(0);
        // Later requests in the batch answer first, so order comes only from the helper.
        for (const release of ready.reverse()) release();
      }, 0);
    });
    inFlight -= 1;
    return scripted;
  };
  const http: SiteHttpService = {
    capabilities: [],
    siteOrigin: "https://shop.example",
    request: (request: SiteHttpRequest) =>
      Effect.promise(async (): Promise<SiteHttpResult> => {
        const scripted = await respond(request.url);
        return {
          status: scripted.status,
          headers: Object.fromEntries(
            Object.entries(scripted.headers ?? {}).map(([name, value]) => [name, [value]]),
          ),
          body: new TextEncoder().encode(scripted.body ?? ""),
          transport: "kernel-curl",
          gaps: [],
          requestUrl: request.url,
          ...(scripted.challenge ? { challenge: true as const } : {}),
        };
      }),
  };
  const fetch = async (url: string) => {
    const scripted = await respond(url);
    return new Response(scripted.body ?? "", {
      status: scripted.status,
      headers: scripted.headers ?? {},
    });
  };
  return { http, fetch, sent, mostInFlight: () => mostInFlight };
};

const itemUrl = (index: number) => `https://shop.example/api/items/${index}`;
const reads = (count: number): SiteHttpRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    url: itemUrl(index),
    method: "GET",
    headers: { accept: "application/json" },
  }));
const idOf = (url: string) => Number(url.split("/").pop());
const bodies = (items: readonly { ok: boolean; response?: SiteHttpResult }[]) =>
  items.map((item) =>
    item.response === undefined ? null : JSON.parse(new TextDecoder().decode(item.response.body)),
  );

describe("batchRead", () => {
  it("raises the batch size after clean batches, up to 16", async () => {
    const site = scriptedSite((url) => [json({ id: idOf(url) })]);
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(70), { clock }));
    expect(result.batches).toEqual([4, 6, 9, 14, 16, 16, 5]);
    expect(site.mostInFlight()).toBe(16);
    expect(waits).toEqual([]);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  it("halves the batch size on a 429 and waits its Retry-After before sending it again", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(2)
        ? [{ status: 429, headers: { "retry-after": "3" } }, json({ id: 2 })]
        : [json({ id: idOf(url) })],
    );
    const { clock, waits } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(12), { clock }));
    expect(waits).toEqual([3000]);
    // 4 sent, one throttled: 2 next (the throttled one first), then growing by one at a time.
    expect(result.batches).toEqual([4, 2, 3, 4]);
    expect(site.sent.slice(4, 6)).toEqual([itemUrl(2), itemUrl(4)]);
    expect(bodies(result.items)).toEqual(Array.from({ length: 12 }, (_, id) => ({ id })));
  });

  it("stops at a challenge and sends nothing more", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(5) ? [{ status: 200, challenge: true, body: "<html>" }] : [json({ id: idOf(url) })],
    );
    const { clock } = fakeClock();
    const outcome = await Effect.runPromise(
      Effect.either(batchRead(site.http, reads(30), { clock })),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(OperationFailure);
      expect(outcome.left.dispatch).toBe("sent");
      expect(outcome.left.http?.status).toBe(200);
    }
    // The first batch of 4, then the batch of 6 holding the challenge; item 5 was sent once.
    expect(site.sent.length).toBe(10);
    expect(site.sent.filter((url) => url === itemUrl(5))).toHaveLength(1);
  });

  it("returns every request's result in input order, however they answer", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(3) ? [json({ missing: true }, 404)] : [json({ id: idOf(url) })],
    );
    const { clock } = fakeClock();
    const result = await Effect.runPromise(batchRead(site.http, reads(9), { clock }));
    expect(result.items.map((item) => item.ok && item.response.status)).toEqual([
      200, 200, 200, 404, 200, 200, 200, 200, 200,
    ]);
    expect(bodies(result.items)).toEqual([
      ...[0, 1, 2].map((id) => ({ id })),
      { missing: true },
      ...[4, 5, 6, 7, 8].map((id) => ({ id })),
    ]);
  });

  it("refuses a batch holding a write, sending nothing", async () => {
    const site = scriptedSite(() => [json({})]);
    for (const write of [
      { url: itemUrl(1), method: "PUT" as const },
      { url: itemUrl(1), method: "POST" as const, body: "{}", write: true },
    ]) {
      const outcome = await Effect.runPromise(
        Effect.either(batchRead(site.http, [...reads(2), write])),
      );
      expect(Either.isLeft(outcome) && outcome.left.dispatch).toBe("not_sent");
    }
    expect(site.sent).toEqual([]);
  });
});

/** Runs `batchFetchCode` as a Kernel call body would, with a page whose evaluate runs here. */
const runBatchFetch = async (requests: readonly unknown[], options: unknown = {}) => {
  const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) };
  const body = new Function(
    "page",
    "requests",
    "options",
    `return (async () => {${batchFetchCode}\nreturn await batchFetch(requests, options);})();`,
  ) as (page: unknown, requests: unknown, options: unknown) => Promise<{
    results: { ok: boolean; status?: number; data?: unknown; error?: string }[];
    stopped: { reason: string; index: number } | null;
    batches: number[];
  }>;
  return body(page, requests, options);
};

describe("batchFetch in the page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns results in input order and stops at a block, marking the rest not sent", async () => {
    const site = scriptedSite((url) =>
      url === itemUrl(6)
        ? [{ status: 403, headers: { "content-type": "text/html" }, body: "<html>Access denied" }]
        : [json({ id: idOf(url) })],
    );
    vi.stubGlobal("fetch", site.fetch);
    const answer = await runBatchFetch(Array.from({ length: 20 }, (_, index) => ({ url: itemUrl(index) })));
    expect(answer.stopped).toEqual({ reason: "blocked", index: 6 });
    expect(answer.batches).toEqual([4, 6]);
    expect(answer.results.map((result) => result.data ?? result.error)).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((id) => ({ id })),
      "blocked",
      ...[7, 8, 9].map((id) => ({ id })),
      ...Array.from({ length: 10 }, () => "not_sent"),
    ]);
  });

  it("refuses a write before anything is sent", async () => {
    const site = scriptedSite(() => [json({})]);
    vi.stubGlobal("fetch", site.fetch);
    await expect(
      runBatchFetch([{ url: itemUrl(0) }, { url: itemUrl(1), method: "DELETE" }]),
    ).rejects.toMatchObject({ name: "BatchFetchRefused" });
    expect(site.sent).toEqual([]);
  });
});
