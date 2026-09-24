/// <reference lib="dom" />
import type { CatalogModel, CatalogRole } from "@omp-remote/protocol";
import { button, element, icon, setText, uniqueId } from "./dom";

/** What a picker lists: a session's live catalog or a machine's last-known one. */
export interface PickerCatalog {
  readonly models: readonly CatalogModel[];
  readonly roles: readonly CatalogRole[];
  /** The chosen model's catalog id; rows that resolve to it are marked current. */
  readonly currentId?: string;
  readonly currentEffort?: string;
}

/** What a tap chose. `default` clears the choice; only offered with `defaultLabel`. */
export type ModelPick =
  | { readonly kind: "default" }
  | { readonly kind: "role"; readonly role: CatalogRole }
  | { readonly kind: "model"; readonly model: CatalogModel }
  | { readonly kind: "effort"; readonly level: string };

export interface ModelPickerOptions {
  /** `h2` as a drawer's own title, `h3` inside a dialog section, `h4` in a Settings subsection. */
  readonly heading: "h2" | "h3" | "h4";
  /** Title of the root list; each drilled-in list is titled by its name. */
  readonly rootTitle: string;
  /** Offer the Effort list (a live session). New session and Settings pick
   *  model only here; each has its own effort control beside the picker. */
  readonly effort: boolean;
  /** Label of a first root row that clears the choice, e.g. the host default. */
  readonly defaultLabel?: string;
  /** Host controls after the title, e.g. the drawer's Close. */
  readonly headerEnd?: readonly HTMLElement[];
  /** Host controls after the root list, e.g. Compact and the context readout. */
  readonly rootEnd?: readonly HTMLElement[];
  readonly onPick: (pick: ModelPick) => void;
}

type View = "root" | "roles" | "models" | "effort";

const LIST_TITLES: Record<Exclude<View, "root">, string> = {
  roles: "Roles",
  models: "Models",
  effort: "Effort",
};
/** Offered when the current model lists no effort levels of its own. */
const EFFORT_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const NO_CATALOG: PickerCatalog = { models: [], roles: [] };

/**
 * The model picker the composer drawer and the New session dialog share: a
 * root list (Roles, Models, and Effort when offered) that drills into each,
 * with Back returning to the root. Hosts decide what a pick does: set a live
 * session's model, or fill in the model a new session starts with.
 */
