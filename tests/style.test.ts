import { describe, expect, test } from "bun:test";
import { botText, messages } from "../src/style";

describe("botText", () => {
  test("lowercases, trims, and removes trailing punctuation", () => {
    expect(botText(["  HELLO. ", "No filler!", "ok?"])).toBe("hello\nno filler\nok");
  });

  test("drops empty lines", () => {
    expect(botText("One.\n\nTwo")).toBe("one\ntwo");
  });
});

describe("messages", () => {
  test("test poke body uses short lower-case bursts", () => {
    expect(messages.testPokeBody()).toBe("poke\ntimer works\nvery annoying\nvery promising");
  });
});
