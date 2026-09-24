import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderMarkdown } from "../src/ui/markdown";

// Register a DOM only for this file and tear it down after, so happy-dom's
// globals never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function render(md: string): HTMLElement {
  const host = document.createElement("div");
  host.append(renderMarkdown(md));
  return host;
}

test("a GFM table renders as a table with header and body cells", () => {
  const host = render("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  expect(host.querySelector("table")).not.toBeNull();
  expect(
    [...host.querySelectorAll("thead th")].map((c) => c.textContent),
  ).toEqual(["A", "B"]);
  const rows = [...host.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );
  expect(rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("table column alignment is carried to the cells", () => {
  const host = render("| L | R |\n| :--- | ---: |\n| a | b |");
  const th = host.querySelectorAll<HTMLElement>("thead th");
  expect(th[0]?.style.textAlign).toBe("left");
  expect(th[1]?.style.textAlign).toBe("right");
});

test("raw HTML is rendered as text, never as elements", () => {
  const host = render("<script>alert(1)</script> and <b>hi</b>");
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector("b")).toBeNull();
  expect(host.textContent).toContain("alert(1)");
});

test("a javascript: link never becomes an anchor", () => {
  const host = render("[x](javascript:alert(1))");
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toContain("x");
});

test("a safe link becomes an anchor with a hardened rel/target", () => {
  const host = render("[docs](https://example.com)");
  const a = host.querySelector("a");
  expect(a?.getAttribute("href")).toBe("https://example.com");
  expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(a?.getAttribute("target")).toBe("_blank");
  expect(a?.textContent).toBe("docs");
});

test("an image renders as alt text and never loads a resource", () => {
  const host = render("![alt text](https://evil.example/beacon.png)");
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("alt text");
});

test("inline emphasis, strong, strikethrough, and code map to their tags", () => {
  const host = render("**b** _i_ ~~s~~ `c`");
  expect(host.querySelector("strong")?.textContent).toBe("b");
  expect(host.querySelector("em")?.textContent).toBe("i");
  expect(host.querySelector("del")?.textContent).toBe("s");
  expect(host.querySelector("code")?.textContent).toBe("c");
});

test("a fenced code block keeps its literal content unparsed", () => {
  const host = render("```\n**not bold**\n<b>x</b>\n```");
  expect(host.querySelector("pre code")?.textContent).toBe(
    "**not bold**\n<b>x</b>",
  );
  expect(host.querySelector("strong")).toBeNull();
  expect(host.querySelector("b")).toBeNull();
});

test("headings and lists render to their tags", () => {
  const host = render("## Title\n\n- one\n- two");
  expect(host.querySelector("h2")?.textContent).toBe("Title");
  expect(
    [...host.querySelectorAll("ul li")].map((li) => li.textContent),
  ).toEqual(["one", "two"]);
});

test("a task list renders disabled checkboxes reflecting state", () => {
  const host = render("- [x] done\n- [ ] todo");
  const boxes = [
    ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  expect(boxes.length).toBe(2);
  expect(boxes[0]?.checked).toBe(true);
  expect(boxes[1]?.checked).toBe(false);
  expect(boxes.every((b) => b.disabled)).toBe(true);
});
