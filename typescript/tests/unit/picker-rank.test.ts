import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { PickOutcome, pickRefusal } from "../../src/browser/picker.js";
import { closestFirst, rankChoices, type PickerChoice } from "../../src/browser/picker-rank.js";
import { foldChoiceText, rankByWords, spellingsOf } from "../../src/runtime/text.js";

const choice = (names: string | readonly string[], value = "", disabled = false): PickerChoice => {
  const list = typeof names === "string" ? [names] : names;
  return { names: list, value, disabled, key: `${list.join("|")}#${value}` };
};
const rank = (choices: readonly PickerChoice[], ...wanted: string[]) =>
  rankChoices(choices, wanted, foldChoiceText);
const stemRank = (choices: readonly PickerChoice[], ...wanted: string[]) =>
  rankChoices(choices, wanted, foldChoiceText, { stem: true });
const rankForms = (choices: readonly PickerChoice[], ...wanted: string[]) =>
  rankChoices(choices, wanted, foldChoiceText, { spellings: spellingsOf });
const rankLeading = (choices: readonly PickerChoice[], ...wanted: string[]) =>
  rankChoices(choices, wanted, foldChoiceText, { leading: true });

describe("rankChoices", () => {
  test("a name as written beats one that matches only once case and spacing are ignored", () => {
    const choices = [choice("Basic"), choice("basic"), choice("Basic  plus")];
    expect(rank(choices, "basic")).toEqual({ status: "picked", index: 1, rank: "exact" });
    expect(rank(choices, "  Basic ")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank(choices, "BASIC")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "normalized" });
    expect(rank(choices, "basic PLUS")).toEqual({ status: "picked", index: 2, rank: "normalized" });
  });

  test("accents and punctuation are folded only after exact and case matches", () => {
    const choices = [choice("Abacá"), choice("St. Louis"), choice("Joe’s Café")];
    expect(rank(choices, "abaca")).toEqual({ status: "picked", index: 0, rank: "folded" });
    expect(rank(choices, "St Louis")).toEqual({ status: "picked", index: 1, rank: "folded" });
    expect(rank(choices, "joes cafe")).toEqual({ status: "picked", index: 2, rank: "folded" });
  });

  test("a name beats a value at the same rank, and a value matches when no name does", () => {
    const choices = [choice("CA", "ca-code"), choice("California", "CA")];
    expect(rank(choices, "CA")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank([choice("California", "CA")], "ca")).toEqual({ status: "picked", index: 0, rank: "normalized" });
  });

  test("whole words of a name match last, and a prefix never does", () => {
    const choices = [choice("Chicago O'Hare (ORD)"), choice("Chicago Midway (MDW)")];
    expect(rank(choices, "ORD")).toEqual({ status: "picked", index: 0, rank: "words" });
    expect(rank(choices, "Chicago")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    expect(rank(choices, "Chic")).toEqual({ status: "missing" });
  });

  test("with leading, a name whose text before its first comma is the value beats one holding it as a word", () => {
    const choices = [choice("New York, NY"), choice("York, UK"), choice("Yorkshire")];
    expect(rankLeading(choices, "York")).toEqual({ status: "picked", index: 1, rank: "leading" });
    expect(rankLeading(choices, "york")).toEqual({ status: "picked", index: 1, rank: "leading" });
    expect(rankLeading([choice("New York"), choice("York, UK")], "York")).toEqual({ status: "picked", index: 1, rank: "leading" });
    // Two leading parts that are the value still tie, and with none only whole words match.
    expect(rankLeading([choice("York, UK"), choice("York, PA")], "York")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "leading" });
    expect(rankLeading([choice("New York"), choice("York Minster")], "York")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    // A whole name still beats a leading part, and a leading part is never a prefix of a word.
    expect(rankLeading([choice("York, UK"), choice("York")], "York")).toEqual({ status: "picked", index: 1, rank: "exact" });
    expect(rankLeading([choice("Yorktown, VA")], "York")).toEqual({ status: "missing" });
  });

  test("without leading, options that hold the value as a word or before a comma tie as before", () => {
    expect(rank([choice("New York"), choice("York, UK")], "York")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    expect(rank([choice("Springfield, IL"), choice("West Springfield, MA")], "Springfield")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "words",
    });
    expect(rank([choice("Smith, John"), choice("Jane Smith")], "Smith")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    expect(rank([choice("New York, NY"), choice("York, UK")], "York").status).toBe("ambiguous");
  });

  test("a comma between two digits never ends a leading part", () => {
    // 1,000 miles has no leading part, so 1 matches both options only as a whole word.
    expect(rankLeading([choice("1 adult"), choice("1,000 miles")], "1")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    expect(rankLeading([choice("1,000 miles")], "1")).toEqual({ status: "picked", index: 0, rank: "words" });
    // The first comma that is not between digits still ends it.
    expect(rankLeading([choice("1,000 miles, economy"), choice("1,000 points")], "1,000 miles")).toEqual({
      status: "picked",
      index: 0,
      rank: "leading",
    });
  });

  test("any spelling of the value may match, but two spellings naming two options tie", () => {
    const choices = [choice("California", "CA"), choice("Canada", "CAN")];
    expect(rank(choices, "Calif.", "California")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank(choices, "California", "Canada")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "exact" });
  });

  test("any of an option's names matches, such as a title or a table cell", () => {
    const row = choice(["C-101 Acme Insurance Group Boston", "C-101", "Acme Insurance Group", "Boston"], "C-101");
    expect(rank([row], "Acme Insurance Group")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank([choice(["Acme Insur…", "Acme Insurance Group"])], "acme insurance group")).toMatchObject({ status: "picked" });
  });

  test("copies of one option count once and a disabled copy is skipped; a disabled best match is reported", () => {
    const copy = choice("Oslo", "osl");
    expect(rank([{ ...copy, disabled: true }, copy], "Oslo")).toEqual({ status: "picked", index: 1, rank: "exact" });
    // A looser enabled match never replaces a disabled exact one.
    expect(rank([choice("Oslo", "", true), choice("Oslo Airport")], "Oslo")).toEqual({ status: "disabled", index: 0, rank: "exact" });
  });

  test("two options with one label and different values are ambiguous", () => {
    expect(rank([choice("John Smith", "17"), choice("John Smith", "42")], "John Smith")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "exact",
    });
  });

  test("a name made of the same words with its parts in another order matches after whole words", () => {
    const stations = [choice("Harbor Street Station, Example City"), choice("Pier Road Station, Example City")];
    expect(rank(stations, "Example City Harbor Street Station")).toEqual({ status: "picked", index: 0, rank: "allWords" });
    // The parts may be split by the value's own comma or dash instead of the name's.
    expect(rank([choice("Example City Harbor Street Station")], "Harbor Street Station - Example City")).toEqual({
      status: "picked",
      index: 0,
      rank: "allWords",
    });
    // Numbers in the same order as the value's still match.
    expect(rank([choice("Springfield, 12 Main St 62701")], "12 Main St 62701 Springfield")).toEqual({
      status: "picked",
      index: 0,
      rank: "allWords",
    });
    // A name holding the value as written, or as whole words in order, still wins.
    expect(rank([choice("Harbor Street, Example City"), choice("Example City Harbor Street Station")], "Example City Harbor Street")).toEqual({
      status: "picked",
      index: 1,
      rank: "words",
    });
    // Two options at that rank tie.
    expect(rank([choice("Harbor Street, Example City", "1"), choice("Harbor Street, Example City", "2")], "Example City Harbor Street")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "allWords",
    });
  });

  test("a name with words the value lacks, or the same words in another order within one part, is refused", () => {
    // Extra words: the value's entity may be missing from the list, so a name that merely holds
    // every word is a different place, store or address.
    expect(rankForms([choice("Example Harbor 5th Avenue Mall")], "Example 5th Avenue")).toEqual({ status: "missing" });
    expect(rankForms([choice("Exampleton Airport Oregon")], "Exampleton OR")).toEqual({ status: "missing" });
    expect(rankForms([choice("Exampleville Station Massachusetts")], "Exampleville, MA")).toEqual({ status: "missing" });
    expect(rankForms([choice("Example Street Station")], "St Example")).toEqual({ status: "missing" });
    expect(rankForms([choice("Gate 12 Level 3")], "Gate 3 12")).toEqual({ status: "missing" });
    expect(rank([choice("Example City, WA - Harbor Street Station (EXC)")], "Example City Harbor Street")).toEqual({ status: "missing" });
    // The same words reordered inside one part name something else.
    expect(rankForms([choice("Floor 12 Room 3")], "Room 12 Floor 3")).toEqual({ status: "missing" });
    expect(rankForms([choice("Example Fort TX")], "Fort Example TX")).toEqual({ status: "missing" });
    expect(rankForms([choice("Example Fort")], "Fort Example")).toEqual({ status: "missing" });
    // Parts in another order never put the value's numbers in another order.
    expect(rankForms([choice("Level 12, Gate 3")], "Gate 3 Level 12")).toEqual({ status: "missing" });
  });

  test("an empty or blank value matches nothing", () => {
    expect(rank([choice("Anything"), choice("")], "")).toEqual({ status: "missing" });
    expect(rank([choice("Anything")], "   ")).toEqual({ status: "missing" });
  });
});

