/** One option a picker listed, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its text, first line, accessible name, title, cells. */
  readonly names: readonly string[];
  /** The value the option carries in an attribute, such as `data-value`, or "". */
  readonly value: string;
  readonly disabled: boolean;
  /** Options with one key are one option seen twice; different keys are different options. */
  readonly key: string;
}

/** How closely the winning option matched, best first. */
export const pickerRanks = ["exact", "normalized", "folded", "leading", "words", "allWords", "stem"] as const;
export type PickerRank = (typeof pickerRanks)[number];

export type PickerRanking =
  | { readonly status: "picked"; readonly index: number; readonly rank: PickerRank }
  | { readonly status: "disabled"; readonly index: number; readonly rank: PickerRank }
  | {
      readonly status: "ambiguous";
      readonly indexes: readonly number[];
      readonly rank: PickerRank;
    }
  | { readonly status: "missing" };

/**
 * The one option `wanted` names, a list of spellings of one choice, by rank: a name or the value
 * as written (trimmed), then ignoring case and spacing, then also ignoring accents and
 * punctuation (`fold`), then, only with `options.leading`, a name whose leading part, its text
 * before its first comma that is not between two digits, is a spelling, folded the same way
 * (`leading`: York, UK for York, but not 1,000 miles for 1), then a name holding a spelling as
 * whole words (New York for York), then a name made of a spelling's words, no more and no fewer,
 * whose parts, as its own or the spelling's commas, semicolons, colons, slashes, bars, brackets or
 * spaced dashes separate them, come in another order, each part's words in order and the numbers
 * in the spelling's order (`allWords`: Harbor Street Station, Example City for Example City Harbor
 * Street Station, but never Example Fort for Fort Example, Floor 12 Room 3 for Room 12 Floor 3, or
 * a name with a word the spelling lacks, such as Example Harbor 5th Avenue Mall for Example 5th
 * Avenue, which may be another place than the one asked for), then, only with `options.stem`, a name whose words pair one
 * for one, in order, with a spelling's (`stem`), as a read asks for and a write never does. Two
 * words pair when they are equal, or when both are Latin letters only and the shorter, of five or
 * more letters, is the whole start of the longer, such as Dentist and Dentistry or Dentists and
 * Dentist, but not Employee and Employer, County and Country, Physician and Physics, Adam and
 * Adams, or UK and Ukraine. The value never matches by stem. A name beats the value at each rank.
 * Options at the first rank that matches decide: one option (by key) is picked, or reported
 * disabled when every copy of it is; two or more are ambiguous, never guessed. A weaker rank never
 * overrules a stronger one, so a disabled exact match is not replaced by a looser one. Without
 * `options.leading`, no option ranks `leading`; without `options.stem`, none ranks `stem`. With
 * `options.spellings`, such as `spellingsOf`, each rank also tries the other written forms of a
 * spelling against option names, never values, once the spellings as given match nothing at that
 * rank: so Fifth Avenue for 5th Avenue matches as a name before any option holding the same words
 * in another order, while a spelling that already matches at a rank is never overruled by one of
 * its forms. As whole words, a place's other form counts only after the value's other words and
 * where it ends the name or one of its parts, so Ontario never matches Turn on and Example City,
 * Oregon never matches Example City or Town. Each name and each list of spellings is read once per
 * call.
 *
 * It is pure and self-contained: the page code of `pickerCode` embeds this same function with
 * `fold` set to `foldChoiceText`.
 */
