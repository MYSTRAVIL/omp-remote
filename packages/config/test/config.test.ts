import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "@omp-remote/protocol/ipc";
import {
  AgentSection,
  Config,
  ConfigError,
  MachineId,
  ServerSection,
  configPath,
  loadConfig,
  saveConfig,
  secretPaths,
  writeFileAtomic,
} from "../src/index.js";

describe("config schema", () => {
  test("MachineId accepts valid identifiers", () => {
    expect(MachineId.safeParse("my-machine").success).toBe(true);
    expect(MachineId.safeParse("box_01").success).toBe(true);
    expect(MachineId.safeParse("123").success).toBe(true);
  });

  test("MachineId rejects invalid identifiers", () => {
    expect(MachineId.safeParse("").success).toBe(false);
    expect(MachineId.safeParse("a".repeat(65)).success).toBe(false);
    expect(MachineId.safeParse("has space").success).toBe(false);
  });

  test("ServerSection defaults", () => {
    const parsed = ServerSection.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.listen.host).toBe("0.0.0.0");
      expect(parsed.data.listen.port).toBe(8788);
      expect(parsed.data.sessionTtlSec).toBe(3600);
      expect(parsed.data.rememberTtlSec).toBe(2_592_000);
      expect(parsed.data.collabRelay).toBe(false);
      expect(parsed.data.pushSubject).toBe("mailto:omp-remote@localhost");
    }
  });

  test("ServerSection rejects http publicUrl", () => {
    const parsed = ServerSection.safeParse({ publicUrl: "http://example.com" });
    expect(parsed.success).toBe(false);
  });

  test("ServerSection accepts https publicUrl", () => {
    const parsed = ServerSection.safeParse({
      publicUrl: "https://example.com",
    });
    expect(parsed.success).toBe(true);
  });

  test("Config rejects neither section", () => {
    const parsed = Config.safeParse({
      version: 1,
      machineId: "box",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toContain("server or an agent section");
    }
  });

  test("Config accepts server section only", () => {
    const parsed = Config.safeParse({
      version: 1,
      machineId: "box",
      server: {},
    });
    expect(parsed.success).toBe(true);
  });

  test("Config accepts agent section only", () => {
    const parsed = Config.safeParse({
      version: 1,
      machineId: "box",
      agent: { serverUrl: "http://localhost:8788" },
    });
    expect(parsed.success).toBe(true);
  });

  test("AgentSection devClient defaults", () => {
    const parsed = AgentSection.safeParse({
      serverUrl: "http://localhost:8788",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.phoneId).toBeUndefined();
      expect(parsed.data.collab).toBe(false);
      expect(parsed.data.ompBin).toBe("omp");
    }
  });
});

describe("config file operations", () => {
  test("configPath returns correct path", () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    expect(configPath()).toBe(
      join(process.env.OMP_REMOTE_STATE_DIR, "config.json"),
    );
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("saveConfig then loadConfig round-trips", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const cfg = Config.parse({
      version: 1,
      machineId: "test-box",
      server: { listen: { port: 9000 } },
    });
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded.version).toBe(1);
    expect(loaded.machineId).toBe("test-box");
    expect(loaded.server?.listen.port).toBe(9000);
    expect(loaded.server?.listen.host).toBe("0.0.0.0");
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("saveConfig overwrites an existing config", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const base = { version: 1, machineId: "box", server: {} } as const;
    await saveConfig(Config.parse(base));
    await saveConfig(Config.parse({ ...base, machineId: "renamed" }));
    expect((await loadConfig()).machineId).toBe("renamed");
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("loadConfig fills defaults", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const cfg = Config.parse({
      version: 1,
      machineId: "defaults-box",
      server: {},
    });
    await saveConfig(cfg);
    const loaded = await loadConfig();
    expect(loaded.server?.listen.port).toBe(8788);
    expect(loaded.server?.sessionTtlSec).toBe(3600);
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("loadConfig rejects config with neither section", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, machineId: "no-sections" }),
      { flag: "wx" },
    );
    try {
      await loadConfig();
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("loadConfig rejects http publicUrl with path in message", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        machineId: "bad-url",
        server: { publicUrl: "http://example.com" },
      }),
      { flag: "wx" },
    );
    try {
      await loadConfig();
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
      expect((err as Error).message).toContain("server.publicUrl");
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("loadConfig throws ConfigError for corrupt JSON", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const path = configPath();
    writeFileSync(path, "{ not valid json", { flag: "wx" });
    try {
      await loadConfig();
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("loadConfig throws ConfigError for missing file", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    try {
      await loadConfig();
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });

  test("saveConfig writes file with 0600 permissions", async () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const cfg = Config.parse({
      version: 1,
      machineId: "perms-box",
      server: {},
    });
    await saveConfig(cfg);
    if (platform() !== "win32") {
      const stat = statSync(configPath());
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });
});

describe("secretPaths", () => {
  test("all paths are under stateDir", () => {
    process.env.OMP_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const dir = stateDir(process.env);
    for (const key of Object.keys(secretPaths) as Array<
      keyof typeof secretPaths
    >) {
      expect(secretPaths[key].startsWith(dir)).toBe(true);
    }
    Reflect.deleteProperty(process.env, "OMP_REMOTE_STATE_DIR");
  });
});

test("server.trustProxy defaults to false: forwarded headers are ignored unless the operator opts in", () => {
  expect(ServerSection.parse({}).trustProxy).toBe(false);
  expect(ServerSection.parse({ trustProxy: true }).trustProxy).toBe(true);
  expect(ServerSection.safeParse({ trustProxy: "yes" }).success).toBe(false);
});

test.skipIf(process.platform !== "win32")(
  "writeFileAtomic on Windows leaves the file granted to the current user alone",
  async () => {
    const path = join(mkdtempSync(join(tmpdir(), "omp-cfg-acl-")), "token");
    // An earlier file with the directory's inherited ACL, as before the fix.
    writeFileSync(path, "old");
    const failures: string[] = [];
    await writeFileAtomic(path, "new", {
      onAclFailure: (f) => failures.push(f),
    });
    expect(failures).toEqual([]);
    // Read the ACL back independently: one ACE, for the current user.
    const listing = Bun.spawnSync(["icacls", path]).stdout.toString();
    const aces = listing
      .slice(path.length)
      .split(/\r?\n/)
      .map((line) => line.trim());
    const granted = aces.slice(0, aces.indexOf(""));
    expect(granted).toHaveLength(1);
    expect(granted[0]?.toLowerCase()).toContain(
      `\\${userInfo().username.toLowerCase()}:`,
    );
  },
);