describe("rankChoices other written forms", () => {
  test("an option naming an ordinal in words beats one merely holding every word as given", () => {
    const stores = [choice("Example Fifth Avenue"), choice("Example Harbor 5th Avenue Mall")];
    expect(rankForms(stores, "Example 5th Avenue")).toEqual({ status: "picked", index: 0, rank: "normalized" });
    expect(rankForms([choice("Example 3rd Street"), choice("Example Third Street Annex")], "Example Third St")).toEqual({
      status: "picked",
      index: 0,
      rank: "normalized",
    });
  });

  test("a street, avenue or saint written short or in full matches the other", () => {
    const stations = [choice("Harbor Street Station, Example City"), choice("Pier Road Station, Example City")];
    expect(rank(stations, "Example City Harbor St Station")).toEqual({ status: "missing" });
    expect(rankForms(stations, "Example City Harbor St Station")).toEqual({ status: "picked", index: 0, rank: "allWords" });
    expect(rankForms([choice("North Example Avenue"), choice("Lakeside Drive")], "Example Ave")).toEqual({
      status: "picked",
      index: 0,
      rank: "words",
    });
    expect(rankForms([choice("St. Example"), choice("Exampletown")], "Saint Example")).toEqual({ status: "picked", index: 0, rank: "folded" });
    expect(rankForms([choice("St-Mary"), choice("Maryville")], "Saint Mary")).toEqual({ status: "picked", index: 0, rank: "folded" });
  });

  test("international, center, mount, fort and and written short or as a sign match", () => {
    expect(rankForms([choice("Harbor City Intl (HCX)"), choice("Harbor City Regional (HCR)")], "Harbor City International")).toEqual({
      status: "picked",
      index: 0,
      rank: "words",
    });
    expect(rankForms([choice("HCX, Harbor City Intl")], "Harbor City International HCX")).toEqual({
      status: "picked",
      index: 0,
      rank: "allWords",
    });
    expect(rankForms([choice("Example Ctr")], "Example Center")).toMatchObject({ status: "picked" });
    expect(rankForms([choice("Mt Example")], "Mount Example")).toMatchObject({ status: "picked" });
    expect(rankForms([choice("Fort Example")], "Ft Example")).toMatchObject({ status: "picked" });
    expect(rankForms([choice("Pages & Prints"), choice("Pages Plus")], "Pages and Prints")).toEqual({
      status: "picked",
      index: 0,
      rank: "normalized",
    });
  });

  test("a state's or district's code and name match where a place ends the value", () => {
    const cities = [choice("Exampleton, California"), choice("Exampleton, Example Country")];
    expect(rank(cities, "Exampleton CA")).toEqual({ status: "missing" });
    expect(rankForms(cities, "Exampleton CA")).toEqual({ status: "picked", index: 0, rank: "folded" });
    const springfields = [choice("Springfield, Illinois, USA"), choice("Springfield, Missouri, USA")];
    expect(rankForms(springfields, "Springfield IL")).toEqual({ status: "picked", index: 0, rank: "words" });
    expect(rankForms([choice("Central Station, Washington, D.C."), choice("Central Station, Example City")], "Central Station DC")).toEqual({
      status: "picked",
      index: 0,
      rank: "folded",
    });
    expect(rankForms([choice("Example Plaza, New York, NY")], "Example Plaza New York")).toMatchObject({ status: "picked" });
  });

  test("a spelling as given still decides at its rank, and an option's value never matches another form", () => {
    // The value as given matches one option as whole words; the code's other forms never add a tie.
    expect(rankForms([choice("Example Airport, Washington DC"), choice("Example DC Annex")], "Washington DC")).toEqual({
      status: "picked",
      index: 0,
      rank: "words",
    });
    expect(rankForms([choice("Example", "illinois")], "IL")).toEqual({ status: "missing" });
  });
});

