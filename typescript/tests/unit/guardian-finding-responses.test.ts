import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { makeGuardian, ReviewFailure, type PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { publicationFindingId } from "../../src/guardian/publication-delta.js";
import type { FindingResponse } from "../../src/guardian/review-contracts.js";

/*
 * The minter's answers to the findings of the publication review that denied it reach the next
 * round of the same build, beside the prior findings they name, and that round's decision rules
 * on each one. Guardian runs on recorded model responses; the files are a synthetic catalog tool.
 */

afterEach(() => {
  setDefaultModelProvider(new OpenAIProvider());
});

const toolPath = "operation/src/tool.mjs";
const definitionPath = "publication/definition.json";
const testsPath = "publication/tests.json";

const toolSource = [
  "export const read = async (page) => {",
  "  const title = await page.locator('h1').textContent();",
  "  const rating = await page.locator('.rating').textContent().catch(() => null);",
  "  const color = await page.locator('.color').textContent();",
  "  return { title, rating, color };",
  "};",
  "",
].join("\n");
const definition = JSON.stringify(
  {
    name: "read_item",
    description: "Read one catalog item's title, rating and color, filtered by color",
    inputSchema: { type: "object", properties: { color: { type: "string" } } },
    outputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        rating: { type: ["string", "null"], description: "Null when the item has no rating" },
        color: { type: "string" },
      },
    },
  },
  null,
  2,
);
const tests = JSON.stringify({
  cases: [
    { id: "unrated-item", input: {}, expectation: "result", results: { playwright: "pass" } },
  ],
});
const files: ReadonlyMap<string, string> = new Map([
  [toolPath, toolSource],
  [definitionPath, definition],
  [testsPath, tests],
]);

const pendingFor = (extra: Partial<PendingExecution> = {}): PendingExecution => ({
  invocationId: "invocation_answers",
  attemptId: "attempt_answers",
  entrypoint: toolPath,
  screenedIntent: "Read the item's title, rating and color",
  screenedInput: "{}",
  screenedObservations: "The example completed.",
  accountScope: "account_answers",
  allowedOrigins: ["https://catalog.example.test"],
  allowedEffects: ["Publish the current operation bundle only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: path.startsWith("operation/") || path === definitionPath,
      current: true,
      owner: path.startsWith("operation/") ? ("minter" as const) : ("host" as const),
    })),
  },
  ...extra,
});
const reader = makeSourceInspector(
  (path) =>
    Effect.suspend(() => {
      const text = files.get(path);
      return text === undefined
        ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
        : Effect.succeed(new TextEncoder().encode(text));
    }),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const ratingFinding = {
  path: toolPath,
  quote: ".catch(() => null)",
  category: "schema_mismatch",
  explanation: "A failed rating read returns null; read the rating or say why the page lacks it.",
  route: null,
};
const filterFinding = {
  path: definitionPath,
  quote: "filtered by color",
  category: "unsupported_claim",
  explanation: "No passing case applies the color filter the description claims.",
  route: null,
};
const firstDenial = {
  outcome: "deny",
  reason: "evidence",
  rationale: "The rating may be null on a failed read, and no case applies the color filter.",
  findings: [ratingFinding, filterFinding],
};

/** Recorded model turns, in order; each request is kept. */
const recorded = (turns: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const output = turns[requests.length - 1];
        if (output === undefined) throw new Error("No recorded turn");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
const guardian = () =>
  makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
    }),
    undefined,
    {},
  );

/** The newest review request in a model request, parsed. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const items = typeof request?.input === "string" ? [] : (request?.input ?? []);
  const last = items
    .flatMap((item) =>
      typeof item === "object" &&
      "role" in item &&
      item.role === "user" &&
      typeof item.content === "string" &&
      item.content.startsWith("{")
        ? [item.content]
        : [],
    )
    .at(-1);
  if (last === undefined) throw new Error("No review request");
  return JSON.parse(last) as Record<string, unknown>;
};

/** Round one's denial, and the ids the minter names its two findings by. */
const deniedFirst = async (review: ReturnType<typeof guardian>) => {
  const first = await Effect.runPromise(review.review(pendingFor(), reader));
  expect(first.decision.outcome).toBe("deny");
  const [rating, filter] = (first.decision.findings ?? []).map(publicationFindingId);
  if (rating === undefined || filter === undefined) throw new Error("Expected two findings");
  return { rating, filter };
};

