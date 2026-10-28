import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  declaredFileLimits,
  limitedInputFiles,
  makeRunFiles,
  siteFileRefusal,
  siteFileRefusalMessage,
  type FileHostHook,
} from "../../src/runtime/file-transfer.js";
import { FileInput, fileInputWithin, type FileRefused } from "../../src/runtime/files.js";
import { contractJsonSchema } from "../../src/runtime/operation.js";

const megabyte = 1024 * 1024;

describe("a file input's site limits", () => {
  // The published schema is how a host knows the limits before a run starts, so the declaration
  // must put them beside the file marker and keep every other keyword of the field.
  it("puts maxBytes and extensions beside format file in the published schema", () => {
    const schema = contractJsonSchema(
      Schema.Struct({
        resume: fileInputWithin({ maxBytes: megabyte, extensions: [".pdf", ".docx"] }).annotations({
          description: "The applicant's resume",
        }),
        cover: FileInput,
      }),
    ) as { properties: Record<string, unknown> };
    expect(schema.properties["resume"]).toEqual({
      type: "string",
      title: "File",
      description: "The applicant's resume",
      minLength: 1,
      format: "file",
      maxBytes: megabyte,
      extensions: [".pdf", ".docx"],
    });
    expect(schema.properties["cover"]).not.toHaveProperty("maxBytes");
    // The field still decodes a reference as a plain file input does.
    expect(Schema.decodeUnknownSync(fileInputWithin({ maxBytes: 1 }))("file:///tmp/a.pdf")).toBe(
      "file:///tmp/a.pdf",
    );
  });

  it("refuses limits that are not a positive whole number of bytes and name endings", () => {
    for (const limits of [
      { maxBytes: 0 },
      { maxBytes: 1.5 },
      { extensions: ["pdf"] },
      { extensions: [] },
      { maxBytes: 1, accept: "pdf" },
    ])
      expect(() => fileInputWithin(limits), JSON.stringify(limits)).toThrow();
  });

  it("reads the limits a field declares and leaves out a keyword that is not a limit", () => {
    expect(declaredFileLimits({ type: "string", format: "file", maxBytes: 10 })).toEqual({
      maxBytes: 10,
    });
    expect(
      declaredFileLimits({ type: "string", format: "file", maxBytes: "5MB", extensions: [".pdf"] }),
    ).toEqual({ extensions: [".pdf"] });
    expect(declaredFileLimits({ type: "string", format: "file" })).toBeUndefined();
    // Only a file field declares file limits.
    expect(declaredFileLimits({ type: "string", maxBytes: 10 })).toBeUndefined();
  });

  it("finds each limited file the input names, through properties, items, unions and references", () => {
    const Limited = fileInputWithin({ maxBytes: megabyte });
    const Applicant = Schema.Struct({
      resume: Limited,
      portfolio: Schema.optional(Limited),
    }).annotations({ identifier: "Applicant" });
    const schema = contractJsonSchema(
      Schema.Struct({
        applicant: Applicant,
        attachments: Schema.Array(fileInputWithin({ extensions: [".png"] })),
        photo: Schema.NullOr(fileInputWithin({ extensions: [".jpg"] })),
        "cover letter": Limited,
        plain: FileInput,
      }),
    );
    expect(JSON.stringify(schema)).toContain("$ref");
    const found = limitedInputFiles(schema, {
      applicant: { resume: "file:///a.pdf" },
      attachments: ["file:///b.png", "file:///c.png"],
      photo: null,
      "cover letter": "file:///d.pdf",
      plain: "file:///e.pdf",
    });
    expect(found).toEqual([
      { path: "applicant.resume", reference: "file:///a.pdf", limits: { maxBytes: megabyte } },
      { path: "attachments[0]", reference: "file:///b.png", limits: { extensions: [".png"] } },
      { path: "attachments[1]", reference: "file:///c.png", limits: { extensions: [".png"] } },
      { path: '["cover letter"]', reference: "file:///d.pdf", limits: { maxBytes: megabyte } },
    ]);
    // A schema without limits, or an input that names no file, finds nothing.
    expect(limitedInputFiles(contractJsonSchema(Schema.Struct({ a: FileInput })), { a: "x" })).toEqual(
      [],
    );
    expect(limitedInputFiles(schema, {})).toEqual([]);
  });

  it("refuses a file over maxBytes or with a name ending extensions does not list", () => {
    const limits = { maxBytes: 100, extensions: [".pdf", ".TAR.GZ"] };
    expect(siteFileRefusal(limits, { name: "a.pdf", size: 100 })).toBeUndefined();
    expect(siteFileRefusal(limits, { name: "A.PDF", size: 1 })).toBeUndefined();
    expect(siteFileRefusal(limits, { name: "b.tar.gz", size: 1 })).toBeUndefined();
    expect(siteFileRefusal(limits, { name: "a.pdf", size: 101 })).toBe("too_large");
    expect(siteFileRefusal(limits, { name: "a.docx", size: 1 })).toBe("not_accepted");
    expect(siteFileRefusal(limits, { name: "pdf", size: 1 })).toBe("not_accepted");
    expect(siteFileRefusal({}, { name: "anything", size: 10 ** 9 })).toBeUndefined();
  });

  it("tells the caller the input and the limit, never the file's name", () => {
    const limits = { maxBytes: megabyte, extensions: [".pdf", ".docx"] };
    const tooLarge = siteFileRefusalMessage("resume", limits, {
      reason: "too_large",
      size: 2 * megabyte,
    });
    expect(tooLarge).toBe(
      `Caller input error: resume is ${2 * megabyte} bytes, over the site's limit of ${megabyte} bytes for this file. Send a smaller file.`,
    );
    expect(siteFileRefusalMessage("resume", limits, { reason: "not_accepted", size: 1 })).toBe(
      "Caller input error: resume is not a file type the site takes for this input, which takes only .pdf, .docx. Send a file of one of those types.",
    );
  });
});