describe("spellingsOf", () => {
  test("lists the value first, then each other written form", () => {
    expect(spellingsOf("Example 5th Ave")).toEqual(["Example 5th Ave", "example 5th avenue", "example fifth ave", "example fifth avenue"]);
    expect(spellingsOf("Main St")).toEqual(["Main St", "main street", "main saint"]);
    expect(spellingsOf("")).toEqual([]);
  });

  test("reads a state code only where a place ends the value, before a postal code or country at most", () => {
    expect(spellingsOf("Springfield IL 62701")).toContain("springfield illinois 62701");
    expect(spellingsOf("Example City ON M5V 2T6")).toContain("example city ontario m5v 2t6");
    expect(spellingsOf("Pizza in Springfield")).toEqual(["Pizza in Springfield"]);
    expect(spellingsOf("Washington DC")).toContain("washington d c");
  });

  test("lists at most 32 forms, keeping the later words' forms, where a place's code falls", () => {
    const forms = spellingsOf("1st 2nd 3rd 4th 5th 6th St");
    expect(forms).toHaveLength(32);
    // The first words keep the value's own form; every form of the last words is tried.
    expect(forms.slice(1).every((form) => form.startsWith("1st 2nd "))).toBe(true);
    expect(forms.slice(0, 6)).toEqual([
      "1st 2nd 3rd 4th 5th 6th St",
      "1st 2nd 3rd 4th 5th 6th street",
      "1st 2nd 3rd 4th 5th 6th saint",
      "1st 2nd 3rd 4th 5th sixth st",
      "1st 2nd 3rd 4th 5th sixth street",
      "1st 2nd 3rd 4th 5th sixth saint",
    ]);
    expect(spellingsOf("Example Plaza 1st 2nd 3rd 4th 5th 6th Springfield IL")).toContain(
      "example plaza 1st 2nd 3rd 4th 5th 6th springfield illinois",
    );
  });
});

