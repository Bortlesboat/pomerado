import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose recorded code screen has six one-digit boxes and a Verify button, but whose
// own script sends the code as the sixth box takes its digit, with no new document. The site takes
// a code once: a second check of it answers that the code expired and signs the session out. So the
// host must not click Verify after the page sent the code itself.

const site = "https://site.example.test";
const host = "site.example.test";
const code = "246810";
const login = { username: "owner@site.example.test", password: "synthetic-password" };
// Six boxes filled one focus and one insertion at a time, the host's looks and the marker's wait:
// more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

const boxes = [1, 2, 3, 4, 5, 6]
  .map(
    (box) =>
      `<input id="otp-${box}" name="d${box}" class="otp" maxlength="1" inputmode="numeric" aria-label="Digit ${box}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
  )
  .join("");

/**
 * The code screen: six boxes and a Verify button. The sixth digit sends the code once, and so does
 * each click of Verify, which is counted. An accepted code puts the account in place of the screen;
 * an expired one signs the session out.
 */
const codeScreen = `<main id="view"><p>Enter the code we sent you</p>${boxes}<button id="verify" type="button">Verify</button></main>
<script>
const view = document.getElementById("view");
const boxes = [...document.querySelectorAll(".otp")];
const typed = () => boxes.map((box) => box.value).join("");
window.clicks = 0;
let sent = false;
const check = () =>
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed() }) })
    .then((response) => {
      view.innerHTML = response.ok ? '<p id="account">Signed in</p>' : '<p id="signed-out">Your code expired</p>';
    });
boxes.forEach((box, index) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[index + 1]) boxes[index + 1].focus();
  if (sent || !/^[0-9]{6}$/.test(typed())) return;
  sent = true;
  check();
}));
document.getElementById("verify").addEventListener("click", () => {
  window.clicks += 1;
  check();
});
</script>`;

/**
 * The site: the code screen at /verify. It keeps each code check and answers it 600 ms later,
 * the first as accepted and any later one as expired.
 */
const serve = async (page: Page) => {
  const checks: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/code") {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const value: unknown = Reflect.get(Object(body), "code");
      checks.push(typeof value === "string" ? value : "");
      const first = checks.length === 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: first ? 200 : 401,
        contentType: "application/json",
        body: "{}",
      });
    } else await route.fulfill({ contentType: "text/html", body: codeScreen });
  });
  return checks;
};

/** The recipe the build recorded: one code screen, its six boxes and its Verify button. */
const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/verify`,
      fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })),
      submit: "#verify",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** One run's sign-in, answering each code ask, with every fill's report. */
const run = async (page: Page) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const reports: AutofillStepReport[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/verify`,
        browser: {
          ...signIn,
          fill: (input) => signIn.fill(input).pipe(Effect.tap((report) => reports.push(report))),
        },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expectNotCarried(browser.calls, code);
  const ended = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { ended, reports };
};

test("a run signs in through six code boxes that send the code themselves, and never clicks Verify after them", async ({
  page,
}) => {
  const checks = await serve(page);
  const { ended, reports } = await run(page);
  expect(ended).toEqual({ signedIn: true, alreadySignedIn: false });
  expect(checks).toEqual([code]);
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(0);
  await expect(page.locator("#account")).toBeVisible();
  // The host clicked nothing and found the code screen closed in place, and the sign-in's own
  // check found the account, so the replay counted the screen as sent by the page.
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    outcome: "filled",
    fields: recipe.steps[0].fields.map(() => ({ slot: "code", status: "filled" })),
    closedInPlace: true,
  });
  expect(reports[0]).not.toHaveProperty("clicked");
  expect(JSON.stringify(reports)).not.toContain(code);
});
