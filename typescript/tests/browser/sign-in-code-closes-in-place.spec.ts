import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose recorded code screen has a Verify button, but whose own script sends the
// code as the field takes its last digit and takes the button away in place, with no new
// document. The host never clicks anything there, so the recorded Verify is gone when it looks
// for it. The sign-in's own marker check decides whether the page sent the code.

const site = "https://site.example.test";
const host = "site.example.test";
const code = "246810";
const login = { username: "owner@site.example.test", password: "synthetic-password" };
// A sign-in screen, a code screen, the host's looks for a new document and the marker's wait:
// more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

const signedIn = '<p id="account">Signed in</p>';

/**
 * A screen in a dialog whose own script, as `field` takes its last input, takes the dialog's
 * button away, sends what was typed to `endpoint`, and on a good answer puts the account in place
 * of the dialog when `marker`, else leaves the dialog as it is. Nothing loads a new document.
 * `ready` says when the field holds all it takes. Each click of the button is counted.
 */
const closingDialog = (options: {
  readonly field: string;
  readonly button: string;
  readonly ready: string;
  readonly endpoint: string;
  readonly marker: boolean;
}) => `<div id="dialog">${options.field}${options.button}</div>
<script>
const dialog = document.getElementById("dialog");
const field = dialog.querySelector("input:last-of-type");
window.clicks = 0;
dialog.querySelector("button").addEventListener("click", () => { window.clicks += 1; });
field.addEventListener("input", () => {
  if (!(${options.ready})) return;
  dialog.querySelector("button")?.remove();
  fetch(${JSON.stringify(options.endpoint)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: field.value }) })
    .then((response) => {
      if (response.ok && ${JSON.stringify(options.marker)}) dialog.outerHTML = ${JSON.stringify(signedIn)};
    });
});
</script>`;

/** The code screen: one code field and a Verify button, closed in place on the sixth digit. */
const codeScreen = (marker: boolean) =>
  closingDialog({
    field: '<label>Code<input id="otc" name="otc" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>',
    button: '<button id="verify" type="button">Verify</button>',
    ready: "/^[0-9]{6}$/.test(field.value)",
    endpoint: "/api/code",
    marker,
  });

/**
 * The site: an email form at /login that posts to /session, whose page sends the browser on to
 * `next` at /next. It keeps each value the next screen's script sends, by its path, and answers
 * it a second later, so the host's first look after typing finds the field still there and the
 * button gone.
 */
const serve = async (page: Page, next: string) => {
  const sent: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/")) {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const value: unknown = Reflect.get(Object(body), "value");
      sent.push(`${path} ${typeof value === "string" ? value : ""}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else if (request.method() === "POST" && path === "/session")
      await route.fulfill({ contentType: "text/html", body: '<script>location.replace("/next")</script>' });
    else if (path === "/next") await route.fulfill({ contentType: "text/html", body: next });
    else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><button id="continue">Continue</button></form>',
      });
  });
  return sent;
};

const emailScreen = {
  page: `${site}/login`,
  fields: [{ selector: "#email", accepts: ["email"] }],
  submit: "#continue",
  submittedBy: "host",
} as const;

/** The recipe the build recorded: the email, then a code screen with its Verify button. */
const codeRecipe = {
  version: 2,
  steps: [
    emailScreen,
    {
      page: `${site}/next`,
      fields: [{ selector: "#otc", slot: "code" }],
      submit: "#verify",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** One run's sign-in with `recipe`, answering the login ask and each code ask. */
const run = async (page: Page, recipe: typeof codeRecipe) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: makeSignInBrowser({
          page: browser,
          keyboard,
          siteOrigin: site,
          authenticationOrigins: [],
          typing: { typed: false },
        }),
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  for (const value of [code, login.password]) expectNotCarried(browser.calls, value);
  // How the sign-in ended, as the run reads it.
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, prompts };
};

const codePrompt = `Enter the sign-in code ${host} sent you.`;

test("a run signs in through a code screen that sends itself on its last digit and takes its Verify button away in place", async ({
  page,
}) => {
  const sent = await serve(page, codeScreen(true));
  const { ended, prompts } = await run(page, codeRecipe);
  expect(ended).toEqual({ signedIn: true, alreadySignedIn: false });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(sent).toEqual([`/api/code ${code}`]);
  await expect(page.locator("#account")).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(0);
});

test("a run still refuses a code screen that took its Verify button away in place when the marker never shows", async ({
  page,
}) => {
  const sent = await serve(page, codeScreen(false));
  const { ended, prompts } = await run(page, codeRecipe);
  expect(ended).toEqual({ code: "RecipeFailed", reason: "submit_refused" });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(sent).toEqual([`/api/code ${code}`]);
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(0);
});