export class ModelPicker {
  /** Header (Back, title, host controls) over the current list; `data-view` names it. */
  readonly node = element("div", "model-picker");
  readonly title: HTMLHeadingElement;
  readonly #back = button(
    "Back",
    "button icon-button model-picker-back",
    "back",
  );
  readonly #body = element("div", "model-picker-body");
  readonly #options: ModelPickerOptions;
  /** This render's rows by a key stable across redraws, so focus can follow. */
  readonly #rows = new Map<string, HTMLButtonElement>();
  #current: HTMLButtonElement | undefined;
  #catalog = NO_CATALOG;
  #view: View = "root";

  constructor(options: ModelPickerOptions) {
    this.#options = options;
    this.title = element(options.heading, "model-picker-title");
    this.title.id = uniqueId("model-picker");
    const header = element("header", "model-picker-header");
    header.append(this.#back, this.title, ...(options.headerEnd ?? []));
    this.#back.addEventListener("click", () => this.#show("root"));
    this.node.append(header, this.#body);
    this.render();
  }

  /** Applies on the next `reset` or `render`; a list on screen stays as drawn. */
  setCatalog(catalog: PickerCatalog): void {
    this.#catalog = catalog;
  }

  /** Return to the root list, e.g. as the drawer opens or after a pick. */
  reset(): void {
    this.#show("root");
  }

  /** Redraw the current list; a focused row keeps focus in its redrawn form. */
  render(): void {
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && this.#body.contains(active)
        ? active.dataset.pickerKey
        : undefined;
    const { models, roles, currentId, currentEffort } = this.#catalog;
    const view = this.#view;
    this.node.dataset.view = view;
    this.#back.hidden = view === "root";
    setText(
      this.title,
      view === "root" ? this.#options.rootTitle : LIST_TITLES[view],
    );
    this.#rows.clear();
    this.#current = undefined;
    const rows: HTMLElement[] = [];
    if (view === "root") {
      const { defaultLabel, effort, rootEnd = [] } = this.#options;
      if (defaultLabel !== undefined)
        rows.push(
          this.#option("default", defaultLabel, "", !currentId, {
            kind: "default",
          }),
        );
      const current = models.find((model) => model.id === currentId);
      rows.push(
        this.#nav("roles", `${roles.length} configured`),
        this.#nav("models", current?.name ?? "—"),
      );
      if (effort) rows.push(this.#nav("effort", currentEffort ?? "—"));
      rows.push(...rootEnd);
    } else if (view === "roles") {
      for (const role of roles)
        rows.push(
          this.#option(
            `role:${role.role}`,
            role.role,
            role.modelName ?? role.modelId,
            role.modelId === currentId,
            { kind: "role", role },
          ),
        );
      if (roles.length === 0)
        rows.push(element("p", "model-picker-empty", "No roles configured"));
    } else if (view === "models") {
      const byProvider = new Map<string, CatalogModel[]>();
      for (const model of models) {
        const group = byProvider.get(model.provider);
        if (group) group.push(model);
        else byProvider.set(model.provider, [model]);
      }
      const heading = this.#options.heading === "h2" ? "h3" : "h4";
      for (const [provider, group] of byProvider) {
        rows.push(element(heading, "model-picker-group", provider));
        for (const model of group)
          rows.push(
            this.#option(
              `model:${model.id}`,
              model.name,
              "",
              model.id === currentId,
              { kind: "model", model },
            ),
          );
      }
      if (models.length === 0)
        rows.push(element("p", "model-picker-empty", "No models available"));
    } else {
      const current = models.find((model) => model.id === currentId);
      const levels =
        current && current.efforts.length > 0 ? current.efforts : EFFORT_LEVELS;
      for (const level of levels)
        rows.push(
          this.#option(`effort:${level}`, level, "", level === currentEffort, {
            kind: "effort",
            level,
          }),
        );
    }
    this.#body.replaceChildren(...rows);
    if (focused !== undefined) this.#rows.get(focused)?.focus();
  }

  #show(view: View): void {
    const from = this.#view;
    const focused = this.node.contains(document.activeElement);
    this.#view = view;
    this.render();
    if (!focused || view === from) return;
    // Keyboard focus follows the move: onto the chosen row of the list just
    // opened, or back onto the root row that opened the list just left.
    const target =
      view === "root"
        ? this.#rows.get(from)
        : (this.#current ?? this.#rows.values().next().value);
    (target ?? this.#back).focus();
  }

  #nav(view: Exclude<View, "root">, value: string): HTMLButtonElement {
    const row = button(LIST_TITLES[view], "button model-picker-nav");
    row.append(
      element("span", "model-picker-nav-value", value),
      icon("chevron"),
    );
    row.addEventListener("click", () => this.#show(view));
    row.dataset.pickerKey = view;
    this.#rows.set(view, row);
    return row;
  }

  #option(
    key: string,
    label: string,
    detail: string,
    current: boolean,
    pick: ModelPick,
  ): HTMLButtonElement {
    const row = button(label, "button model-picker-option");
    if (detail)
      row.append(element("span", "model-picker-option-detail", detail));
    if (current) {
      row.classList.add("is-current");
      row.setAttribute("aria-current", "true");
      if (!this.#current) this.#current = row;
    }
    row.addEventListener("click", () => this.#options.onPick(pick));
    row.dataset.pickerKey = key;
    this.#rows.set(key, row);
    return row;
  }
}
