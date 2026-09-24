/// <reference lib="dom" />
import type { InteractionFrame, SessionMeta } from "@omp-remote/protocol";
import type { ChatPreferences } from "../core/chat-preferences";
import type {
  ComposerPreferences,
  ComposerSendMode,
} from "../core/composer-preferences";
import { decideSend } from "../core/connection-state";
import type { OverlayEntry } from "../core/history-nav";
import { noticeLabel, noticePreview, unwrapNotice } from "../core/notice";
import {
  type FollowEvent,
  type FollowState,
  type ScrollMetrics,
  initialFollowState,
  isUpwardKey,
  keepsPinned,
  nextFollow,
} from "../core/scroll-follow";
import type { SessionCatalog } from "../core/store";
import { messageTime } from "../core/time-format";
import type {
  MediaEntry,
  TranscriptEntry,
  TranscriptState,
} from "../core/transcript";
import { ConnectionStatusView } from "./connection-status";
import { confirmDialog } from "./dialogs";
import { button, element, icon, setText, syncChildren, uniqueId } from "./dom";
import { openImageViewer } from "./image-viewer";
import { InteractionQueue } from "./interactions";
import { JobsStrip } from "./jobs-strip";
import { renderMarkdown } from "./markdown";
import { type ModelPick, ModelPicker } from "./model-picker";
import { OrbView, orbStateFor } from "./orb";
import type { ControlHandlers } from "./render";

interface EntryView {
  node: HTMLElement;
  /** The label text: a message's role, a tool card's name. */
  label: HTMLElement;
  text: HTMLElement;
  raw?: string;
  status?: HTMLElement;
  detail?: HTMLElement;
  media?: HTMLElement;
  mediaKey?: string;
  /** A message's role line, holding its label and its time. */
  head?: HTMLElement;
  /** A message's host time; shown while timestamps are on. */
  time?: HTMLTimeElement;
  /** The host time drawn in `time`, once a frame carried one. */
  at?: number;
  /** A notice card's one-line preview of its body, shown while collapsed. */
  preview?: HTMLElement;
  /** A collapsible card, and which chat preference sets how it starts. */
  disclosure?: "thinking" | "tool";
  /** The reader opened or closed this card: its state is theirs from then on. */
  touched?: boolean;
}

interface ComposerAttachment {
  name: string;
  objectUrl: string;
  status: "uploading" | "ready" | "error";
  progress: number;
  resourceId?: string;
  node: HTMLElement;
  fill: HTMLElement;
}

/** Render a message's downlink images from their self-contained `data:` URLs —
 *  local only, never a network fetch, so this stays clear of the markdown
 *  img-strip. An image still on its way (or still on the host, deferred) shows
 *  a lightweight placeholder; a failed or expired one says it is unavailable. A
 *  tapped image opens the viewer with its own history entry (`onOverlay`). */
export function renderMedia(
  container: HTMLElement,
  entries: readonly MediaEntry[],
  onOverlay: ControlHandlers["onOverlay"],
): void {
  const nodes: Node[] = [];
  for (const m of entries) {
    if (m.status === "ready" && m.dataUrl) {
      const img = element("img", "media-image");
      img.src = m.dataUrl;
      img.loading = "lazy";
      img.alt = "image";
      const url = m.dataUrl;
      const mime = m.mimeType;
      const name = m.name;
      img.addEventListener("click", () =>
        openImageViewer(url, mime, name, onOverlay),
      );
      nodes.push(img);
    } else if (m.status === "error" || m.status === "expired") {
      const err = element("div", "media-error");
      setText(
        err,
        m.status === "expired"
          ? "Image no longer available on the host"
          : "[image unavailable]",
      );
      nodes.push(err);
    } else {
      const load = element("div", "media-loading");
      setText(load, "loading image…");
      nodes.push(load);
    }
  }
  container.replaceChildren(...nodes);
}

class TranscriptView {
  readonly node = element("div", "transcript");
  readonly #entries = new Map<string, EntryView>();
  readonly #empty = element("div", "transcript-empty");
  readonly #onOverlay: ControlHandlers["onOverlay"];
  /** Asks the host for a deferred image's bytes; see `onMediaFetch`. */
  readonly #onDeferred: (mediaId: string) => void;
  readonly #chat: ChatPreferences;