describe("a minter's answers to the prior round's findings", () => {
  it("reach the next round by id, and an answer the evidence backs is accepted", async () => {
    recorded([[message(firstDenial)]]);
    const review = guardian();
    const ids = await deniedFirst(review);
    const answer: FindingResponse = {
      finding: ids.rating,
      response: "The site shows no rating for unrated items; the unrated-item case passes.",
      evidence: { caseId: "unrated-item" },
    };
    // Recorded after round one, since the ruling names the id the host gave its finding.
    const later = recorded([
      [
        message({
          outcome: "deny",
          reason: "evidence",
          rationale: "The rating answer holds; the color filter is still untested.",
          findings: [filterFinding],
          responseRulings: [
            { finding: ids.rating, ruling: "accepted", reason: "The unrated-item case passes." },
          ],
        }),
      ],
    ]);
    const second = await Effect.runPromise(
      review.review(pendingFor({ findingResponses: [answer] }), reader),
    );
    expect(reviewRequest(later[0])["untrusted_finding_responses"]).toEqual([answer]);
    expect(second.decision).toMatchObject({
      outcome: "deny",
      findings: [{ category: "unsupported_claim" }],
      responseRulings: [{ finding: ids.rating, ruling: "accepted" }],
    });
  });

  it("sends the answer beside the prior findings, and rejects one with no evidence", async () => {
    const requests = recorded([[message(firstDenial)]]);
    const review = guardian();
    const ids = await deniedFirst(review);
    const answer: FindingResponse = { finding: ids.filter, response: "It works like size." };
    const later = recorded([
      [
        message({
          outcome: "deny",
          reason: "evidence",
          rationale: "The answer gives no case that applies the color filter.",
          findings: [filterFinding],
          responseRulings: [
            { finding: ids.filter, ruling: "rejected", reason: "No case applies the filter." },
          ],
        }),
      ],
    ]);
    const second = await Effect.runPromise(
      review.review(pendingFor({ findingResponses: [answer] }), reader),
    );
    expect(requests).toHaveLength(1);
    const request = reviewRequest(later[0]);
    expect(request["untrusted_finding_responses"]).toEqual([answer]);
    expect(request).toMatchObject({
      publication_delta: { priorReview: { findings: [{ id: ids.rating }, { id: ids.filter }] } },
    });
    // An answer to an evidence finding that offers no evidence is rejected, and the finding stands.
    expect(second.decision).toMatchObject({
      outcome: "deny",
      findings: [{ category: "unsupported_claim" }],
      responseRulings: [{ finding: ids.filter, ruling: "rejected" }],
    });
  });

  it("asks once more when the decision leaves an answer unruled", async () => {
    recorded([[message(firstDenial)]]);
    const review = guardian();
    const ids = await deniedFirst(review);
    const ruled = {
      outcome: "deny",
      reason: "evidence",
      rationale: "The color filter is still untested.",
      findings: [filterFinding],
    };
    const later = recorded([
      [message(ruled)],
      [
        message({
          ...ruled,
          responseRulings: [
            { finding: ids.filter, ruling: "rejected", reason: "No case applies the filter." },
          ],
        }),
      ],
    ]);
    const second = await Effect.runPromise(
      review.review(
        pendingFor({ findingResponses: [{ finding: ids.filter, response: "Like size." }] }),
        reader,
      ),
    );
    expect(later).toHaveLength(2);
    expect(second.decision.responseRulings).toEqual([
      { finding: ids.filter, ruling: "rejected", reason: "No case applies the filter." },
    ]);
  });

  it("keeps an answer to a finding the prior round never returned out of the review", async () => {
    recorded([[message(firstDenial)]]);
    const review = guardian();
    await deniedFirst(review);
    const later = recorded([
      [
        message({
          outcome: "allow",
          rationale: "Synthetic allow.",
          responseRulings: [{ finding: "f0123456789", ruling: "accepted", reason: "Unasked." }],
        }),
      ],
    ]);
    const second = await Effect.runPromise(
      review.review(
        pendingFor({ findingResponses: [{ finding: "f0123456789", response: "Not a finding." }] }),
        reader,
      ),
    );
    expect(reviewRequest(later[0])).not.toHaveProperty("untrusted_finding_responses");
    // A ruling on an answer the review did not carry is dropped.
    expect(second.decision).not.toHaveProperty("responseRulings");
    expect(second.decision.outcome).toBe("allow");
  });
});
