import { parseArgs } from "node:util";
import { CredentialStore } from "@omp-remote/aggregator/src/credential-store";
import {
  MIN_PASSWORD_LENGTH,
  setPassword,
} from "@omp-remote/aggregator/src/password";
import { loadConfig, secretPaths } from "@omp-remote/config";
import type { CliDeps } from "../deps";
import { localServerUrl } from "../urls";

/**
 * A new sign-in password: all of stdin with `--password-stdin`, else typed
 * twice without echo. Throws before anything is stored when the two differ or
 * it is shorter than {@link MIN_PASSWORD_LENGTH}.
 */
export async function readNewPassword(
  fromStdin: boolean,
  deps: CliDeps,
): Promise<string> {
  const tooShort = `the password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (fromStdin) {
    const password = await deps.readStdin();
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(tooShort);
    return password;
  }
  const password = await deps.askSecret(
    `Password (at least ${MIN_PASSWORD_LENGTH} characters)`,
  );
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(tooShort);
  if ((await deps.askSecret("Repeat the password")) !== password)
    throw new Error("the passwords do not match");
  return password;
}

/**
 * `omp-remote passwd [--password-stdin] [--enable-password-sign-in]`: set or
 * change the sign-in password. `--enable-password-sign-in` also turns
 * password sign-in back on in the credential store, the way back in for an
 * owner who turned it off and lost their passkey. The running server holds
 * that store in memory and its next write would undo the change, so that
 * flag is refused while the server answers.
 */
export async function passwd(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "password-stdin": { type: "boolean", default: false },
      "enable-password-sign-in": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const cfg = await loadConfig();
  const server = cfg.server;
  if (server === undefined)
    throw new Error(
      "this machine runs no server; set the password on the server machine",
    );
  let store: CredentialStore | undefined;
  if (values["enable-password-sign-in"]) {
    const base = localServerUrl(server.listen.host, server.listen.port);
    const running = await deps.fetch(`${base}/auth/methods`).then(
      async (res) => {
        await res.body?.cancel();
        return true;
      },
      () => false,
    );
    if (running)
      throw new Error(
        `the server at ${base} is running and keeps the sign-in settings in memory; stop it (\`omp-remote uninstall\` stops the service), rerun this, then start it again`,
      );
    store = await CredentialStore.load(secretPaths.credentials);
  }
  const password = await readNewPassword(values["password-stdin"], deps);
  await setPassword(secretPaths.password, password, deps.now());
  deps.print("Password set. Every password sign-in is signed out.");
  if (store !== undefined) {
    await store.setPasswordSignIn(true, deps.now());
    deps.print("Password sign-in is on.");
  }
  return 0;
}
