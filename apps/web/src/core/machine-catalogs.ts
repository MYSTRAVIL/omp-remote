import { CatalogModel, CatalogRole } from "@omp-remote/protocol";
import { z } from "zod";

export const MACHINE_CATALOGS_KEY = "omp-remote.launch.model-catalogs";

const StoredCatalogs = z.record(
  z.string().min(1),
  z.object({
    models: z.array(CatalogModel),
    roles: z.array(CatalogRole),
    configured: z.boolean().optional(),
  }),
);

/** The last model/role catalog any session on a machine reported. */
export interface MachineCatalog {
  models: CatalogModel[];
  roles: CatalogRole[];
  /** False or absent for a bare fallback catalog (see `ModelCatalogFrame`). */
  configured?: boolean;
}

/** The slice of `Storage` the cache needs; reached lazily so denied storage only loses the cache. */
export interface CatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Device-local cache of the last-known catalog per machine, so the new-session
 * dialog can offer that machine's models before any session there is open.
 * Like the store's per-session catalogs, a fallback catalog never replaces a
 * configured one.
 */
export class MachineCatalogs {
  readonly #storage: CatalogStorage;
  readonly #catalogs = new Map<string, MachineCatalog>();
  /** Serialized form of each entry, to skip writes when a catalog repeats. */
  readonly #serialized = new Map<string, string>();

  constructor(storage: CatalogStorage) {
    this.#storage = storage;
    try {
      const raw = storage.getItem(MACHINE_CATALOGS_KEY);
      if (raw === null) return;
      const parsed = StoredCatalogs.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const [machineId, catalog] of Object.entries(parsed.data)) {
        this.#catalogs.set(machineId, catalog);
        this.#serialized.set(machineId, JSON.stringify(catalog));
      }
    } catch {
      // Denied storage or malformed JSON: start with an empty cache.
    }
  }

  catalogFor(machineId: string): MachineCatalog | undefined {
    return this.#catalogs.get(machineId);
  }

  /** Record a session's catalog for its machine. Returns true when the cache changed. */
  observe(machineId: string, catalog: MachineCatalog): boolean {
    if (!catalog.configured && this.#catalogs.get(machineId)?.configured)
      return false;
    const entry: MachineCatalog = {
      models: catalog.models,
      roles: catalog.roles,
      configured: catalog.configured === true,
    };
    const serialized = JSON.stringify(entry);
    if (this.#serialized.get(machineId) === serialized) return false;
    this.#catalogs.set(machineId, entry);
    this.#serialized.set(machineId, serialized);
    this.#persist();
    return true;
  }

  forget(machineId: string): void {
    if (!this.#catalogs.delete(machineId)) return;
    this.#serialized.delete(machineId);
    this.#persist();
  }

  #persist(): void {
    try {
      this.#storage.setItem(
        MACHINE_CATALOGS_KEY,
        JSON.stringify(Object.fromEntries(this.#catalogs)),
      );
    } catch {
      // The in-memory cache still serves this page load.
    }
  }
}