  constructor(
    onOverlay: ControlHandlers["onOverlay"],
    onDeferred: (mediaId: string) => void,
    chat: ChatPreferences,
  ) {
    this.#onOverlay = onOverlay;
    this.#onDeferred = onDeferred;
    this.#chat = chat;
    this.#empty.append(
      element("span", "eyebrow", "Conversation"),
      element("h2", "empty-title", "Ready when you are."),
      element(
        "p",
        "empty-copy",
        "Send a message to start working in this session. New activity will appear here.",
      ),
    );
    this.applyPreferences();
  }

  /**
   * Bring what is drawn in line with the chat preferences: text size, message
   * times, and every card the reader has not opened or closed themselves.
   */
  applyPreferences(): void {
    const size = this.#chat.textSize;
    this.node.classList.toggle("text-small", size === "small");
    this.node.classList.toggle("text-large", size === "large");
    for (const view of this.#entries.values()) {
      this.#placeTime(view);
      this.#disclose(view);
    }
  }

  /** A card opens as the chat preferences say (a tool card also for its
   *  images) until the reader toggles it; their choice is never redrawn over. */
  #disclose(view: EntryView): void {
    if (
      view.touched ||
      view.disclosure === undefined ||
      !(view.node instanceof HTMLDetailsElement)
    )
      return;
    const open =
      view.disclosure === "thinking"
        ? this.#chat.thinkingExpanded
        : this.#chat.toolOutputExpanded || Boolean(view.mediaKey);
    if (view.node.open !== open) view.node.open = open;
  }

  /** Show a message's time while timestamps are on; a role line with neither
   *  a label nor a time takes no room. */
  #placeTime(view: EntryView): void {
    if (!view.head || !view.time) return;
    const shown = this.#chat.timestamps && view.at !== undefined;
    view.time.hidden = !shown;
    view.head.hidden = !shown && view.label.textContent === "";
  }

  #createView(entry: TranscriptEntry): EntryView {
    let view: EntryView;
    let summary: HTMLElement | undefined;
    if (entry.kind === "tool") {
      const node = element("details", "tool-card");
      summary = element("summary", "tool-summary");
      const label = element("span", "tool-name");
      const detail = element("span", "tool-detail");
      const status = element("span", "tool-status");
      summary.append(icon("terminal"), label, detail, status, icon("chevron"));
      const text = element("pre", "tool-preview");
      const media = element("div", "message-media");
      node.append(summary, text, media);
      view = { node, label, text, status, detail, media, disclosure: "tool" };
    } else if (entry.role === "system") {
      // A host notice (a background result, a reminder): collapsed to its
      // label and first line; it opens only when the reader asks.
      const node = element("details", "tool-card notice-card");
      const head = element("summary", "tool-summary");
      const label = element("span", "tool-name");
      const preview = element("span", "tool-detail");
      const time = element("time", "message-time");
      time.hidden = true;
      head.append(icon("notice"), label, preview, time, icon("chevron"));
      const text = element("div", "text notice-body");
      const media = element("div", "message-media");
      node.append(head, text, media);
      view = { node, head, label, time, text, preview, media };
    } else {
      const thinking = entry.role === "thinking";
      const node = thinking
        ? element("details", "message message-thinking")
        : element("article", "message");
      const head = element(thinking ? "summary" : "div", "role");
      const label = element("span", "role-label");
      const time = element("time", "message-time");
      time.hidden = true;
      head.append(label, time);
      const text = element("div", "text");
      const media = element("div", "message-media");
      node.append(head, text, media);
      view = { node, head, label, time, text, media };
      if (thinking) {
        view.disclosure = "thinking";
        summary = head;
      }
    }
    const created = view;
    // A click on the summary (or Enter/Space on it) is the reader's own toggle.
    summary?.addEventListener("click", () => {
      created.touched = true;
    });
    this.#disclose(created);
    return created;
  }

  update(
    entries: readonly TranscriptEntry[],
    ended: boolean,
    unreachable: boolean,
  ): void {
    const nodes: HTMLElement[] = [];
    const keys = new Set<string>();
    for (const entry of entries) {
      const key =
        entry.kind === "message"
          ? `message:${entry.msgId}`
          : `tool:${entry.callId}`;
      keys.add(key);
      let view = this.#entries.get(key);
      if (!view) {
        view = this.#createView(entry);
        this.#entries.set(key, view);
      }
      if (entry.kind === "message") {
        const streaming = entry.streaming && !ended;
        if (view.preview) view.node.classList.toggle("done", !streaming);
        else {
          const knownRole =
            entry.role === "user" ||
            entry.role === "assistant" ||
            entry.role === "thinking";
          view.node.className = `message message-${knownRole ? entry.role : "other"}`;
          view.node.classList.toggle("streaming", streaming);
          view.node.classList.toggle("pending", entry.pending !== undefined);
        }
        const base =
          entry.role === "user" || entry.role === "assistant"
            ? ""
            : entry.role === "system"
              ? noticeLabel(entry.noticeKind)
              : entry.role;
        const pendingText = entry.pending
          ? entry.pending === "steer"
            ? "steering in…"
            : "queued…"
          : "";
        setText(
          view.label,
          base && pendingText
            ? `${base} · ${pendingText}`
            : pendingText || base,
        );
        // The host time never changes once known: draw it once.
        if (view.time && view.at === undefined && entry.at !== undefined) {
          view.at = entry.at;
          const at = new Date(entry.at);
          view.time.dateTime = at.toISOString();
          view.time.title = at.toLocaleString();
          setText(view.time, messageTime(entry.at, Date.now()));
        }
        this.#placeTime(view);
        if (view.raw !== entry.text) {
          view.raw = entry.text;
          if (entry.role === "user") setText(view.text, entry.text);
          else if (view.preview) {
            const body = unwrapNotice(entry.text);
            setText(view.preview, noticePreview(body));
            view.text.replaceChildren(renderMarkdown(body));
          } else view.text.replaceChildren(renderMarkdown(entry.text));
        }
        const media = entry.media ?? [];
        const mediaKey = media.map((m) => `${m.mediaId}:${m.status}`).join(",");
        if (view.media && view.mediaKey !== mediaKey) {
          view.mediaKey = mediaKey;
          renderMedia(view.media, media, this.#onOverlay);
        }
      } else {
        view.node.classList.toggle("done", entry.done);
        setText(view.label, entry.name);
        if (view.detail) setText(view.detail, entry.title);
        if (view.status) setText(view.status, entry.status);
        setText(view.text, entry.preview);
        const media = entry.media ?? [];
        const mediaKey = media.map((m) => `${m.mediaId}:${m.status}`).join(",");
        if (view.media && view.mediaKey !== mediaKey) {
          view.mediaKey = mediaKey;
          renderMedia(view.media, media, this.#onOverlay);
          // Images open their card, unless the reader chose otherwise.
          this.#disclose(view);
        }
      }
      // A drawn image whose bytes stayed on the host is offered on every draw;
      // `onMediaFetch` claims one transfer at a time (see `claimMediaFetch`).
      for (const m of entry.media ?? [])
        if (m.status === "deferred") this.#onDeferred(m.mediaId);
      nodes.push(view.node);
    }
    for (const key of this.#entries.keys()) {
      if (!keys.has(key)) this.#entries.delete(key);
    }
    if (nodes.length === 0) {
      const title = this.#empty.querySelector<HTMLElement>(".empty-title");
      const copy = this.#empty.querySelector<HTMLElement>(".empty-copy");
      if (title)
        setText(
          title,
          unreachable
            ? "Not reachable."
            : ended
              ? "This session has ended."
              : "Ready when you are.",
        );
      if (copy)
        setText(
          copy,
          unreachable
            ? "Restart this omp session to reconnect."
            : ended
              ? "No transcript was received in this browser."
              : "Send a message to start working in this session. New activity will appear here.",
        );
      nodes.push(this.#empty);
    }
    syncChildren(this.node, nodes);
  }
}

const ENDED_NOTICE =
  "This session has ended. Start a new session to continue; your draft stays here until you close this tab.";
const UNREACHABLE_NOTICE =
  "Not reachable. Restart this omp session to reconnect; your draft stays here until you close this tab.";

class Composer {
  readonly node = element("form", "composer");
  readonly input = element("textarea", "composer-input");
  readonly #status = element("p", "composer-error");
  readonly #send = button("Queue", "button primary send");
  readonly #menu = element("div", "composer-menu");
  readonly #alternate = button("Steer", "button composer-alternate");
  readonly #interrupt = button("Interrupt", "button interrupt", "stop");
  readonly #aside = button("Aside", "button composer-aside");
  readonly #ended = element("p", "composer-ended", ENDED_NOTICE);
  readonly #pendingNotice = element(
    "p",
    "composer-pending-notice",
    "Answer the question above to keep typing.",
  );
  /** Why the draft cannot go now; empty (and so hidden) while it can. */
  readonly #offlineNotice = element("p", "composer-offline-notice");
  readonly #attachButton = button("+", "button attach-button");
  readonly #fileInput = element("input", "attach-input");
  readonly #attachmentList = element("div", "composer-attachments");
  readonly #attachments = new Map<string, ComposerAttachment>();
  #attachSeq = 0;
  readonly #modelChip = button("", "button model-chip");
  readonly #drawer = element("dialog", "model-drawer");
  readonly #compactButton = button("Compact context", "button drawer-compact");
  readonly #contextReadout = element("p", "context-readout");
  readonly #chipName = element("span", "model-chip-name");
  readonly #chipContext = element("span", "model-chip-context");
  readonly #fastMode = button("⚡ fast", "session-fast-mode");
  #fastModeEnabled: boolean | undefined;
  readonly #drawerClose = button(
    "Close",
    "button icon-button drawer-close",
    "close",
  );
  /** The drawer's lists: Roles / Models / Effort under a root, with Back. */
  readonly #picker = new ModelPicker({
    heading: "h2",
    rootTitle: "Model and effort",
    effort: true,
    headerEnd: [this.#drawerClose],
    rootEnd: [this.#compactButton, this.#contextReadout],
    onPick: (pick) => this.#applyPick(pick),
  });
  readonly #preferences: ComposerPreferences;
  readonly #resizeObserver: ResizeObserver;
  readonly #nativePopover: boolean;
  handlers: ControlHandlers;
  #revision = 0;
  #sending: "steer" | "followUp" | "aside" | undefined;
  #interrupting = false;
  #isEnded = false;
  #active = false;
  #visible = false;
  #menuOpen = false;
  #drawerOpen = false;
  #modelChipLabel = "";
  #modelChipProvider = "";
  #layoutFrame = 0;
  #inputWidth = 0;
  #layoutEvents: AbortController | undefined;
  #menuEvents: AbortController | undefined;
  #menuEntry: OverlayEntry | undefined;
  #drawerEvents: AbortController | undefined;
  #drawerEntry: OverlayEntry | undefined;
  #longPressTimer = 0;
  #longPressOpened = false;
  #pendingBlocked = false;
  /** Why a draft cannot be sent now (its machine is offline); undefined while it can. */
  #refusal: string | undefined;

  constructor(
    sessionId: string,
    handlers: ControlHandlers,
    preferences: ComposerPreferences,
  ) {
    this.handlers = handlers;
    this.#preferences = preferences;
    this.node.setAttribute("aria-label", "Message composer");
    this.input.dataset.sessionId = sessionId;
    this.input.rows = 1;
    this.input.placeholder = "Message OMP…";
    this.input.setAttribute("aria-label", "Message OMP");
    this.input.setAttribute("aria-keyshortcuts", "Control+Enter");
    this.input.autocomplete = "off";
    this.#status.setAttribute("role", "status");
    this.#offlineNotice.setAttribute("role", "status");
    this.#ended.hidden = true;
    this.#menu.id = uniqueId("composer-menu");
    this.#menu.setAttribute("role", "group");
    this.#menu.setAttribute("aria-label", "Message actions");
    this.#menu.tabIndex = -1;
    this.#menu.hidden = true;
    this.#nativePopover = typeof this.#menu.showPopover === "function";
    if (this.#nativePopover) {
      this.#menu.setAttribute("popover", "auto");
      this.#menu.addEventListener("toggle", () => {
        if (this.#menuOpen && !this.#menu.matches(":popover-open"))
          this.#closeMenu(false);
      });
    }
    this.#send.setAttribute("aria-haspopup", "menu");
    this.#send.setAttribute("aria-controls", this.#menu.id);
    this.#send.setAttribute("aria-expanded", "false");
    this.#interrupt.title = "Stop the current turn without sending your draft.";
    this.#aside.title =
      "Send at the next step boundary without interrupting the current tool batch.";
    this.#menu.append(this.#alternate, this.#aside, this.#interrupt);

    // Drawer: the shared picker's root list (Roles / Models / Effort) and Back.
    this.#drawerClose.type = "button";
    this.#drawerClose.setAttribute("aria-label", "Close model selection");
    this.#drawerClose.addEventListener("click", () => this.#closeDrawer());
    this.#compactButton.type = "button";
    this.#compactButton.addEventListener("click", () => {
      const sessionId = this.input.dataset.sessionId;
      if (!sessionId) return;
      this.#closeDrawer();
      void this.handlers.onCompact(sessionId);
    });
    this.#drawer.append(this.#picker.node);
    this.#drawer.setAttribute("aria-labelledby", this.#picker.title.id);
    this.#drawer.addEventListener("click", (event) => {
      if (event.target === this.#drawer) this.#closeDrawer();
    });
    // A native close (the Android back gesture's cancel) skips #closeDrawer;
    // sync up unless the drawer reopened before this queued event ran.
    this.#drawer.addEventListener("close", () => {
      if (!this.#drawer.open) this.#closeDrawer();
    });

    // Model chip
    this.#modelChip.addEventListener("click", () => this.#openModelChip());
    this.#modelChip.replaceChildren(this.#chipName, this.#chipContext);
    this.#attachButton.type = "button";
    this.#attachButton.setAttribute("aria-label", "Attach image");
    this.#attachButton.title = "Attach an image";
    this.#fileInput.type = "file";
    this.#fileInput.accept = "image/*";
    this.#fileInput.multiple = true;
    this.#fileInput.hidden = true;
    // Shown only while it holds an attachment; the composer's flex gap keeps
    // the input-to-controls spacing the same either way.
    this.#attachmentList.hidden = true;
    this.#attachButton.addEventListener("click", () => this.#fileInput.click());
    this.#fileInput.addEventListener("change", () => {
      const files = this.#fileInput.files;
      if (files)
        for (const file of Array.from(files)) void this.#addAttachment(file);
      this.#fileInput.value = "";
    });
    this.#fastMode.type = "button";
    this.#fastMode.addEventListener("click", () => {
      const sid = this.input.dataset.sessionId;
      if (!sid || this.#fastModeEnabled === undefined) return;
      void this.handlers.onServiceTier(sid, !this.#fastModeEnabled);
    });

    // Layout: textarea on top, control row below
    const controlRow = element("div", "composer-row");
    const meta = element("div", "composer-meta");
    meta.append(this.#modelChip, this.#fastMode);
    controlRow.append(this.#attachButton, meta, this.#send);
    this.node.append(
      this.#offlineNotice,
      this.input,
      this.#attachmentList,
      this.#fileInput,
      controlRow,
      this.#ended,
      this.#pendingNotice,
      this.#status,
      this.#menu,
      this.#drawer,
    );
    this.node.addEventListener("submit", (event) => event.preventDefault());
    this.input.addEventListener("input", () => {
      this.#revision += 1;
      this.#updateButtons();
      this.#requestLayout();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey && !event.isComposing) {
        event.preventDefault();
        void this.#submit(this.#preferences.mode);
      }
    });
    this.#send.addEventListener("click", () => {
      if (this.#longPressOpened) {
        this.#longPressOpened = false;
        return;
      }
      void this.#submit(this.#preferences.mode);
    });
    this.#send.addEventListener("pointerdown", () => this.#armLongPress());
    this.#send.addEventListener("pointerup", () => this.#cancelLongPress());
    this.#send.addEventListener("pointerleave", () => this.#cancelLongPress());
    this.#send.addEventListener("pointercancel", () => this.#cancelLongPress());
    this.#send.addEventListener("contextmenu", (event) =>
      event.preventDefault(),
    );
    this.#send.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      this.#openMenu(event.key === "ArrowUp");
    });
    this.#alternate.addEventListener("click", () => {
      const mode = this.#preferences.mode === "followUp" ? "steer" : "followUp";
      this.#closeMenu(true);
      void this.#submit(mode);
    });
    this.#aside.addEventListener("click", () => {
      this.#closeMenu(true);
      void this.#submit("aside");
    });
    this.#interrupt.addEventListener("click", () => {
      this.#closeMenu(true);
      void this.#stop();
    });
    this.#menu.addEventListener("keydown", (event) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      )
        return;
      event.preventDefault();
      const actions = [this.#alternate, this.#aside, this.#interrupt].filter(
        (action) => !action.disabled,
      );
      if (actions.length === 0) return;
      const current = actions.findIndex(
        (action) => action === document.activeElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? actions.length - 1
            : (current +
                (event.key === "ArrowDown" ? 1 : -1) +
                actions.length) %
              actions.length;
      actions[next]?.focus({ preventScroll: true });
    });
    this.#resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width =
        entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      if (width <= 0 || width === this.#inputWidth) return;
      this.#inputWidth = width;
      this.#requestLayout();
    });
    void document.fonts.ready.then(() => this.#requestLayout());
    this.#updateButtons();
  }

  /**
   * `refusal` says why a draft cannot be sent now (the session's machine is
   * offline); the draft then stays put until it can.
   */
  update(
    handlers: ControlHandlers,
    ended: boolean,
    unreachable: boolean,
    active: boolean,
    pending: readonly InteractionFrame[],
    refusal: string | undefined,
  ): void {
    this.handlers = handlers;
    // An unreachable session cannot take input either; it reuses the ended lock.
    const locked = ended || unreachable;
    this.#isEnded = locked;
    this.#active = active;
    this.#pendingBlocked = pending.length > 0;
    // A locked session says so on its own; reconnecting would not change that.
    this.#refusal = locked ? undefined : refusal;
    this.input.disabled = locked || this.#pendingBlocked;
    setText(this.#ended, unreachable ? UNREACHABLE_NOTICE : ENDED_NOTICE);
    this.#ended.hidden = !locked;
    setText(this.#offlineNotice, this.#refusal ?? "");
    this.node.classList.toggle("pending-blocked", this.#pendingBlocked);
    this.#pendingNotice.hidden = !this.#pendingBlocked;
    if (this.#pendingBlocked && this.#menuOpen) this.#closeMenu(false);
    if ((locked || !active || this.#refusal !== undefined) && this.#menuOpen)
      this.#closeMenu(false);
    this.#updateButtons();
  }

  setCatalog(catalog: SessionCatalog): void {
    this.#picker.setCatalog(catalog);
  }

  setModelChip(label: string, provider: string): void {
    if (this.#modelChipLabel === label && this.#modelChipProvider === provider)
      return;
    this.#modelChipLabel = label;
    this.#modelChipProvider = provider;
    setText(this.#chipName, label);
    this.#modelChip.title = provider ? `${label} · ${provider}` : label;
    this.#modelChip.setAttribute(
      "aria-label",
      `Change model. Currently: ${label}.`,
    );
  }

  /** A drawer pick applies to this session and closes the drawer. */
  #applyPick(pick: ModelPick): void {
    const sessionId = this.input.dataset.sessionId ?? "";
    this.#closeDrawer();
    switch (pick.kind) {
      case "role":
        void this.handlers.onSetModel(sessionId, pick.role.modelId);
        if (pick.role.effort)
          void this.handlers.onSetThinkingLevel(sessionId, pick.role.effort);
        break;
      case "model":
        void this.handlers.onSetModel(sessionId, pick.model.id);
        break;
      case "effort":
        void this.handlers.onSetThinkingLevel(sessionId, pick.level);
        break;
      case "default":
        // Not offered here: a running session has no host default to return to.
        break;
    }
  }

  updateContextReadout(
    pct: number | undefined,
    tokens: number | undefined,
    windowSize: number | undefined,
  ): void {
    if (pct === undefined) {
      this.#contextReadout.hidden = true;
      this.#chipContext.hidden = true;
      return;
    }
    this.#contextReadout.hidden = false;
    this.#chipContext.hidden = false;
    setText(this.#chipContext, `${Math.round(pct)}%`);
    this.#chipContext.title = `${Math.round(pct)}% of the context window used`;
    if (tokens !== undefined && windowSize !== undefined) {
      this.#contextReadout.textContent = `${Math.round(pct)}% · ${this.#formatTokens(tokens)}/${this.#formatTokens(windowSize)}`;
    } else {
      this.#contextReadout.textContent = `${Math.round(pct)}% context`;
    }
  }

  setFastMode(enabled: boolean | undefined): void {
    this.#fastModeEnabled = enabled;
    this.#fastMode.hidden = enabled === undefined;
    this.#fastMode.classList.toggle("active", enabled === true);
    this.#fastMode.setAttribute(
      "aria-pressed",
      enabled === true ? "true" : "false",
    );
    this.#fastMode.title =
      enabled === true
        ? "Fast mode is on. Tap to turn it off."
        : "Fast mode is off. Tap to turn it on.";
  }

  /** Typed text or an attachment a reload would lose. */
  hasDraft(): boolean {
    return this.input.value.trim().length > 0 || this.#attachments.size > 0;
  }

  #formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return `${n}`;
  }

  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (!visible) {
      this.#closeMenu(false);
      this.#closeDrawer();
      this.#cancelLongPress();
      this.#resizeObserver.disconnect();
      this.#layoutEvents?.abort();
      this.#layoutEvents = undefined;
      cancelAnimationFrame(this.#layoutFrame);
      this.#layoutFrame = 0;
      return;
    }
    this.#inputWidth = 0;
    this.#resizeObserver.observe(this.input, { box: "border-box" });
    this.#layoutEvents = new AbortController();
    const options = { signal: this.#layoutEvents.signal };
    window.addEventListener("resize", this.#requestLayout, options);
    window.visualViewport?.addEventListener(
      "resize",
      this.#requestLayout,
      options,
    );
    window.visualViewport?.addEventListener(
      "scroll",
      this.#requestLayout,
      options,
    );
    // A bfcache restore or a return to the foreground can bring a viewport
    // that changed while the page was away: measure again.
    window.addEventListener("pageshow", this.#requestLayout, options);
    document.addEventListener("visibilitychange", this.#requestLayout, options);
    this.#requestLayout();
  }

  dispose(): void {
    this.setVisible(false);
    this.#resizeObserver.disconnect();
  }

  readonly #requestLayout = (): void => {
    if (!this.#visible || this.#layoutFrame !== 0) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = 0;
      const scrollTop = this.input.scrollTop;
      const style = getComputedStyle(this.input);
      const borders =
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);
      this.input.style.overflowY = "hidden";
      this.input.style.height = "auto";
      this.input.style.height = `${this.input.scrollHeight + borders}px`;
      this.input.style.overflowY = "auto";
      this.input.scrollTop = scrollTop;
      if (this.#menuOpen) this.#positionMenu();
    });
  };

  #openMenu(last = false): void {
    if (
      this.#isEnded ||
      this.#menuOpen ||
      !this.#active ||
      this.#pendingBlocked
    )
      return;
    this.#menuOpen = true;
    this.#menu.hidden = false;
    if (this.#nativePopover) this.#menu.showPopover();
    this.#send.setAttribute("aria-expanded", "true");
    this.#positionMenu();
    const actions = [this.#alternate, this.#aside, this.#interrupt].filter(
      (action) => !action.disabled,
    );
    (last ? actions.at(-1) : actions[0])?.focus({ preventScroll: true });
    if (actions.length === 0) this.#menu.focus({ preventScroll: true });
    this.#menuEvents = new AbortController();
    const options = { signal: this.#menuEvents.signal };
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          event.target instanceof Node &&
          !this.#menu.contains(event.target) &&
          !this.#send.contains(event.target)
        )
          this.#closeMenu(false);
      },
      options,
    );
    document.addEventListener(
      "focusin",
      (event) => {
        if (
          event.target instanceof Node &&
          !this.#menu.contains(event.target) &&
          !this.#send.contains(event.target)
        )
          this.#closeMenu(false);
      },
      options,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        this.#closeMenu(true);
      },
      options,
    );
    this.#menuEntry = this.handlers.onOverlay(() => this.#closeMenu(false));
  }

  #closeMenu(restoreFocus: boolean): void {
    if (!this.#menuOpen) return;
    this.#menuOpen = false;
    this.#longPressOpened = false;
    this.#menuEvents?.abort();
    this.#menuEvents = undefined;
    this.#menuEntry?.dismiss();
    this.#menuEntry = undefined;
    if (this.#nativePopover && this.#menu.matches(":popover-open"))
      this.#menu.hidePopover();
    this.#menu.hidden = true;
    this.#send.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.#send.focus({ preventScroll: true });
  }

  #positionMenu(): void {
    const anchor = this.#send.getBoundingClientRect();
    const menu = this.#menu.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8;
    const top = (viewport?.offsetTop ?? 0) + 8;
    const right = left + (viewport?.width ?? window.innerWidth) - 16;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
    const above = anchor.top - menu.height - 8;
    this.#menu.style.left = `${Math.max(left, Math.min(anchor.left, right - menu.width))}px`;
    this.#menu.style.top = `${Math.max(top, Math.min(above >= top ? above : anchor.bottom + 8, bottom - menu.height))}px`;
  }

  #openModelChip(): void {
    if (this.#isEnded) return;
    this.#picker.reset();
    this.#openDrawer();
  }

  #openDrawer(): void {
    this.#drawerOpen = true;
    this.#drawer.showModal();
    this.#drawerEvents = new AbortController();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        this.#closeDrawer();
      },
      { signal: this.#drawerEvents.signal },
    );
    this.#drawerEntry = this.handlers.onOverlay(() => this.#closeDrawer());
  }

  #closeDrawer(): void {
    if (!this.#drawerOpen) return;
    this.#drawerOpen = false;
    this.#drawerEvents?.abort();
    this.#drawerEvents = undefined;
    this.#drawer.close();
    this.#drawerEntry?.dismiss();
    this.#drawerEntry = undefined;
  }

  #armLongPress(): void {
    if (this.#isEnded || !this.#active || this.#pendingBlocked) return;
    this.#longPressOpened = false;
    window.clearTimeout(this.#longPressTimer);
    this.#longPressTimer = window.setTimeout(() => {
      this.#longPressTimer = 0;
      this.#longPressOpened = true;
      this.#openMenu();
    }, 450);
  }

  #cancelLongPress(): void {
    if (this.#longPressTimer !== 0) {
      window.clearTimeout(this.#longPressTimer);
      this.#longPressTimer = 0;
    }
  }

  #updateButtons(): void {
    const mode = this.#preferences.mode;
    const alternate = mode === "followUp" ? "steer" : "followUp";
    const busy = this.#sending !== undefined || this.#interrupting;
    const hasText = this.input.value.trim().length > 0;
    const hasReady = this.#hasReadyAttachment();
    const refused = this.#refusal !== undefined;
    const blocked = this.#isEnded || busy || this.#pendingBlocked || refused;
    this.#send.disabled = blocked || (!hasText && !hasReady && !this.#active);
    this.#alternate.disabled = blocked || (!hasText && !hasReady);
    this.#aside.disabled = blocked || (!hasText && !hasReady);
    this.#attachButton.disabled =
      this.#isEnded || this.#pendingBlocked || refused;
    this.#interrupt.disabled =
      this.#isEnded || busy || !this.#active || this.#pendingBlocked || refused;
    this.#send.dataset.sendMode = this.#active ? mode : "send";
    this.#alternate.dataset.sendMode = alternate;
    this.#send.setAttribute("aria-busy", String(this.#sending !== undefined));
    this.#interrupt.setAttribute("aria-busy", String(this.#interrupting));
    this.#send.title =
      this.#refusal ??
      (this.#pendingBlocked
        ? "Answer the pending question before sending."
        : !this.#active
          ? "Send your message."
          : mode === "followUp"
            ? "Queue after the active turn. Hold for Steer, Aside, or Interrupt."
            : "Redirect the active turn. Hold for Queue, Aside, or Interrupt.");
    this.#alternate.title =
      alternate === "followUp"
        ? "Start now if idle, or queue after the active turn."
        : "Redirect the active turn, or start now if idle.";
    const sendLabel = this.#send.querySelector<HTMLElement>(".button-label");
    const alternateLabel =
      this.#alternate.querySelector<HTMLElement>(".button-label");
    const asideLabel = this.#aside.querySelector<HTMLElement>(".button-label");
    const stopLabel =
      this.#interrupt.querySelector<HTMLElement>(".button-label");
    if (sendLabel)
      setText(
        sendLabel,
        this.#sending !== undefined
          ? "Sending…"
          : this.#pendingBlocked
            ? "Blocked"
            : !this.#active
              ? "Send"
              : mode === "followUp"
                ? "Queue"
                : "Steer",
      );
    if (alternateLabel)
      setText(alternateLabel, alternate === "followUp" ? "Queue" : "Steer");
    if (asideLabel) setText(asideLabel, "Aside");
    if (stopLabel)
      setText(stopLabel, this.#interrupting ? "Stopping…" : "Interrupt");
  }

  async #submit(mode: "steer" | "followUp" | "aside"): Promise<void> {
    if (
      this.#isEnded ||
      this.#sending !== undefined ||
      this.#interrupting ||
      this.#pendingBlocked ||
      this.#refusal !== undefined
    )
      return;
    const rawDraft = this.input.value;
    const text = rawDraft.trim();
    const uploading = [...this.#attachments.values()].some(
      (a) => a.status === "uploading",
    );
    if (uploading) {
      this.#status.textContent = "Waiting for the image upload to finish…";
      return;
    }
    const attachments: string[] = [];
    for (const attachment of this.#attachments.values())
      if (attachment.status === "ready" && attachment.resourceId)
        attachments.push(attachment.resourceId);
    if (!text && attachments.length === 0) return;
    const revision = this.#revision;
    this.#sending = mode;
    this.#status.textContent = "Sending… A passkey check may be needed.";
    this.#updateButtons();
    try {
      const sent = await this.handlers.onPrompt(
        text,
        mode,
        attachments.length > 0 ? attachments : undefined,
      );
      if (sent) {
        if (revision === this.#revision && this.input.value === rawDraft) {
          this.input.value = "";
          this.#revision += 1;
          this.#requestLayout();
        }
        this.#clearAttachments();
        this.#status.textContent = "";
      } else {
        this.#status.textContent =
          "Not sent. Your draft is still here. Confirm your passkey and check the connection before trying again.";
      }
    } catch {
      this.#status.textContent =
        "Could not send. Your draft is still here; try again.";
    } finally {
      this.#sending = undefined;
      this.#updateButtons();
    }
  }

  async #addAttachment(file: File): Promise<void> {
    if (!file.type.startsWith("image/")) return;
    const id = `att-${++this.#attachSeq}`;
    const objectUrl = URL.createObjectURL(file);
    const node = element("div", "attachment");
    const thumb = element("img", "attachment-thumb") as HTMLImageElement;
    thumb.src = objectUrl;
    thumb.alt = file.name;
    const bar = element("div", "attachment-bar");
    const fill = element("div", "attachment-fill");
    bar.append(fill);
    const remove = button("×", "button attachment-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => this.#removeAttachment(id));
    node.append(thumb, bar, remove);
    const attachment: ComposerAttachment = {
      name: file.name,
      objectUrl,
      status: "uploading",
      progress: 0,
      node,
      fill,
    };
    this.#attachments.set(id, attachment);
    this.#attachmentList.append(node);
    this.#attachmentList.hidden = false;
    this.#updateButtons();
    const sessionId = this.input.dataset.sessionId;
    if (!sessionId) return;
    try {
      const resourceId = await this.handlers.onUpload(
        sessionId,
        file,
        (fraction) => {
          fill.style.width = `${Math.round(fraction * 100)}%`;
        },
      );
      if (!this.#attachments.has(id)) return;
      attachment.status = "ready";
      attachment.resourceId = resourceId;
      node.classList.add("ready");
      fill.style.width = "100%";
    } catch {
      if (!this.#attachments.has(id)) return;
      attachment.status = "error";
      node.classList.add("error");
    }
    this.#updateButtons();
  }

  #removeAttachment(id: string): void {
    const attachment = this.#attachments.get(id);
    if (!attachment) return;
    URL.revokeObjectURL(attachment.objectUrl);
    attachment.node.remove();
    this.#attachments.delete(id);
    this.#attachmentList.hidden = this.#attachments.size === 0;
    this.#updateButtons();
  }

  #clearAttachments(): void {
    for (const attachment of this.#attachments.values()) {
      URL.revokeObjectURL(attachment.objectUrl);
      attachment.node.remove();
    }
    this.#attachments.clear();
    this.#attachmentList.hidden = true;
  }

  #hasReadyAttachment(): boolean {
    for (const attachment of this.#attachments.values())
      if (attachment.status === "ready") return true;
    return false;
  }

  async #stop(): Promise<void> {
    if (this.#isEnded || this.#interrupting || this.#sending !== undefined)
      return;
    this.#interrupting = true;
    this.#status.textContent =
      "Sending interrupt… A passkey check may be needed.";
    this.#updateButtons();
    try {
      const sent = await this.handlers.onInterrupt();
      this.#status.textContent = sent
        ? "Interrupt sent. Waiting for the session to report its state."
        : "Interrupt not sent. Confirm your passkey and check the connection.";
    } catch {
      this.#status.textContent =
        "Could not interrupt. Check the connection and try again.";
    } finally {
      this.#interrupting = false;
      this.#updateButtons();
    }
  }
}

