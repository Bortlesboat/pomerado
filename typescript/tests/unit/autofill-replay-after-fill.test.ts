import { Clock, Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillSignedInCheck, AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// What a screen's wait does after the host filled a screen: a fill whose screen went with nothing
// sent waits again once, as a single-page app's login route removes its form while it sends a
// signed-in browser on; and once the login went out, a page off the sign-in screens that can't
// tell, such as an account picker, signs in, though a code screen's wait runs to its deadline first.
// A submitted screen still showing is the site's answer only at the wait's deadline.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const pollMs = 50;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const passwordScreen = {
  page: login,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#go",
};
const isPassword = (step: AutofillStep) =>
  step.fields.some((field) => field.selector === "#password");
const shownAt = (page: string, step: AutofillStep) => ({
  page,
  siteOrigin: origin,
  authenticationOrigins: [],
  targets: {
    fields: step.fields.map(() => target),
    submit: { ...target, editable: false, control: "other" as const },
  },
  screen: { origin, fields: [], submit: null, buttons: ["Sign in"] },
});

/** Replays `recipe` with the login on `hooks`, the test clock moving one poll at a time. */
const replay = async (
  recipe: AutofillRecipe,
  hooks: AutofillHooks<TestFailure>,
  hostCode?: string,
) => {
  const events: unknown[] = [];
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: login,
          credentials: { username: "synthetic-user", password: "synthetic-password" },
          ask: () => Effect.dieMessage("Unexpected question"),
          broker: {
            register: () => Effect.void,
            registeredSecretMatches: () => Effect.succeed([]),
          },
          site: "example.test",
          correlation: undefined,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          failures: {
            unanswered: () => new TestFailure({ code: "Unanswered" }),
            unavailable: () => new TestFailure({ code: "Unavailable" }),
          },
          timing: { stepWaitMs: 5_000, pollMs },
          sent: { current: false },
          ...(hostCode === undefined
            ? {}
            : { hosted: { code: () => Effect.succeed({ slot: "code" as const, value: hostCode }) } }),
        }).pipe(Effect.scoped),
      );
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(running))) break;
        yield* TestClock.adjust(Duration.millis(pollMs));
      }
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  return { outcome, events };
};

/**
 * A saved profile's login form that the page removes as the host fills it, sending nothing, then
 * the page moves on to the signed-in home page; with `stays`, the form stays and the fill failed.
 */
const goneUnderFill = (stays: boolean) => {
  let page: "login" | "home" = "login";
  const here = (): AutofillSignedInCheck =>
    page === "home"
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        if (!stays) page = "home";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "failed" as const })),
          submit: "not_attempted" as const,
          url: login,
        };
      }),
  };
  return hooks;
};

const recipe: AutofillRecipe = {
  version: 2,
  steps: [passwordScreen],
  signedIn: { selector: "#identity" },
};

it("waits again once when a fill's screen went with nothing sent, and finds the session signed in", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(false));
  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
  expect(events).toContainEqual({ stage: "retried", reason: "screen_gone" });
});

it("ends a failed fill whose screen still shows as before", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(true));
  expect(outcome).toMatchObject({ outcome: "unsent", reason: "fill_failed" });
  expect(events).not.toContainEqual({ stage: "retried", reason: "screen_gone" });
});

it("signs in on an account picker that can't tell in place of a code screen, once the code screen's wait ran out", async () => {
  let page: "login" | "picker" = "login";
  const confirmed: unknown[] = [];
  const here = (): AutofillSignedInCheck =>
    page === "picker"
      ? { signedIn: false, failed: "path_mismatch", url: `${origin}/choose` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        page = "picker";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: login,
        };
      }),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        passwordScreen,
        { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
      ],
      signedIn: { selector: "#identity", urlPath: "/account" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, cantTell: true });
  expect(events).not.toContainEqual({ stage: "skipped", reason: "cant_tell_landing" });
  expect(confirmed).toHaveLength(1);
});

it("waits for a password screen the site shows 1.5 s after the identifier went out", async () => {
  let continuedAt: number | undefined;
  let signedIn = false;
  const here = (): AutofillSignedInCheck =>
    signedIn
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    // The site looks the account up for 1.5 s, showing the identifier screen meanwhile.
    inspect: (step) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          isPassword(step) === (continuedAt !== undefined && now - continuedAt >= 1_500)
            ? shownAt(login, step)
            : ({ outcome: "refused", reason: "not_found" } as const),
        ),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (isPassword(step)) signedIn = true;
          else continuedAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
  };
  const { outcome } = await replay(
    {
      version: 2,
      steps: [
        { page: login, fields: [{ selector: "#email", accepts: ["username"] }], submit: "#continue" },
        passwordScreen,
      ],
      signedIn: { selector: "#identity" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
});

// A site may show a page the recipe never recorded, such as a security check, between the login
// and its recorded code screen. The code screen's wait doesn't read that page as a landing that
// can't tell, so the code screen that shows 4 s after the login, within the 5 s wait, gets its code.
it("waits for a recorded code screen through an unrecorded page that can't tell, then fills it", async () => {
  let sentAt: number | undefined;
  let codeSent = false;
  const confirmed: unknown[] = [];
  const pageNow = Clock.currentTimeMillis.pipe(
    Effect.map((now) =>
      codeSent
        ? "account"
        : sentAt === undefined
          ? "login"
          : now - sentAt < 4_000
            ? "security"
            : "verify",
    ),
  );
  const here = Effect.map(
    pageNow,
    (page): AutofillSignedInCheck =>
      page === "account"
        ? { signedIn: true, url: `${origin}/account` }
        : page === "security"
          ? { signedIn: false, failed: "path_mismatch", url: `${origin}/checkpoint` }
          : {
              signedIn: false,
              failed: "indicator_not_visible",
              url: page === "login" ? login : `${origin}/verify`,
            },
  );
  const isCode = (step: AutofillStep) => step.fields.some((field) => field.slot === "code");
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => here,
    confirm: () => here,
    inspect: (step) =>
      Effect.map(pageNow, (page) =>
        isCode(step) && page === "verify"
          ? shownAt(`${origin}/verify`, step)
          : isPassword(step) && page === "login"
            ? shownAt(login, step)
            : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (isCode(step)) codeSent = true;
          else sentAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        passwordScreen,
        { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
      ],
      signedIn: { selector: "#identity", urlPath: "/account" },
    },
    hooks,
    "246810",
  );
  expect(codeSent).toBe(true);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(outcome).not.toHaveProperty("cantTell");
  expect(events).not.toContainEqual({ stage: "skipped", reason: "cant_tell_landing" });
  expect(confirmed).toHaveLength(0);
});
