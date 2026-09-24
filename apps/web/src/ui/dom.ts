/// <reference lib="dom" />

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

type IconName =
  | "terminal"
  | "sessions"
  | "plus"
  | "settings"
  | "arrow"
  | "back"
  | "close"
  | "lock"
  | "machine"
  | "chevron"
  | "stop"
  | "power"
  | "notice";

const iconPaths: Record<IconName, string> = {
  terminal: "m5 6 5 6-5 6m8 0h6",
  sessions: "M4 5h16v5H4zM4 14h16v5H4z",
  plus: "M12 5v14M5 12h14",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  back: "m14 5-7 7 7 7",
  close: "m6 6 12 12M6 18 18 6",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  machine: "M3 4h18v13H3zM8 21h8m-4-4v4",
  chevron: "m9 5 7 7-7 7",
  stop: "M6 6h12v12H6z",
  power: "M12 3v8M7.1 6.2a7.5 7.5 0 1 0 9.8 0",
  notice: "m12 3 9 9-9 9-9-9zM12 11v5M12 8v.01",
};

export function icon(name: IconName): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPaths[name]);
  node.append(path);
  return node;
}

/**
 * The app mark: the Oh My Pi pi (short left leg) with signal bars for
 * "remote". Filled, unlike the stroked UI icons; matches `/icon.svg`.
 */
export function brandMark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "currentColor");
  node.setAttribute("aria-hidden", "true");
  node.classList.add("icon", "brand-glyph");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M.5.2h22v4.3h-5.4V22h-4.5V4.5H8.1V16H3.6V4.5H.5zM19.5 19.6h1V22h-1zM21 17.8h1V22h-1zM22.5 16h1v6h-1z",
  );
  node.append(path);
  return node;
}

export function button(
  label: string,
  className = "button",
  glyph?: IconName,
): HTMLButtonElement {
  const node = element("button", className);
  node.type = "button";
  if (glyph) node.append(icon(glyph));
  node.append(element("span", "button-label", label));
  return node;
}

export function brand(): HTMLElement {
  const node = element("div", "brand");
  const mark = element("span", "brand-mark");
  mark.append(brandMark());
  node.append(mark, element("span", "brand-name", "omp"));
  node.append(element("span", "brand-suffix", "/ remote"));
  return node;
}

let nextId = 0;
export function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

/** Reconcile order without detaching unchanged controls or their focus. */
export function syncChildren(
  parent: HTMLElement,
  children: readonly Node[],
): void {
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(child, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

export function field(
  label: string,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  help?: string,
): HTMLElement {
  const wrapper = element("div", "field");
  control.id = uniqueId("field");
  const caption = element("label", "field-label", label);
  caption.htmlFor = control.id;
  wrapper.append(caption, control);
  if (help) {
    const hint = element("p", "field-hint", help);
    hint.id = `${control.id}-hint`;
    control.setAttribute("aria-describedby", hint.id);
    wrapper.append(hint);
  }
  return wrapper;
}
