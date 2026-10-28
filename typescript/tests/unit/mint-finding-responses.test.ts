import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type PublicationRequest } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { publicationFindingId } from "../../src/guardian/publication-delta.js";
import type { PublicationFinding } from "../../src/guardian/review-contracts.js";

/*
 * A minter that holds a Guardian publication finding wrong answers it in its next finish_build,
 * rather than resubmitting unchanged: each answer names the finding by the id its denial gave,
 * reaches the host's publication review, and the review's ruling comes back with the denial. The
 * real minter loop runs on recorded model responses; the host's publish is scripted.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const prose = (text: string): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});
const call = (name: string, input: Record<string, unknown>, id: string): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId: id,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});
const resultOf = (request: ModelRequest | undefined, callId: string): Record<string, unknown> => {
  const item = (Array.isArray(request?.input) ? request.input : []).find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  ) as { readonly output?: unknown } | undefined;
  const output = item?.output;
  return JSON.parse(
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? String(output.text)
        : JSON.stringify(output),
  ) as Record<string, unknown>;
};

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const example = call(
  "execute",
  {
    purpose: "example",
    target: "pureFiles",
    entrypoint: "src/tool.ts",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 30,
  },
  "example",
);
const finishBuild = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};

const nullableRating: PublicationFinding = {
  path: "operation/src/tool.ts",
  byteStart: 0,
  byteEnd: 10,
  category: "schema_mismatch",
  explanation: "The rating is nullable; read it from the page or say why it is absent.",
};
const untestedFilter: PublicationFinding = {
  path: "publication/definition.json",
  byteStart: 0,
  byteEnd: 12,
  category: "unsupported_claim",
  explanation: "No passing case applies the color filter the definition claims.",
};
const denial = (
  findings: readonly PublicationFinding[],
  responseRulings?: NonNullable<MintFailure["review"]>["responseRulings"],
) =>
  new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      reason: "evidence",
      reviewId: "review_synthetic",
      rationale: "Synthetic denial.",
      findings,
      ...(responseRulings === undefined ? {} : { responseRulings }),
    },
  });

const ratingAnswer = {
  finding: publicationFindingId(nullableRating),
  response: "The site shows no rating for unrated items, so null is the page's own state.",
  evidence: { caseId: "unrated-item" },
};
const filterAnswer = {
  finding: publicationFindingId(untestedFilter),
  response: "The color filter works the same way as the size filter.",
};
const bothAnswers = [ratingAnswer, filterAnswer];
const twice = [filterAnswer, filterAnswer];

it("carries an answer to the review, returns its ruling, and refuses an unknown one", async () => {
  const submitted: PublicationRequest[] = [];
  const replies = [
    denial([nullableRating, untestedFilter]),
    // The review accepts the rating answer and rejects the one with no evidence for the claim.
    denial(
      [untestedFilter],
      [
        { finding: ratingAnswer.finding, ruling: "accepted", reason: "The unrated case passes." },
        { finding: filterAnswer.finding, ruling: "rejected", reason: "No case for the filter." },
      ],
    ),
  ];
  const f = await fixture(
    (_request, index) =>
      [
        example,
        call("finish_build", finishBuild, "first"),
        call("finish_build", { ...finishBuild, findingResponses: bothAnswers }, "answered"),
        call(
          "finish_build",
          { ...finishBuild, findingResponses: [{ ...ratingAnswer, finding: "f0123456789" }] },
          "unknown",
        ),
        call("finish_build", { ...finishBuild, findingResponses: twice }, "twice"),
        call("finish_build", { ...finishBuild, findingResponses: bothAnswers }, "again"),
      ][index] ?? prose("Stopping."),
    {
      publish: (request) =>
        Effect.suspend(() => {
          submitted.push(request);
          return Effect.fail(replies[submitted.length - 1] ?? denial([untestedFilter]));
        }),
    },
  );
  await f.run();

  // The denial gives each finding an id the minter can name.
  expect(resultOf(f.requests[2], "first")).toMatchObject({
    review: {
      findings: [{ id: ratingAnswer.finding }, { id: filterAnswer.finding }],
    },
  });
  // The answers reach the host's review, and the review's rulings come back with its denial.
  expect(submitted[1]?.findingResponses).toEqual([ratingAnswer, filterAnswer]);
  expect(resultOf(f.requests[3], "answered")).toMatchObject({
    review: {
      responseRulings: [
        { finding: ratingAnswer.finding, ruling: "accepted" },
        { finding: filterAnswer.finding, ruling: "rejected" },
      ],
    },
  });
  // A finding the latest denial no longer holds, or one answered twice, is refused unreviewed.
  expect(resultOf(f.requests[4], "unknown")).toMatchObject({
    reason: "finding_responses_unknown",
    unanswerable: ["f0123456789"],
    answerable: [filterAnswer.finding],
  });
  expect(resultOf(f.requests[5], "twice")).toMatchObject({
    reason: "finding_responses_unknown",
    unanswerable: [filterAnswer.finding],
  });
  // The rating finding is gone from the latest denial, so answering it again is refused too.
  expect(resultOf(f.requests[6], "again")).toMatchObject({ reason: "finding_responses_unknown" });
  expect(submitted).toHaveLength(2);
});

it("refuses an answer sent again unchanged after the review ruled on it", async () => {
  let reviews = 0;
  const f = await fixture(
    (_request, index) =>
      [
        example,
        call("finish_build", finishBuild, "first"),
        call("finish_build", { ...finishBuild, findingResponses: [filterAnswer] }, "answered"),
        call("finish_build", { ...finishBuild, findingResponses: [filterAnswer] }, "unchanged"),
      ][index] ?? prose("Stopping."),
    {
      publish: () =>
        Effect.suspend(() => {
          reviews++;
          return Effect.fail(
            denial(
              [untestedFilter],
              reviews === 1
                ? undefined
                : [{ finding: filterAnswer.finding, ruling: "rejected", reason: "No case." }],
            ),
          );
        }),
    },
  );
  await f.run();
  expect(reviews).toBe(2);
  expect(resultOf(f.requests[4], "unchanged")).toMatchObject({ reason: "unchanged_since_denial" });
});
