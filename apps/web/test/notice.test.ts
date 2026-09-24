import { describe, expect, test } from "bun:test";
import { noticeLabel, noticePreview, unwrapNotice } from "../src/core/notice";

describe("unwrapNotice", () => {
  test("strips one outer wrapper and trims its content", () => {
    expect(
      unwrapNotice(
        "<system-notice>\nBackground job bg_5 has completed.\nEXIT=0\n</system-notice>",
      ),
    ).toBe("Background job bg_5 has completed.\nEXIT=0");
    // Whitespace around the wrapper does not hide it.
    expect(unwrapNotice("  \n<system-reminder>todo</system-reminder>\n")).toBe(
      "todo",
    );
  });

  test("keeps tags inside the wrapper as text", () => {
    expect(
      unwrapNotice("<system-reminder>use <b>bold</b> care</system-reminder>"),
    ).toBe("use <b>bold</b> care");
  });

  test("leaves a mismatched pair, a partial wrapper, or inner-only tags alone", () => {
    const mismatched = "<system-notice>done</system-reminder>";
    expect(unwrapNotice(mismatched)).toBe(mismatched);
    const trailing = "<system-notice>done</system-notice> and more";
    expect(unwrapNotice(trailing)).toBe(trailing);
    const inner = "Result: <code>ok</code>";
    expect(unwrapNotice(inner)).toBe(inner);
    const uppercase = "<Notice>x</Notice>";
    expect(unwrapNotice(uppercase)).toBe(uppercase);
  });

  test("two sibling wrappers are not one outer wrapper", () => {
    const pair = "<note>a</note>\n<note>b</note>";
    expect(unwrapNotice(pair)).toBe(pair);
  });
});

describe("noticeLabel", () => {
  test("names known kinds, humanizes others, and falls back to System", () => {
    expect(noticeLabel("async-result")).toBe("Background result");
    expect(noticeLabel("mid-run-todo-nudge")).toBe("Mid-run todo nudge");
    expect(noticeLabel("context_warning")).toBe("Context warning");
    expect(noticeLabel(undefined)).toBe("System");
    expect(noticeLabel("--")).toBe("System");
  });
});

describe("noticePreview", () => {
  test("is the first non-empty line, trimmed", () => {
    expect(noticePreview("\n  \n  Job bg_5 done.  \nEXIT=0")).toBe(
      "Job bg_5 done.",
    );
    expect(noticePreview("  \n")).toBe("");
  });
});
