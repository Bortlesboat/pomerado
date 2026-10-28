import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { oneTimeLoginUrlParameters, refuseCredentialParts } from "../../src/mint/login-url.js";

const idp = "https://login.example.com/sso/start";

it.each([
  {
    url: `${idp}?client_id=portal&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=af0ifjsldkj81d2c9b7e&nonce=n0S6WzA2Mj91d2f3e7`,
    names: ["code_challenge", "nonce", "state"],
  },
  { url: "https://idp.example.com/sso?SAMLRequest=fZJNb9swDIb%2Fiq", names: ["SAMLRequest"] },
  { url: "https://api.example.com/oauth/login?oauth_token=abc123", names: ["oauth_token"] },
  {
    url: "https://idp.example.com/par?client_id=x&request_uri=urn:ietf:params:oauth:request_uri:6esc29",
    names: ["request_uri"],
  },
  {
    url: `${idp}#state=af0ifjsldkj81d2c9b7e&code_verifier=abc`,
    names: ["code_verifier", "state"],
  },
  // A base64 state or nonce keeps its `+`, `/` and `=`, escaped or not.
  { url: `${idp}?state=ab12+cd34/ef56gh78==`, names: ["state"] },
  { url: `${idp}?nonce=ab12%2Bcd34%2Fef56gh78%3D`, names: ["nonce"] },
  { url: `${idp}#state=ab12+cd34+ef56gh78`, names: ["state"] },
  // A parameter-only fragment whose value holds a `?` is still read as a whole.
  { url: `${idp}#SAMLRequest=abc?def`, names: ["SAMLRequest"] },
  {
    url: `${idp}#state=af0ifjsldkj81d2c9b7e&code_verifier=abc?def`,
    names: ["code_verifier", "state"],
  },
  // Hash-routed URLs carrying one-time parameters in their route query.
  {
    url: "https://example.com/#/oauth/callback?code_challenge=xyz123",
    names: ["code_challenge"],
  },
  {
    url: "https://example.com/#/oauth/callback?code_challenge=xyz123&code_verifier=abc",
    names: ["code_challenge", "code_verifier"],
  },
  {
    url: "https://example.com/#/oauth/callback?state=ab12+cd34+ef56gh78",
    names: ["state"],
  },
  // An identity provider's authorize endpoint is one authorization request, one-time values or not.
  {
    url: "https://acme.okta.com/oauth2/default/v1/authorize?client_id=portal&response_type=code",
    names: ["/oauth2/default/v1/authorize"],
  },
  {
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=portal",
    names: ["/common/oauth2/v2.0/authorize"],
  },
  { url: "https://tenant.auth0.com/authorize?client_id=portal", names: ["/authorize"] },
  {
    url: "https://sso.example.com/as/authorization.oauth2?client_id=portal&state=af0ifjsldkj81d2c9b7e",
    names: ["/as/authorization.oauth2", "state"],
  },
  {
    url: "https://id.example.com/realms/members/protocol/openid-connect/auth?client_id=portal",
    names: ["/realms/members/protocol/openid-connect/auth"],
  },
  // A device or session identifier the site put in the link for the browser that read it.
  {
    url: "https://shop.example/login?x-shop-did=3f2b8c1e-9a4d-4e7b-b6c2-5d1f0a9e8b7c&state=af0ifjsldkj81d2c9b7e",
    names: ["state", "x-shop-did"],
  },
  {
    url: "https://shop.example/login?lang=en&device_id=3F2B8C1E-9A4D-4E7B-B6C2-5D1F0A9E8B7C",
    names: ["device_id"],
  },
  { url: "https://shop.example/login?deviceId=d41d8cd98f00b204e980", names: ["deviceId"] },
  { url: "https://shop.example/login?sid=Zx81kQp02LmVt7rWs9Ya", names: ["sid"] },
  { url: "https://shop.example/login#SessionId=a8F3kL0pQ9zX2vB7nM4t", names: ["SessionId"] },
  {
    url: "https://shop.example/signin?JSESSIONID=1A2B3C4D5E6F7A8B9C0D",
    names: ["JSESSIONID"],
  },
  { url: "https://shop.example/login?session.id=9b1deb4d3b7d4bad9bdd2b0d", names: ["session.id"] },
])("names the one-time parameters of $url", ({ url, names }) => {
  expect(oneTimeLoginUrlParameters(url)).toEqual(names);
});

