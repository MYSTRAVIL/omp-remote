/// <reference lib="dom" />
import { type ClaimedPairing, MachineExistsError } from "../core/pair";
import { button, element, setText, uniqueId } from "./dom";

/** Where a code came from: a link's is claimed only once the user says Pair. */
export type PairSource = "link" | "typed";

export interface PairPromptDeps {
  /** Claim the pairing and check the host's proof; trusts nothing. */
  claim(code: string): Promise<ClaimedPairing>;
  /** Trust the machine (save its host key) and bring it into the workspace. */
  trust(claimed: ClaimedPairing): Promise<void>;
}

/** Which button ended a step; closing the dialog (Esc) is Cancel. */
type Answer = "pair" | "match" | "cancel";

interface Step {
  title: string;
  copy: string;
  /** The code to compare with the host's. */
  sas?: string;
  /** The button that goes on; none while waiting or after a failure. */
  go?: "pair" | "match";
  /** How the step ends: Cancel by default, Close after a failure, nothing while saving. */
  end?: "cancel" | "close" | "none";
}

/** What a failed claim tells the user. */
function failureText(error: unknown): string {
  if (error instanceof MachineExistsError)
    return `A machine named ${error.machineId} is already on this server. If it is the same computer, revoke it below under Machines on this server, then pair again. Otherwise run omp-remote join on that computer with a different --name.`;
  return "Pairing failed. Check the code and try again.";
}

/**
 * The one way a code becomes a paired machine, typed or from a link. A link's
 * code is claimed only after the user presses Pair, so opening a link someone
 * sent sends nothing. The claim's host proof is checked, then the user
 * compares the codes; the machine is trusted only on Codes match. Cancel at
 * any step, or a failure, stores no pairing.
 */
export class PairPrompt {
  readonly node = element("dialog", "workspace-dialog pair-prompt");
  readonly #title = element("h2", "dialog-title");
  readonly #copy = element("p", "section-copy pair-prompt-copy");
  readonly #sas = element("p", "pair-prompt-sas");
  readonly #cancel = button("Cancel", "button secondary");
  readonly #close = button("Close", "button secondary");
  readonly #pair = button("Pair", "button primary");
  readonly #match = button("Codes match", "button primary");
  readonly #deps: PairPromptDeps;
  #answer = Promise.withResolvers<Answer>();
  #busy = false;

  constructor(deps: PairPromptDeps) {
    this.#deps = deps;
    const header = element("header", "dialog-header");
    const heading = element("div", "dialog-heading");
    this.#title.id = uniqueId("pair-prompt");
    this.#title.tabIndex = -1;
    this.node.setAttribute("aria-labelledby", this.#title.id);
    heading.append(element("p", "eyebrow", "Pair a machine"), this.#title);
    header.append(heading);
    const body = element("div", "dialog-body");
    body.append(this.#copy, this.#sas);
    const actions = element("div", "dialog-actions");
    actions.append(this.#cancel, this.#close, this.#pair, this.#match);
    const footer = element("footer", "dialog-footer");
    footer.append(actions);
    this.node.append(header, body, footer);
    this.#pair.addEventListener("click", () => this.#answer.resolve("pair"));
    this.#match.addEventListener("click", () => this.#answer.resolve("match"));
    for (const end of [this.#cancel, this.#close])
      end.addEventListener("click", () => this.#answer.resolve("cancel"));
    // Esc is Cancel; the flow closes the dialog itself, so a step in progress
    // (saving the machine) cannot be dismissed half done.
    this.node.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.#answer.resolve("cancel");
    });
  }

  /**
   * Take `code` through pairing, asking first when it came from a link. The
   * paired machine's ID, or undefined when cancelled or failed. A code that
   * arrives while another is being paired is dropped.
   */
  async pair(code: string, source: PairSource): Promise<string | undefined> {
    if (this.#busy) return undefined;
    this.#busy = true;
    try {
      return await this.#run(code, source);
    } finally {
      this.#busy = false;
      this.node.close();
    }
  }

  async #run(code: string, source: PairSource): Promise<string | undefined> {
    if (source === "link") {
      const answer = await this.#show({
        title: "Pair a new machine from this link?",
        copy: "Only pair from a link you just made on your own computer. You'll compare a code with that computer next.",
        go: "pair",
      });
      if (answer === "cancel") return undefined;
    }
    // Cancel while the claim is out drops whatever it brings back.
    const cancelled = this.#show({
      title: "Pairing…",
      copy: "Checking the code with your machine.",
    });
    const claiming = this.#deps.claim(code).then(
      (claimed) => ({ claimed }),
      (error: unknown) => ({ error }),
    );
    const outcome = await Promise.race([claiming, cancelled]);
    if (typeof outcome === "string") return undefined;
    if ("error" in outcome) {
      await this.#show({
        title: "Couldn't pair",
        copy: failureText(outcome.error),
        end: "close",
      });
      return undefined;
    }
    const { claimed } = outcome;
    const answer = await this.#show({
      title: "Compare codes",
      copy: `${claimed.machineId} shows a code where you ran omp-remote. Pair only if it matches this one.`,
      sas: claimed.sas,
      go: "match",
    });
    if (answer === "cancel") return undefined;
    void this.#show({
      title: "Pairing…",
      copy: `Adding ${claimed.machineId} to your workspace.`,
      end: "none",
    });
    try {
      await this.#deps.trust(claimed);
    } catch {
      await this.#show({
        title: "Couldn't pair",
        copy: `Couldn't add ${claimed.machineId} to your workspace. Reload the page to try again.`,
        end: "close",
      });
      return undefined;
    }
    return claimed.machineId;
  }

  /** Show `step`, opening the dialog if needed; resolves with the button pressed. */
  #show(step: Step): Promise<Answer> {
    setText(this.#title, step.title);
    setText(this.#copy, step.copy);
    setText(this.#sas, step.sas ?? "");
    this.#sas.hidden = step.sas === undefined;
    this.#pair.hidden = step.go !== "pair";
    this.#match.hidden = step.go !== "match";
    this.#close.hidden = step.end !== "close";
    this.#cancel.hidden = step.end === "close" || step.end === "none";
    this.#answer = Promise.withResolvers<Answer>();
    if (!this.node.open) this.node.showModal();
    const shown = [this.#match, this.#pair, this.#close, this.#cancel].find(
      (action) => !action.hidden,
    );
    // Nothing to press while saving: focus stays in the dialog, on its title.
    (shown ?? this.#title).focus();
    return this.#answer.promise;
  }
}
