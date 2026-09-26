/// <reference lib="dom" />
// Markdown → DOM via marked's GFM tokenizer, walking the token tree into real
// DOM nodes. There is no `innerHTML` and no HTML passthrough: raw HTML tokens
// render as text, images never load (alt text only), and link hrefs are vetted,
// so a model — or a tool result it quotes — can format its output but can never
// inject markup, script, or a tracking beacon. GFM is on, so tables, task
// lists, strikethrough, and autolinks all render.
import { type MarkedToken, type Token, marked } from "marked";

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
/**
 * A `#pair=<code>` fragment opens this app's pairing prompt (see
 * `core/pair.ts`). Transcript text can quote anything, so such a link never
 * becomes one tap away from enrolling a stranger's machine.
 */
const PAIR_FRAGMENT = /#pair=/i;

/**
 * A vetted href (safe scheme or same-document path, never a pairing link), or
 * undefined to drop the link.
 */
function safeHref(href: string): string | undefined {
  const target = href.trim();
  if (PAIR_FRAGMENT.test(target)) return undefined;
  if (
    SAFE_SCHEME.test(target) ||
    target.startsWith("/") ||
    target.startsWith("#")
  )
    return target;
  return undefined;
}

/** Walk a marked token list into `parent`, recursing through inline children. */
function render(parent: ParentNode, tokens: readonly Token[]): void {
  for (const raw of tokens) {
    // marked.lexer emits only MarkedToken; Tokens.Generic exists purely for
    // custom extensions, and none are registered. Narrowing off it lets the
    // discriminated switch see each token's real (non-optional) child tokens.
    const token: MarkedToken = raw as MarkedToken;
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "text":
        if (token.tokens && token.tokens.length > 0)
          render(parent, token.tokens);
        else parent.append(token.text);
        break;
      case "escape":
        parent.append(token.text);
        break;
      case "paragraph": {
        const p = document.createElement("p");
        render(p, token.tokens);
        parent.append(p);
        break;
      }
      case "heading": {
        const level = Math.min(Math.max(token.depth, 1), 6);
        const h = document.createElement(`h${level}`);
        render(h, token.tokens);
        parent.append(h);
        break;
      }
      case "strong": {
        const el = document.createElement("strong");
        render(el, token.tokens);
        parent.append(el);
        break;
      }
      case "em": {
        const el = document.createElement("em");
        render(el, token.tokens);
        parent.append(el);
        break;
      }
      case "del": {
        const el = document.createElement("del");
        render(el, token.tokens);
        parent.append(el);
        break;
      }
      case "codespan": {
        const el = document.createElement("code");
        el.textContent = token.text;
        parent.append(el);
        break;
      }
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = token.text;
        pre.append(code);
        parent.append(pre);
        break;
      }
      case "br":
        parent.append(document.createElement("br"));
        break;
      case "hr":
        parent.append(document.createElement("hr"));
        break;
      case "link": {
        const href = safeHref(token.href);
        const el = document.createElement(href ? "a" : "span");
        if (href && el instanceof HTMLAnchorElement) {
          el.href = href;
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        }
        render(el, token.tokens);
        parent.append(el);
        break;
      }
      case "image":
        // Never load a remote resource (privacy); show the alt text only.
        parent.append(token.text || token.title || "");
        break;
      case "blockquote": {
        const bq = document.createElement("blockquote");
        render(bq, token.tokens);
        parent.append(bq);
        break;
      }
      case "list": {
        const list = document.createElement(token.ordered ? "ol" : "ul");
        if (
          token.ordered &&
          typeof token.start === "number" &&
          token.start !== 1
        )
          list.setAttribute("start", String(token.start));
        for (const item of token.items) {
          const li = document.createElement("li");
          if (item.task) {
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = item.checked === true;
            box.disabled = true;
            li.append(box, " ");
          }
          render(li, item.tokens);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "table": {
        // A scroll wrapper keeps a wide table from overflowing the phone.
        const wrap = document.createElement("div");
        wrap.className = "table-wrap";
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const cell of token.header) {
          const th = document.createElement("th");
          if (cell.align) th.style.textAlign = cell.align;
          render(th, cell.tokens);
          headRow.append(th);
        }
        thead.append(headRow);
        table.append(thead);
        const tbody = document.createElement("tbody");
        for (const row of token.rows) {
          const tr = document.createElement("tr");
          for (const cell of row) {
            const td = document.createElement("td");
            if (cell.align) td.style.textAlign = cell.align;
            render(td, cell.tokens);
            tr.append(td);
          }
          tbody.append(tr);
        }
        table.append(tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }
      case "html":
        // No raw HTML passthrough: render the source as text.
        parent.append(token.text);
        break;
      default:
        // Unknown/extension token: fall back to its inline children or raw source.
        if ("tokens" in token && Array.isArray(token.tokens))
          render(parent, token.tokens);
        else parent.append(token.raw);
    }
  }
}

/** Render markdown source into a fragment of real DOM nodes (GFM, no HTML passthrough). */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  render(fragment, marked.lexer(source, { gfm: true, breaks: true }));
  return fragment;
}