export class SessionView {
  readonly node = element("section", "session-view");
  readonly #title = element("h1", "session-title");
  readonly #project = element("p", "session-location");
  #handlers: ControlHandlers;
  readonly #feed = element("div", "feed");
  readonly #transcript: TranscriptView;
  readonly #queue = new InteractionQueue();
  readonly #attention = button("Needs input", "button attention-button");
  readonly #jump = button("Jump to latest", "button jump-latest");
  readonly #endSession = button(
    "End session",
    "button quiet icon-button session-end",
    "power",
  );
  readonly #endConfirm = confirmDialog({
    title: "End session",
    subtitle: "Session",
    action: "End session",
    onConfirm: () => {
      void this.#handlers.onCloseSession(this.node.dataset.sessionId ?? "");
    },
    onOverlay: (close) => this.#handlers.onOverlay(close),
  });
  /** Async jobs and running `task` calls, between the feed and the composer. */
  readonly #jobs = new JobsStrip();
  /** A turn is running: ending the session now stops it. */
  #streaming = false;
  /** The relay link, for a phone that hides the rail while a session is open. */
  readonly #connectionStatus = new ConnectionStatusView(() =>
    this.#handlers.onRetryConnection?.(),
  );
  readonly #wallpaper = new OrbView({
    size: 64,
    className: "session-wallpaper-orb",
  });
  readonly #titleInner = element("span", "session-title-inner");
  readonly #projectInner = element("span", "session-location-inner");
  readonly #reduceMotion =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  readonly #composer: Composer;
  readonly #resize: ResizeObserver;
  readonly #chat: ChatPreferences;
  readonly #unsubscribeChat: () => void;
  #follow: FollowState;
  #touchY: number | null = null;

  constructor(
    session: SessionMeta,
    handlers: ControlHandlers,
    preferences: ComposerPreferences,
    chat: ChatPreferences,
  ) {
    this.#handlers = handlers;
    this.#chat = chat;
    this.#transcript = new TranscriptView(
      (close) => this.#handlers.onOverlay(close),
      (mediaId) => this.#handlers.onMediaFetch?.(session.id, mediaId),
      chat,
    );
    this.#follow = nextFollow(initialFollowState, {
      kind: "autoScroll",
      on: chat.autoScroll,
    });
    // Settings changes reach an open session at once, without a redraw.
    this.#unsubscribeChat = chat.subscribe(() => {
      this.#apply({ kind: "autoScroll", on: this.#chat.autoScroll });
      this.#transcript.applyPreferences();
      this.#settle();
    });
    this.node.dataset.sessionId = session.id;
    this.node.hidden = true;
    const header = element("header", "session-header");
    const back = button("Sessions", "button quiet back", "back");
    back.addEventListener("click", () => this.#composer.handlers.onBack());
    const heading = element("div", "session-heading");
    this.#title.id = uniqueId("session-title");
    this.#title.tabIndex = -1;
    this.node.setAttribute("aria-labelledby", this.#title.id);
    this.#title.append(this.#titleInner);
    this.#project.append(this.#projectInner);
    heading.append(this.#project, this.#title);
    this.#endSession.title = "End this session";
    this.#endSession.addEventListener("click", () =>
      this.#endConfirm.ask(
        this.#streaming
          ? "A turn is running; ending the session stops it. omp exits on its machine, and this conversation takes no more messages."
          : "omp exits on its machine, and this conversation takes no more messages.",
      ),
    );
    header.append(
      back,
      heading,
      this.#attention,
      this.#endSession,
      this.#connectionStatus.node,
    );
    this.#attention.addEventListener("click", () => this.#queue.focusFirst());
    this.#feed.tabIndex = 0;
    this.#feed.setAttribute("role", "region");
    this.#feed.setAttribute("aria-label", "Conversation and pending requests");
    const column = element("div", "conversation-column");
    column.append(this.#transcript.node, this.#queue.node);
    this.#feed.append(column);
    this.#feed.addEventListener("scroll", () => {
      if (!this.node.hidden)
        this.#apply({ kind: "scroll", metrics: this.#metrics() });
    });
    this.#feed.addEventListener(
      "wheel",
      (event) => {
        // Ctrl+wheel is a pinch-zoom; a nested scroller consumes its own wheel.
        if (event.ctrlKey) return;
        this.#apply({ kind: "interact" });
        if (event.deltaY < 0 && !this.#nestedScrollsUp(event.target))
          this.#apply({ kind: "intentUp", metrics: this.#metrics() });
      },
      { passive: true },
    );
    this.#feed.addEventListener(
      "touchstart",
      (event) => {
        this.#apply({ kind: "interact" });
        this.#touchY = event.touches[0]?.clientY ?? null;
      },
      { passive: true },
    );
    this.#feed.addEventListener(
      "touchmove",
      (event) => {
        const y = event.touches[0]?.clientY;
        if (y === undefined) return;
        // A finger moving down drags the content down: the reader goes up.
        if (
          this.#touchY !== null &&
          y > this.#touchY &&
          !this.#nestedScrollsUp(event.target)
        )
          this.#apply({ kind: "intentUp", metrics: this.#metrics() });
        this.#touchY = y;
      },
      { passive: true },
    );
    const endTouch = () => {
      this.#touchY = null;
    };
    this.#feed.addEventListener("touchend", endTouch);
    this.#feed.addEventListener("touchcancel", endTouch);
    this.#feed.addEventListener("keydown", (event) => {
      // These keys scroll the feed only when the feed itself has focus; in a
      // question's textarea or radio group they edit or choose instead.
      if (event.target === this.#feed && isUpwardKey(event.key, event.shiftKey))
        this.#apply({ kind: "intentUp", metrics: this.#metrics() });
    });
    this.#jump.addEventListener("click", () => {
      this.#apply({ kind: "jump" });
      this.#scrollTo(this.#feed.scrollHeight);
    });
    this.#jump.hidden = true;
    // Size changes between redraws (images decoding, a resized viewport, the
    // keyboard opening) go through `#settle`, which keeps a following reader
    // at the bottom.
    this.#resize = new ResizeObserver(() => this.#settle());
    this.#resize.observe(this.#feed);
    this.#resize.observe(column);
    this.#composer = new Composer(session.id, handlers, preferences);
    const bottom = element("div", "session-bottom");
    bottom.append(this.#jump, this.#jobs.node, this.#composer.node);
    const wallpaper = element("div", "session-wallpaper");
    wallpaper.setAttribute("aria-hidden", "true");
    wallpaper.append(this.#wallpaper.node);
    this.node.append(
      wallpaper,
      header,
      this.#feed,
      bottom,
      this.#endConfirm.node,
    );
  }

  hide(): void {
    this.node.hidden = true;
    this.#composer.setVisible(false);
    this.#jobs.stop();
    this.#endConfirm.close();
  }

  /** Unsent input a reload would lose: the composer's draft or an answer
   *  typed into a pending question. */
  hasDraft(): boolean {
    return this.#composer.hasDraft() || this.#queue.hasDraft();
  }

  /** A scroller inside the feed (tool preview, text box) that can still move
   *  up takes the gesture itself; the feed does not move. */
  #nestedScrollsUp(target: EventTarget | null): boolean {
    for (
      let node = target instanceof Element ? target : null;
      node && node !== this.#feed;
      node = node.parentElement
    )
      if (node.scrollTop > 0) return true;
    return false;
  }

  #metrics(): ScrollMetrics {
    return {
      scrollTop: this.#feed.scrollTop,
      scrollHeight: this.#feed.scrollHeight,
      clientHeight: this.#feed.clientHeight,
    };
  }

  #apply(event: FollowEvent): void {
    this.#follow = nextFollow(this.#follow, event);
    const { following, unseen } = this.#follow;
    if (this.#jump.hidden !== following) this.#jump.hidden = following;
    if (this.#jump.classList.contains("has-new") !== unseen) {
      this.#jump.classList.toggle("has-new", unseen);
      this.#jump.setAttribute(
        "aria-label",
        unseen ? "Jump to latest, new messages" : "Jump to latest",
      );
    }
  }

  /** Write scrollTop and tell the follow state it was us, not the reader. */
  #scrollTo(top: number): void {
    this.#feed.scrollTop = top;
    this.#apply({ kind: "programmatic", metrics: this.#metrics() });
  }

  /** After content or size changed: keep a landing or following reader at
   *  the bottom (see `keepsPinned`); otherwise note that new content arrived
   *  below. */
  #settle(): void {
    if (this.node.hidden) return;
    if (keepsPinned(this.#follow, this.#metrics()))
      this.#scrollTo(this.#feed.scrollHeight);
    this.#apply({ kind: "content", metrics: this.#metrics() });
  }

  /** Ping-pong the header text when it overflows; ellipsis (and no motion)
   *  otherwise. Idempotent so a live redraw never restarts the scroll. */
  #applyMarquee(outer: HTMLElement, inner: HTMLElement): void {
    const overflow = this.#reduceMotion?.matches
      ? 0
      : inner.scrollWidth - outer.clientWidth;
    const scrolling = overflow > 4;
    if (scrolling) {
      const shift = `${-overflow}px`;
      const seconds = `${Math.max(6, Math.round(overflow / 35) + 4)}s`;
      if (inner.style.getPropertyValue("--marquee-shift") !== shift)
        inner.style.setProperty("--marquee-shift", shift);
      if (inner.style.getPropertyValue("--marquee-duration") !== seconds)
        inner.style.setProperty("--marquee-duration", seconds);
    }
    if (outer.classList.contains("is-scrolling") !== scrolling)
      outer.classList.toggle("is-scrolling", scrolling);
  }

  /**
   * `machineLabel` names the session's machine; `machineOffline` says the relay
   * no longer lists it, which holds the composer's draft until it returns.
   */
  update(
    session: SessionMeta,
    transcript: TranscriptState,
    handlers: ControlHandlers,
    pending: readonly InteractionFrame[],
    catalog: SessionCatalog,
    machineLabel?: string,
    machineOffline = false,
  ): void {
    this.#handlers = handlers;
    this.#connectionStatus.update(handlers.connectionStatus?.());
    const wasHidden = this.node.hidden;
    const previousScroll = this.#feed.scrollTop;
    this.node.hidden = false;
    this.#composer.setVisible(true);
    setText(
      this.#titleInner,
      transcript.title || session.title || "Untitled session",
    );
    this.#applyMarquee(this.#title, this.#titleInner);
    setText(
      this.#projectInner,
      machineLabel ? `${machineLabel} / ${session.project}` : session.project,
    );
    this.#applyMarquee(this.#project, this.#projectInner);
    const footer = transcript.footer;
    const model = footer?.model ?? session.model;
    const effort = footer?.thinkingLevel;
    this.#composer.setFastMode(footer?.fastMode);
    this.#jobs.update(
      transcript.jobs?.running ?? [],
      transcript.entries,
      transcript.ended,
    );
    // A running session the host-agent cannot stream (its Collab host stopped).
    const unreachable = session.reachable === false;
    this.node.classList.toggle("is-ended", transcript.ended);
    this.node.classList.toggle("is-unreachable", unreachable);
    // Nothing to end once it has ended, and no way to reach it while unreachable.
    this.#endSession.hidden = transcript.ended || unreachable;
    if (this.#endSession.hidden) this.#endConfirm.close();
    const orbState = orbStateFor(transcript, pending.length > 0);
    this.#wallpaper.setState(orbState);
    this.#transcript.update(transcript.entries, transcript.ended, unreachable);
    const focusWasInQueue = this.#queue.node.contains(document.activeElement);
    this.#queue.update(pending, handlers);
    this.#attention.hidden = pending.length === 0;
    const attentionLabel =
      this.#attention.querySelector<HTMLElement>(".button-label");
    if (attentionLabel) setText(attentionLabel, `${pending.length} to answer`);
    const active = !transcript.ended && transcript.footer?.streaming === true;
    this.#streaming = active;
    const currentModel = catalog.models.find((m) => m.id === catalog.currentId);
    const chipLabel = currentModel?.name ?? model;
    const chipEffort = catalog.currentEffort ?? effort;
    this.#composer.setCatalog(catalog);
    this.#composer.setModelChip(
      chipEffort ? `${chipLabel} · ${chipEffort}` : chipLabel,
      currentModel?.provider ?? "",
    );
    this.#composer.updateContextReadout(
      footer?.contextPct,
      footer?.contextTokens,
      footer?.contextWindow,
    );
    const send = decideSend({
      machine:
        machineLabel === undefined
          ? undefined
          : { label: machineLabel, offline: machineOffline },
    });
    this.#composer.update(
      handlers,
      transcript.ended,
      unreachable,
      active,
      pending,
      send.allowed ? undefined : send.notice,
    );
    if (
      focusWasInQueue &&
      pending.length === 0 &&
      document.activeElement === document.body
    ) {
      if (transcript.ended) this.#title.focus({ preventScroll: true });
      else this.#composer.input.focus({ preventScroll: true });
    }
    // A session lands on its newest message whenever it opens or comes back,
    // and stays pinned there while its replay and layout settle, until the
    // reader first moves the feed; after that the view follows new content
    // only with auto-scroll on, and otherwise keeps the reader's place.
    if (wasHidden) this.#apply({ kind: "open" });
    if (keepsPinned(this.#follow, this.#metrics()))
      this.#scrollTo(this.#feed.scrollHeight);
    else if (this.#feed.scrollTop !== previousScroll)
      this.#scrollTo(previousScroll);
    this.#apply({ kind: "content", metrics: this.#metrics() });
  }

  dispose(): void {
    this.#unsubscribeChat();
    this.#resize.disconnect();
    this.#jobs.stop();
    this.#composer.dispose();
    this.#queue.dispose();
    this.#wallpaper.dispose();
    this.node.remove();
  }
}