describe("closestFirst", () => {
  test("puts the labels closest to the query first and keeps the given order among equals", () => {
    const labels = ["Alpha Mall", "Beta Plaza", "Gamma Center", "Example Fifth Plaza", "Delta Park"];
    expect(closestFirst(labels, "Example Fifth", rankByWords)[0]).toBe("Example Fifth Plaza");
    expect(closestFirst(labels, "", rankByWords)).toEqual(labels);
    expect(closestFirst(["B", "A"], "zzz", () => [0, 0])).toEqual(["B", "A"]);
  });
});

describe("rankChoices word stems", () => {
  const dentistry = [
    choice("Dentistry"),
    choice("Example Dentistry"),
    choice("Sample Dentistry"),
    choice("Demo Dentistry"),
    choice("Placeholder Dentistry (Test Annex)"),
  ];

  test("without the stem option, as on a write, nothing matches by stem", () => {
    expect(rank([choice("Count")], "County")).toEqual({ status: "missing" });
    expect(rank(dentistry, "Dentist")).toEqual({ status: "missing" });
    expect(rankChoices(dentistry, ["Dentist"], foldChoiceText, { stem: false })).toEqual({ status: "missing" });
    // A read that asks for stems takes it, since Count is the whole start of County.
    expect(stemRank([choice("Count")], "County")).toEqual({ status: "picked", index: 0, rank: "stem" });
  });

  test("a word picks the one option whose word it begins, or that begins it", () => {
    expect(stemRank(dentistry, "Dentist")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(stemRank([choice("Dentist"), choice("Dental")], "Dentists")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(stemRank([choice("Podiatry"), choice("Pediatrics")], "Pediatric")).toEqual({ status: "picked", index: 1, rank: "stem" });
  });

  test("every word of the name must pair, in order", () => {
    expect(stemRank(dentistry, "Sample Dentist")).toEqual({ status: "picked", index: 2, rank: "stem" });
    expect(stemRank([choice("Sports Dentistry")], "Dentist")).toEqual({ status: "missing" });
    expect(stemRank([choice("Dentistry Sample")], "Sample Dentist")).toEqual({ status: "missing" });
  });

  test("two options that pair equally tie", () => {
    expect(stemRank([choice("Dentistry"), choice("Dentists"), choice("Example Dentistry")], "Dentist")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "stem",
    });
  });

  test("a match as written, by whole name or by whole word, outranks a stem", () => {
    expect(stemRank([choice("Dentistry"), choice("Dentist")], "Dentist")).toEqual({ status: "picked", index: 1, rank: "exact" });
    expect(stemRank([choice("Dentistry"), choice("dentist")], "Dentist")).toEqual({ status: "picked", index: 1, rank: "normalized" });
    expect(stemRank([choice("Obstetrics"), choice("Obstetrician & Gynecologist")], "Obstetrician")).toEqual({
      status: "picked",
      index: 1,
      rank: "words",
    });
  });

  test("words that only share a start, or a start under five letters, never pair", () => {
    expect(stemRank([choice("Employer")], "Employee")).toEqual({ status: "missing" });
    expect(stemRank([choice("Premier")], "Premium")).toEqual({ status: "missing" });
    expect(stemRank([choice("Country")], "County")).toEqual({ status: "missing" });
    expect(stemRank([choice("Physics")], "Physical")).toEqual({ status: "missing" });
    expect(stemRank([choice("Physics")], "Physician")).toEqual({ status: "missing" });
    expect(stemRank([choice("Generic")], "General")).toEqual({ status: "missing" });
    expect(stemRank([choice("Cardiology")], "Cardiologist")).toEqual({ status: "missing" });
    expect(stemRank([choice("Christy")], "Christian")).toEqual({ status: "missing" });
    expect(stemRank([choice("Adams")], "Adam")).toEqual({ status: "missing" });
    expect(stemRank([choice("Ukraine"), choice("United Kingdom")], "UK")).toEqual({ status: "missing" });
    expect(stemRank([choice("Dental Hygienist")], "Dentist")).toEqual({ status: "missing" });
    expect(stemRank([choice("Dental")], "Dentist")).toEqual({ status: "missing" });
  });

  test("a word with a digit, or with letters outside Latin, only pairs with itself", () => {
    expect(stemRank([choice("Suite 12345")], "Suite 1234")).toEqual({ status: "missing" });
    expect(stemRank([choice("Москвичка")], "Москвич")).toEqual({ status: "missing" });
  });

  test("a stem never matches an option's value", () => {
    expect(stemRank([choice("General", "dentistry")], "Dentist")).toEqual({ status: "missing" });
  });

  test("a pick by stem decodes and reports its rank", () => {
    const pick = { picked: true, kind: "typeahead", label: "Dentistry", value: "", rank: "stem", refills: 0 };
    expect(Schema.decodeUnknownSync(PickOutcome)(pick)).toEqual(pick);
  });

  test("a disabled stem match is reported, not replaced", () => {
    expect(stemRank([choice("Dentistry", "", true)], "Dentist")).toEqual({ status: "disabled", index: 0, rank: "stem" });
  });
});

describe("pickRefusal", () => {
  test("a missing value names the field and lists what the picker offered", () => {
    const refusal = pickRefusal(
      { reason: "option_missing", wanted: "Atlantis", available: ["Chile", "China"], matches: [] },
      "country",
    );
    expect(refusal).toMatchObject({
      name: "InvalidInput",
      field: "country",
      available: ["Chile", "China"],
      kind: "option_missing",
    });
    expect(refusal.message).toContain('"Atlantis"');
  });

  test("an ambiguous value lists the options that tie as the choices", () => {
    const refusal = pickRefusal(
      { reason: "option_ambiguous", wanted: "Acme", available: ["Acme A", "Acme B", "Other"], matches: ["Acme A", "Acme B"] },
      "customer",
    );
    expect(refusal).toMatchObject({ field: "customer", available: ["Acme A", "Acme B"], kind: "option_ambiguous" });
  });
});

describe("PickOutcome", () => {
  const picked = { picked: true, kind: "select", label: "Springfield", value: "spf-il", rank: "exact", refills: 0 } as const;

  test("keeps the options that tied when tie first took the first of them", () => {
    const tied = { ...picked, tied: ["Springfield [spf-il]", "Springfield [spf-mo]"] };
    expect(Schema.decodeUnknownSync(PickOutcome)(tied)).toEqual(tied);
  });

  test("still decodes a pick with no tie and a refusal as before", () => {
    expect(Schema.decodeUnknownSync(PickOutcome)(picked)).toEqual(picked);
    const refused = { picked: false, reason: "option_ambiguous", wanted: "Springfield", available: ["Springfield", "Shelbyville"], matches: ["Springfield [spf-il]", "Springfield [spf-mo]"] };
    expect(Schema.decodeUnknownSync(PickOutcome)(refused)).toEqual(refused);
  });
});
