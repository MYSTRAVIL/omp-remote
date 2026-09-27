import { expect, test } from "bun:test";
import {
  TOOL_PREVIEW_MAX,
  TOOL_TITLE_MAX,
  describeToolCall,
  toolPreview,
} from "../src/tool-card";

const output = (text: string) => ({ content: [{ type: "text", text }] });

test("a card is titled by the call's intent, else its key argument on one line", () => {
  expect(
    describeToolCall("bash", { command: "git status" }, "Check the tree").title,
  ).toBe("Check the tree");
  const heredoc = describeToolCall("bash", {
    command: "cat <<'EOF'\nhello\nEOF",
  });
  expect(heredoc.title).toBe("cat <<'EOF' hello EOF");
  // The body keeps the argument's lines.
  expect(heredoc.argument).toBe("cat <<'EOF'\nhello\nEOF");
  // What the call acts on outranks where: a search names its pattern.
  expect(describeToolCall("grep", { path: "src", pattern: "TODO" }).title).toBe(
    "TODO",
  );
  const long = describeToolCall("bash", { command: "x".repeat(500) }).title;
  expect(long.length).toBe(TOOL_TITLE_MAX);
  expect(long.endsWith("\u2026")).toBe(true);
});

test("a call with no key argument is summarized by its arguments; one with none has no title", () => {
  expect(describeToolCall("ast_edit", { paths: ["src/main.ts"] }).title).toBe(
    '{"paths":["src/main.ts"]}',
  );
  expect(describeToolCall("todo", {})).toEqual({
    name: "todo",
    title: "",
    argument: "",
    file: "",
  });
});

test("an xd:// write is named and summarized by the device it runs, never as a file write", () => {
  expect(
    describeToolCall("write", {
      path: "xd://lsp",
      content: JSON.stringify({ query: "findRefs" }),
    }),
  ).toEqual({ name: "lsp", title: "findRefs", argument: "findRefs", file: "" });
  expect(describeToolCall("read", { path: "shots/a.png:img" }).file).toBe(
    "shots/a.png:img",
  );
});

test("the body shows the argument, then the head of the output once there is any", () => {
  const card = describeToolCall("bash", { command: "git status --short" });
  expect(toolPreview(card, undefined)).toBe("git status --short");
  expect(
    toolPreview(card, {
      content: [
        { type: "text", text: " M a.ts\r\n M b.ts\n" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    }),
  ).toBe("git status --short\n\n M a.ts\n M b.ts");
  // A stored result message's content array reads the same.
  expect(toolPreview(card, [{ type: "text", text: "clean" }])).toBe(
    "git status --short\n\nclean",
  );
  // A call whose start this emitter never saw shows its output alone.
  expect(toolPreview(undefined, output("done"))).toBe("done");
});

test("a huge argument and output are cut to the body's bound, the cut marked", () => {
  const card = describeToolCall("write", {
    path: "notes.md",
    content: "ignored",
  });
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const preview = toolPreview(card, output(lines));
  expect(preview.length).toBeLessThanOrEqual(TOOL_PREVIEW_MAX);
  expect(preview.startsWith("notes.md\n\nline 0\nline 1\n")).toBe(true);
  expect(preview.endsWith("\n\u2026")).toBe(true);
  expect(preview).not.toContain("line 4999");

  const wide = describeToolCall("bash", { command: "y".repeat(100_000) });
  const body = toolPreview(wide, output("z".repeat(100_000)));
  expect(body.length).toBeLessThanOrEqual(TOOL_PREVIEW_MAX);
  expect(body).toContain("y\u2026\n\nz");
});
