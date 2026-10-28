import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { publicationFindingId } from "../../src/guardian/publication.js";
import type { PublicationFinding } from "../../src/guardian/review-contracts.js";

/*
 * A publication finding can leave a choice only the owner can make, such as keeping a claim that
 * needs evidence or dropping it. The minter's question names that finding by the id its denial
 * gave, the question review sees the finding itself, and the owner never sees the mark. The real
 * minter loop runs on recorded model responses; the host's publish and review are scripted.
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
const untestedFilter: PublicationFinding = {
  path: "publication/definition.json",
  byteStart: 0,
  byteEnd: 12,
  category: "unsupported_claim",
  explanation: "No passing case applies the color filter the definition claims.",
};
const denial = new MintFailure({
  code: "ReviewDenied",
  review: {
    outcome: "deny",
    reason: "evidence",
    reviewId: "review_synthetic",
    rationale: "Synthetic denial.",
    findings: [untestedFilter],
  },
});
const keepOrDrop = (finding: string) => ({
  finding,
  questions: [
    {
      id: "color_filter",
      type: "choice",
      prompt: "The color filter could not be shown working. Keep it and test it, or leave it out?",
      options: [
        { id: "keep", label: "Keep it and test it" },
        { id: "drop", label: "Leave it out and say it is untested" },
      ],
    },
  ],
});

it("gives the question review the finding a question names, never the owner, and refuses an unknown one", async () => {
  const reviewed: Parameters<NonNullable<MintDependencies["reviewQuestion"]>>[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        example,
        call("finish_build", finishBuild, "first"),
        call("request_input", keepOrDrop(publicationFindingId(untestedFilter)), "about"),
        call("request_input", keepOrDrop("f0123456789"), "unknown"),
      ][index] ?? prose("Stopping."),
    {
      publish: () => Effect.fail(denial),
      reviewQuestion: (request, options) =>
        Effect.sync(() => {
          reviewed.push([request, options]);
          return { outcome: "allow_business" as const, rationale: "The owner's choice." };
        }),
    },
  );
  await f.run();

  // The review judges the question against the finding the host recorded, not the minter's words.
  expect(reviewed[0]?.[1]?.finding).toMatchObject({
    id: publicationFindingId(untestedFilter),
    category: "unsupported_claim",
    explanation: untestedFilter.explanation,
  });
  // The owner reads a plain question: the finding's id stays the host's.
  expect(f.asked).toHaveLength(1);
  expect(f.asked[0]).not.toHaveProperty("finding");
  // A finding the latest denial does not hold is refused before review.
  expect(resultOf(f.requests[4], "unknown")).toMatchObject({
    status: "question_refused",
    reason: "finding_unknown",
    answerable: [publicationFindingId(untestedFilter)],
  });
  expect(reviewed.filter(([, options]) => options?.blockedOutcome !== true)).toHaveLength(1);
});