it.each([
  "https://member.example.com/login?next=%2Fclaims&lang=en",
  // A readable or short state is a site setting, not a random one-time value.
  "https://member.example.com/login?state=CA",
  "https://member.example.com/login?state=signed-in-members",
  // Only the OAuth pushed-request form of request_uri is one-time.
  "https://member.example.com/login?request_uri=%2Fclaims",
  // Paths that only resemble an authorize endpoint.
  "https://member.example.com/authorized-users",
  "https://member.example.com/account/auth",
  "https://member.example.com/authorize/help/faq",
  // Hash routes without one-time parameters.
  "https://member.example.com/#/dashboard?lang=en",
  "https://member.example.com/#/oauth/callback",
  // A readable device or session value is a site setting, not one browser's identifier.
  "https://shop.example/login?sid=en",
  "https://shop.example/login?did=yes",
  "https://shop.example/login?session_id=guest-checkout-flow",
  // Parameters that only end in similar letters, and stable public identifiers.
  "https://shop.example/login?client_id=3f2b8c1e-9a4d-4e7b-b6c2-5d1f0a9e8b7c&lang=en",
  "https://shop.example/login?paid=3f2b8c1e-9a4d-4e7b-b6c2-5d1f0a9e8b7c",
  "not a url",
])("finds nothing one-time in %s", (url) => {
  expect(oneTimeLoginUrlParameters(url)).toEqual([]);
});

/** A matcher over registered values, as a host's screening reports them: kinds, never values. */
const matcher = (registered: Readonly<Record<string, string>>) => ({
  registeredSecretMatches: (text: string) =>
    Effect.succeed(
      Object.entries(registered)
        .filter(([, value]) => text.includes(value))
        .map(([entity]) => ({ entity, supplied: true, sessionToken: false })),
    ),
});

it("refuses each published part that holds a registered credential, naming the part and kind", async () => {
  const refused = await Effect.runPromise(
    Effect.either(
      refuseCredentialParts(matcher({ email: "ada@example.test", password: "synthetic-pass" }), {
        loginUrl: "https://example.test/login?email=ada%40example.test",
        name: "orders_for_ada@example.test",
        description: "Reads orders.",
        site: undefined,
      }),
    ),
  );
  if (Either.isRight(refused)) throw new Error("The parts were published");
  // The login URL holds the value only percent-encoded, which this matcher does not decode.
  expect(refused.left).toMatchObject({
    code: "PublicationUnavailable",
    reason: "metadata_contains_credential",
    publicationFeedback: { parts: [{ part: "name", credentialKinds: ["email"] }] },
  });
  expect(JSON.stringify(refused.left)).not.toContain("ada@example.test");
});

it("names the login URL first when it holds a credential, and passes parts that hold none", async () => {
  const screening = matcher({ username: "ada-synthetic" });
  const refused = await Effect.runPromise(
    Effect.either(
      refuseCredentialParts(screening, {
        loginUrl: "https://example.test/login?user=ada-synthetic",
        name: "orders",
        description: "Reads orders.",
        site: { name: "Example", summary: "A shop for ada-synthetic." },
      }),
    ),
  );
  if (Either.isRight(refused)) throw new Error("The login URL was published");
  expect(refused.left).toMatchObject({
    reason: "login_url_contains_credential",
    publicationFeedback: {
      parts: [
        { part: "loginUrl", credentialKinds: ["username"] },
        { part: "siteSummary", credentialKinds: ["username"] },
      ],
    },
  });
  await Effect.runPromise(
    refuseCredentialParts(screening, {
      loginUrl: undefined,
      name: "orders",
      description: "Reads orders.",
      site: undefined,
    }),
  );
});

it("refuses a part it cannot screen, with its credential kind unnamed", async () => {
  const refused = await Effect.runPromise(
    Effect.either(
      refuseCredentialParts(
        { registeredSecretMatches: () => Effect.fail(new Error("screening closed")) },
        { loginUrl: undefined, name: "orders", description: "Reads orders.", site: undefined },
      ),
    ),
  );
  if (Either.isRight(refused)) throw new Error("An unscreened part was published");
  expect(refused.left).toMatchObject({
    reason: "metadata_contains_credential",
    publicationFeedback: {
      parts: [
        { part: "name", credentialKinds: ["credential"] },
        { part: "description", credentialKinds: ["credential"] },
      ],
    },
  });
});