export const rankChoices = (
  choices: readonly PickerChoice[],
  wanted: readonly string[],
  fold: (text: string) => string,
  options: {
    readonly leading?: boolean;
    readonly stem?: boolean;
    readonly spellings?: (
      text: string,
      options?: { readonly places?: "end" | "after-words" | "never" },
    ) => readonly string[];
  } = {},
): PickerRanking => {
  const squash = (text: string) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const lower = (text: string) => squash(text).toLowerCase();
  const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrase = (text: string) => " " + words(text).join(" ") + " ";
  // Each name is read once per call, however many spellings and ranks try it.
  const once = <T>(make: (text: string) => T) => {
    const known = new Map<string, T>();
    return (text: string): T => {
      if (!known.has(text)) known.set(text, make(text));
      return known.get(text) as T;
    };
  };
  // A text's words in the parts its own commas, semicolons, colons, slashes, bars, brackets or
  // spaced dashes separate, such as "Harbor Street Station" and "Example City" in "Harbor Street
  // Station - Example City". A hyphen inside a word, as in St-Mary, separates nothing.
  const parted = (text: string) => {
    const parts = String(text ?? "")
      .split(/[,;:|/\\()[\]{}\u2013\u2014]|\s-|-\s/u)
      .map(words)
      .filter((part) => part.length > 0);
    const all = parts.flat();
    // Where each part ends, counted in words.
    const ends = parts.map((_, index) => parts.slice(0, index + 1).flat().length);
    return { parts, all, ends, numbers: all.filter((word) => /\p{N}/u.test(word)).join(" ") };
  };
  // Whether `target` is `parts` laid end to end in some order, each part's words in its order.
  const composes = (target: readonly string[], parts: readonly (readonly string[])[]) => {
    if (parts.length < 2) return false;
    const used = parts.map(() => false);
    const from = (at: number): boolean =>
      at === target.length ||
      parts.some((part, index) => {
        if (used[index] || !part.every((word, offset) => target[at + offset] === word)) return false;
        used[index] = true;
        const done = from(at + part.length);
        used[index] = false;
        return done;
      });
    return from(0);
  };
  const named = {
    lower: once(lower),
    fold: once(fold),
    words: once(words),
    phrase: once(phrase),
    parted: once(parted),
  };
  // Two words pair when they are equal, or when both are Latin letters only and the shorter, of
  // five or more letters, is the whole start of the longer.
  const latin = /^\p{Script=Latin}+$/u;
  const pairs = (want: string, have: string) => {
    if (want === have) return true;
    if (!latin.test(want) || !latin.test(have)) return false;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    return short.length >= 5 && long.startsWith(short);
  };
  const spellings = wanted.map(squash).filter((spelling) => spelling !== "");
  // The other written forms of the spellings, such as Fifth for 5th, which only names match.
  const formsOf = (places: "end" | "after-words" | "never") => [
    ...new Set(
      spellings
        .flatMap((spelling) => options.spellings?.(spelling, { places }) ?? [])
        .map(squash)
        .filter((form) => form !== "" && !spellings.includes(form)),
    ),
  ];
  const others = formsOf("end");
  // As whole words, a place's other form, such as on for Ontario or or for Oregon, counts only
  // after the value's other words and where it ends the name or one of its parts: alone it is a
  // common word, as in Turn on or Yes or no.
  const plainOthers = formsOf("never");
  const wordOthers = [...new Set([...plainOthers, ...formsOf("after-words")])];
  const placed = new Set(wordOthers.filter((form) => !plainOthers.includes(form)));
  // What a rank reads from a list of spellings, worked out once per list rather than per option.
  const perList = <T>(make: (list: readonly string[]) => T) => {
    const known = new Map<readonly string[], T>();
    return (list: readonly string[]): T => {
      if (!known.has(list)) known.set(list, make(list));
      return known.get(list) as T;
    };
  };
  const formSets = {
    lower: perList((list) => new Set(list.map(lower).filter((spelling) => spelling !== ""))),
    fold: perList((list) => new Set(list.map(fold).filter((spelling) => spelling !== ""))),
  };
  const phrases = perList((list) => ({
    anywhere: list.filter((form) => !placed.has(form)).map(phrase).filter((part) => part.trim() !== ""),
    ending: list.filter((form) => placed.has(form)).map(words).filter((each) => each.length > 0),
  }));
  const wordLists = perList((list) => list.map(words).filter((each) => each.length > 0));
  const partLists = perList((list) => list.map(parted).filter((each) => each.all.length > 1));
  type Test = (choice: PickerChoice, list: readonly string[]) => boolean;
  const tests: readonly (readonly [PickerRank, Test, boolean])[] = [
    ["exact", (choice, list) => choice.names.some((name) => list.includes(squash(name))), true],
    ["exact", (choice, list) => choice.value !== "" && list.includes(squash(choice.value)), false],
    ...(["lower", "fold"] as const).flatMap((form) => {
      const rank = form === "lower" ? "normalized" : "folded";
      return [
        [rank, (choice: PickerChoice, list: readonly string[]) => {
          const set = formSets[form](list);
          return choice.names.some((name) => set.has(named[form](name)));
        }, true],
        [rank, (choice: PickerChoice, list: readonly string[]) =>
          choice.value !== "" && formSets[form](list).has(named[form](choice.value)), false],
      ] as const;
    }),
    ...(options.leading === true
      ? ([
          [
            "leading",
            (choice: PickerChoice, list: readonly string[]) => {
              const forms = formSets.fold(list);
              return choice.names.some((name) => {
                // The first comma that is not a thousands separator, as in 1,000.
                const comma = String(name ?? "").search(/(?<!\p{N}),|,(?!\p{N})/u);
                return comma > 0 && forms.has(fold(String(name).slice(0, comma)));
              });
            },
            true,
          ],
        ] as const)
      : []),
    [
      "words",
      (choice, list) => {
        const { anywhere, ending } = phrases(list);
        return choice.names.some((name) => {
          const have = named.phrase(name);
          if (anywhere.some((part) => have.includes(part))) return true;
          if (ending.length === 0) return false;
          const { all, ends } = named.parted(name);
          return ending.some((want) =>
            ends.some((end) => end >= want.length && want.every((word, at) => all[end - want.length + at] === word)),
          );
        });
      },
      true,
    ],
    [
      "allWords",
      // The same words, no more and no fewer, with the name's or the spelling's parts in another
      // order, and the numbers in the spelling's order.
      (choice, list) => {
        const wants = partLists(list);
        return choice.names.some((name) => {
          const have = named.parted(name);
          return wants.some(
            (want) =>
              want.all.length === have.all.length &&
              want.numbers === have.numbers &&
              (composes(want.all, have.parts) || composes(have.all, want.parts)),
          );
        });
      },
      true,
    ],
    [
      "stem",
      (choice, list) => {
        if (options.stem !== true) return false;
        const wants = wordLists(list);
        return choice.names.some((name) => {
          const have = named.words(name);
          return wants.some((want) => want.length === have.length && want.every((word, at) => pairs(word, have[at] ?? "")));
        });
      },
      true,
    ],
  ];
  for (const [rank, test, byName] of tests) {
    // At each rank the spellings as given decide first; their other forms only when they match
    // nothing there, and never an option's value.
    const forms = rank === "words" ? wordOthers : others;
    const lists = byName && forms.length > 0 ? [spellings, forms] : [spellings];
    for (const list of lists) {
      const matched = choices.flatMap((choice, index) => (test(choice, list) ? [index] : []));
      if (matched.length === 0) continue;
      const keys = [...new Set(matched.map((index) => choices[index]?.key))];
      if (keys.length > 1) {
        const indexes = keys.map((key) => matched.find((index) => choices[index]?.key === key) ?? 0);
        return { status: "ambiguous", indexes, rank };
      }
      const enabled = matched.find((index) => choices[index]?.disabled === false);
      return enabled === undefined
        ? { status: "disabled", index: matched[0] ?? 0, rank }
        : { status: "picked", index: enabled, rank };
    }
  }
  return { status: "missing" };
};

/**
 * `labels` with those closest to `query` first, by `score` (such as `rankByWords`, which scores
 * every label against the query at once), keeping the given order among equal scores, so the
 * options nearest a value the picker lacks survive a cap on how many a refusal lists. An empty
 * query keeps the given order.
 */
export const closestFirst = (
  labels: readonly string[],
  query: string,
  score: (query: string, texts: readonly string[]) => readonly number[],
): string[] => {
  if (String(query ?? "").trim() === "" || labels.length < 2) return [...labels];
  const scores = score(query, labels);
  return labels
    .map((label, index) => ({ label, index, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ label }) => label);
};
