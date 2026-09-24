/// <reference lib="dom" />
import type {
  InteractionFrame,
  InteractionQuestion,
  InteractionResponse,
} from "@omp-remote/protocol";
import { button, element, field, setText, syncChildren, uniqueId } from "./dom";
import type { ControlHandlers } from "./render";

class QuestionField {
  readonly node = element("fieldset", "question");
  readonly input = element("textarea", "question-input");
  readonly options: HTMLInputElement[] = [];
  readonly #question: InteractionQuestion;

  constructor(question: InteractionQuestion, index: number, count: number) {
    this.#question = question;
    const legend = element("legend", "question-title");
    if (count > 1) {
      legend.append(
        element("span", "question-number", `${index + 1} / ${count}`),
      );
    }
    legend.append(element("span", "question-text", question.question));
    this.node.append(legend);
    const options = question.options ?? [];
    const groupName = uniqueId("answer");
    this.input.rows = 3;
    this.input.placeholder = "Write your answer…";
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", `Your answer: ${question.question}`);
    if (options.length > 0) {
      this.node.append(
        element(
          "p",
          "field-hint question-hint",
          question.multi
            ? "Choose all that apply. You can add your own answer."
            : "Choose one option or write your own answer.",
        ),
      );
      const choices = element("div", "question-options");
      for (const [optionIndex, option] of options.entries()) {
        const choice = element("label", "question-option");
        const input = element("input", "question-choice");
        input.type = question.multi ? "checkbox" : "radio";
        input.name = groupName;
        input.value = option.label;
        const copy = element("span", "option-copy");
        const title = element("span", "option-label", option.label);
        if (question.recommended === optionIndex) {
          title.append(element("span", "recommended", "Recommended"));
        }
        copy.append(title);
        if (option.description !== undefined) {
          copy.append(
            element("span", "option-description", option.description),
          );
        }
        choice.append(input, copy);
        choices.append(choice);
        this.options.push(input);
      }
      this.node.append(choices, field("Your answer", this.input));
    } else {
      this.input.required = true;
      this.node.append(field("Your answer", this.input));
    }
    this.input.addEventListener("input", () => {
      this.input.setCustomValidity("");
      if (!question.multi) {
        for (const option of this.options) option.checked = false;
      }
    });
  }

  answer(): string | undefined {
    const selected = this.options
      .filter((option) => option.checked)
      .map((option) => option.value);
    const text = this.input.value.trim();
    // A selected radio takes precedence over the saved draft until it is edited.
    if (text && (this.#question.multi || selected.length === 0)) {
      selected.push(text);
    }
    if (selected.length === 0) {
      if (this.options.length > 0) {
        this.options[0]?.focus();
      } else {
        this.input.setCustomValidity("Write an answer before sending.");
        this.input.reportValidity();
      }
      return undefined;
    }
    // The bridge forwards one string per question; native ask joins multi labels with comma-space.
    return this.#question.multi ? selected.join(", ") : selected[0];
  }
}

/** The wire has two decisions, not a positional or arbitrary choice protocol. */
function approvalDecision(label: string): "allow" | "deny" | undefined {
  switch (label.trim().toLowerCase()) {
    case "approve":
    case "allow":
      return "allow";
    case "deny":
    case "reject":
      return "deny";
    default:
      return undefined;
  }
}

class InteractionCard {
  readonly node = element("form", "interaction-card");
  readonly request: InteractionFrame;
  handlers: ControlHandlers;
  readonly #status = element("p", "interaction-status");
  readonly #questions: QuestionField[] = [];
  readonly #controls: HTMLButtonElement[] = [];
  #busy = false;
  #active = true;