describe("files.place with the site's limits", () => {
  /** A host whose one file is `name` of `size` bytes, recording each step it is asked for. */
  const host = (name: string, size: number) => {
    const steps: string[] = [];
    const hook: FileHostHook = {
      open: () =>
        Effect.succeed({
          name,
          media_type: "text/plain",
          size,
          read: Effect.sync(() => {
            steps.push("read");
            return new Uint8Array(size).fill(97);
          }),
        }),
      writeToBrowser: () =>
        Effect.sync(() => {
          steps.push("write");
          return "/tmp/placed";
        }),
      armDownloads: () => Effect.die("unused"),
      takeDownload: () => Effect.die("unused"),
      keep: () => Effect.die("unused"),
    };
    const files = Effect.runSync(
      makeRunFiles({
        hook,
        execute: () =>
          Effect.sync(() => {
            steps.push("page");
            return { success: true, result: { chosen: [{ name, size }] } };
          }),
        siteOrigin: "https://example.test",
        resolve: (reference) => reference,
      }),
    );
    return { files, steps };
  };
  const place = (
    files: ReturnType<typeof host>["files"],
    limits: { readonly maxBytes?: number; readonly extensions?: readonly string[] },
  ) =>
    Effect.runSync(
      Effect.either(
        files.place({ reference: "receipt", field: { label: "Receipt" }, timeoutSec: 5, ...limits }),
      ),
    );

  // The refusal comes before a byte is read or the page is called, so the input is never set.
  it("refuses a file outside them before it reads the file or calls the page", () => {
    for (const [limits, reason] of [
      [{ maxBytes: megabyte }, "too_large"],
      [{ extensions: [".pdf"] }, "not_accepted"],
    ] as const) {
      const { files, steps } = host("receipt.txt", 2 * megabyte);
      const refused = place(files, limits);
      expect(Either.isLeft(refused) && (refused.left as FileRefused)).toMatchObject({
        reason,
      });
      expect(Either.isLeft(refused) && refused.left.dispatched).toBeUndefined();
      expect(steps).toEqual([]);
    }
  });

  it("places a file within them, and one with no limits, as before", () => {
    for (const limits of [{ maxBytes: megabyte, extensions: [".TXT"] }, {}]) {
      const { files, steps } = host("receipt.txt", megabyte / 2);
      expect(place(files, limits)).toEqual(
        Either.right({ name: "receipt.txt", media_type: "text/plain", size: megabyte / 2 }),
      );
      expect(steps).toEqual(["read", "write", "page"]);
    }
  });
});
