import type { SessionMeta } from "@omp-remote/protocol";

export interface RegistryEntry {
  meta: SessionMeta;
}

export class Registry {
  #entries = new Map<string, RegistryEntry>();
  #cbs: (() => void)[] = [];

  onChange(cb: () => void): void {
    this.#cbs.push(cb);
  }
  #emit(): void {
    for (const cb of this.#cbs) cb();
  }

  upsert(meta: SessionMeta): void {
    this.#entries.set(meta.id, { meta });
    this.#emit();
  }
  remove(id: string): void {
    if (this.#entries.delete(id)) this.#emit();
  }
  get(id: string): SessionMeta | undefined {
    return this.#entries.get(id)?.meta;
  }
  list(): RegistryEntry[] {
    return [...this.#entries.values()].sort(
      (a, b) =>
        a.meta.project.localeCompare(b.meta.project) ||
        a.meta.startedAt - b.meta.startedAt,
    );
  }
}