  constructor(request: InteractionFrame, handlers: ControlHandlers) {
    this.request = request;
    this.handlers = handlers;
    this.node.dataset.interactionId = request.id;
    this.node.dataset.sessionId = request.sessionId;
    this.node.tabIndex = -1;
    this.node.noValidate = true;
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    const heading = element("div", "interaction-heading");
    const headingId = uniqueId("request");
    const title = element(
      "h3",
      "interaction-title",
      request.payload.kind === "ask"
        ? "Your input is needed"
        : "Approval needed",
    );
    title.id = headingId;
    this.node.setAttribute("aria-labelledby", headingId);
    heading.append(element("span", "attention-mark"), title);
    this.node.append(heading);
    if (request.payload.kind === "ask") {
      this.node.classList.add("interaction-ask");
      const questions = request.payload.questions;
      for (const [index, question] of questions.entries()) {
        const view = new QuestionField(question, index, questions.length);
        this.#questions.push(view);
        this.node.append(view.node);
      }
      const send = button(
        questions.length > 1 ? "Send answers" : "Send answer",
        "button primary interaction-submit",
        "arrow",
      );
      send.type = "submit";
      this.#controls.push(send);
      const actions = element("div", "interaction-actions");
      actions.append(
        send,
        element("span", "field-hint", "You can also answer at the terminal."),
      );
      this.node.append(actions);
      this.node.addEventListener("submit", (event) => {
        event.preventDefault();
        if (this.#busy || !this.#active) return;
        const answers: string[] = [];
        for (const question of this.#questions) {
          const answer = question.answer();
          if (answer === undefined) {
            this.#status.textContent = "Answer each question before sending.";
            return;
          }
          answers.push(answer);
        }
        void this.#send({ kind: "ask", answers });
      });
    } else {
      this.node.classList.add("interaction-approval");
      const payload = request.payload;
      this.node.append(
        element(
          "p",
          "approval-urgency",
          "Time-sensitive. Unanswered approvals expire and block the tool.",
        ),
        element("p", "approval-tool", payload.tool),
      );
      if (payload.reason !== undefined) {
        this.node.append(element("p", "approval-reason", payload.reason));
      }
      if (payload.input !== undefined) {
        const details = element("details", "approval-input-details");
        details.append(element("summary", "details-summary", "Tool input"));
        details.append(
          element(
            "pre",
            "approval-input",
            JSON.stringify(payload.input, null, 2) ?? "",
          ),
        );
        this.node.append(details);
      }
      const actions = element("div", "interaction-actions approval-actions");
      const unsupported = element(
        "p",
        "field-hint unsupported-choices",
        "Some choices cannot be sent by this client. Use the terminal for those choices.",
      );
      unsupported.id = uniqueId("unsupported");
      let hasUnsupported = false;
      for (const label of payload.choices) {
        const decision = approvalDecision(label);
        const choice = button(
          label,
          `button approval-choice ${decision === "allow" ? "primary" : "secondary"}`,
        );
        if (decision === undefined) {
          choice.disabled = true;
          choice.setAttribute("aria-describedby", unsupported.id);
          hasUnsupported = true;
        } else {
          this.#controls.push(choice);
          choice.addEventListener("click", () => {
            void this.#send({ kind: "approval", decision });
          });
        }
        actions.append(choice);
      }
      this.node.append(actions);
      if (hasUnsupported) this.node.append(unsupported);
      this.node.addEventListener("submit", (event) => event.preventDefault());
    }
    this.node.append(this.#status);
  }

  /** Text typed into an answer box; a picked option alone is not a draft. */
  hasDraft(): boolean {
    return this.#questions.some(
      (question) => question.input.value.trim().length > 0,
    );
  }

  dispose(): void {
    this.#active = false;
    this.node.remove();
  }

  async #send(response: InteractionResponse): Promise<void> {
    if (this.#busy || !this.#active) return;
    this.#busy = true;
    this.node.setAttribute("aria-busy", "true");
    const focused = document.activeElement;
    const textarea =
      focused instanceof HTMLTextAreaElement ? focused : undefined;
    const selectionStart = textarea?.selectionStart;
    const selectionEnd = textarea?.selectionEnd;
    const selectionDirection = textarea?.selectionDirection;
    const inputScroll = textarea?.scrollTop;
    for (const control of this.#controls) control.disabled = true;
    for (const question of this.#questions) question.node.disabled = true;
    this.#status.textContent = "Sending… A passkey check may be needed.";
    // Capture both identities before UV can yield or navigation can change selection.
    const { sessionId, id } = this.request;
    try {
      const sent = await this.handlers.onInteractionReply(
        sessionId,
        id,
        response,
      );
      if (!this.#active) return;
      if (sent) {
        // Main dismisses in the store. Do not show a stale form if its redraw is deferred.
        this.dispose();
      } else {
        this.#status.textContent =
          "Not sent. Your answer is saved here. Check the connection and confirm your passkey to try again.";
      }
    } catch {
      if (this.#active) {
        this.#status.textContent =
          "Could not send. Your answer is still here; try again.";
      }
    } finally {
      this.#busy = false;
      this.node.removeAttribute("aria-busy");
      for (const control of this.#controls) control.disabled = false;
      for (const question of this.#questions) question.node.disabled = false;
      if (
        this.#active &&
        focused instanceof HTMLElement &&
        focused.isConnected &&
        this.node.contains(focused) &&
        !this.node.closest("[hidden]") &&
        document.activeElement === document.body
      ) {
        focused.focus({ preventScroll: true });
        if (
          textarea &&
          selectionStart !== undefined &&
          selectionEnd !== undefined
        ) {
          textarea.setSelectionRange(
            selectionStart,
            selectionEnd,
            selectionDirection,
          );
          textarea.scrollTop = inputScroll ?? 0;
        }
      }
    }
  }
}

export class InteractionQueue {
  readonly node = element("section", "interaction-queue");
  readonly #heading = element("h2", "queue-heading");
  readonly #list = element("div", "interaction-list");
  readonly #cards = new Map<string, InteractionCard>();

  constructor() {
    this.#heading.id = uniqueId("queue");
    this.node.setAttribute("aria-labelledby", this.#heading.id);
    this.node.append(this.#heading, this.#list);
    this.node.hidden = true;
  }

  update(
    pending: readonly InteractionFrame[],
    handlers: ControlHandlers,
  ): void {
    const ids = new Set(pending.map((request) => request.id));
    const focused = document.activeElement;
    let focusRemoved = false;
    for (const [id, card] of this.#cards) {
      if (!ids.has(id)) {
        focusRemoved ||= focused !== null && card.node.contains(focused);
        card.dispose();
        this.#cards.delete(id);
      }
    }
    const nodes: HTMLFormElement[] = [];
    for (const request of pending) {
      let card = this.#cards.get(request.id);
      if (!card) {
        card = new InteractionCard(request, handlers);
        this.#cards.set(request.id, card);
      }
      card.handlers = handlers;
      nodes.push(card.node);
    }
    syncChildren(this.#list, nodes);
    setText(this.#heading, `Needs your attention · ${pending.length}`);
    this.node.hidden = pending.length === 0;
    if (focusRemoved && nodes[0]) nodes[0].focus({ preventScroll: true });
  }

  focusFirst(): void {
    const first = this.#list.firstElementChild;
    if (first instanceof HTMLElement) {
      first.scrollIntoView({ block: "start" });
      first.focus({ preventScroll: true });
    }
  }

  hasDraft(): boolean {
    for (const card of this.#cards.values()) if (card.hasDraft()) return true;
    return false;
  }

  dispose(): void {
    for (const card of this.#cards.values()) card.dispose();
    this.#cards.clear();
  }
}
