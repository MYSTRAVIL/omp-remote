import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { hostCommitment, newIdentity, pairingSas } from "@omp-remote/crypto";
import { PairClaimRequest } from "@omp-remote/protocol";
import {
  claimPairing,
  takePairLinkCode,
  watchPairLinks,
} from "../src/core/pair";
import { pairedMachineIds, savePairing } from "../src/core/pairing-browser";
import { PairPrompt } from "../src/ui/pair-prompt";

// Register a DOM only for this file and tear it down after, so happy-dom's
// globals never leak into the other suites.
beforeAll(() => GlobalRegistrator.register({ url: "https://relay.test/" }));
afterAll(() => GlobalRegistrator.unregister());

const CODE = "ABCD-2345-EFGH";

/** How the relay answers `/pair/claim`, given the claim the phone posted. */
type ClaimAnswer = (claim: PairClaimRequest) => Promise<Response>;

/** The host `desk` answering with its key and a MAC under `CODE`. */
async function hostAnswers(): Promise<{
  answer: ClaimAnswer;
  hostPub: string;
}> {
  const host = await newIdentity();
  const answer: ClaimAnswer = async () => {
    const { mac: hostMac } = await hostCommitment(CODE, "desk", host.publicKey);
    return Response.json({
      machineId: "desk",
      hostPub: host.publicKey,
      hostMac,
    });
  };
  return { answer, hostPub: host.publicKey };
}

/**
 * A browser with no pairings, a relay answering `/pair/claim` with `answer`,
 * and the prompt over them, as main wires it: trusting saves the host key.
 */
function setup(answer: ClaimAnswer): {
  prompt: PairPrompt;
  claims: PairClaimRequest[];
  paired: () => string[];
} {
  const blob = new Map<string, string>();
  const getItem = (key: string): string | null => blob.get(key) ?? null;
  const setItem = (key: string, value: string): void => {
    blob.set(key, value);
  };
  const claims: PairClaimRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe("/pair/claim");
    const claim = PairClaimRequest.parse(JSON.parse(String(init?.body)));
    claims.push(claim);
    return answer(claim);
  };
  const prompt = new PairPrompt({
    claim: (code) =>
      claimPairing(
        {
          baseUrl: "https://relay.test",
          // Only the call signature is used; `preconnect` is irrelevant here.
          fetch: fetch as unknown as typeof globalThis.fetch,
          token: "sess.tok",
          getItem,
          setItem,
        },
        code,
      ),
    trust: async ({ machineId, hostPub }) =>
      savePairing(getItem, setItem, machineId, hostPub),
  });
  document.body.replaceChildren(prompt.node);
  return { prompt, claims, paired: () => pairedMachineIds(getItem) };
}

/** Resolves once `holds()`, checked again after every change under `scope`. */
function until(scope: Node, holds: () => boolean): Promise<void> {
  const reached = Promise.withResolvers<void>();
  const observer = new MutationObserver(() => {
    if (!holds()) return;
    observer.disconnect();
    reached.resolve();
  });
  observer.observe(scope, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  if (holds()) {
    observer.disconnect();
    reached.resolve();
  }
  return reached.promise;
}

/** The prompt's question, as its accessible name reads. */
function title(prompt: PairPrompt): string {
  const id = prompt.node.getAttribute("aria-labelledby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

/** What the prompt shows: its text without the parts that are hidden. */
function shown(prompt: PairPrompt): string {
  const copy = prompt.node.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

/** Press the visible button labelled `name`. */
function press(prompt: PairPrompt, name: string): void {
  const match = [...prompt.node.querySelectorAll("button")].find(
    (node) => node.closest("[hidden]") === null && node.textContent === name,
  );
  if (!match) throw new Error(`no visible ${name} button`);
  match.click();
}

test("opening a pairing link claims nothing until Pair is pressed", async () => {
  const { answer } = await hostAnswers();
  const { prompt, claims } = setup(answer);
  history.pushState(null, "", `https://relay.test/#pair=${CODE}`);
  const code = takePairLinkCode(location, history);
  if (code === undefined) throw new Error("no code");
  const done = prompt.pair(code, "link");

  expect(prompt.node.open).toBe(true);
  expect(title(prompt)).toBe("Pair a new machine from this link?");
  expect(claims).toEqual([]);

  press(prompt, "Pair");
  await until(prompt.node, () => title(prompt) === "Compare codes");
  expect(claims.length).toBe(1);
  press(prompt, "Cancel");
  expect(await done).toBeUndefined();
});

test("Cancel on a link claims nothing and stores nothing", async () => {
  const { answer } = await hostAnswers();
  const { prompt, claims, paired } = setup(answer);
  const done = prompt.pair(CODE, "link");
  press(prompt, "Cancel");
  expect(await done).toBeUndefined();
  expect(prompt.node.open).toBe(false);
  expect(claims).toEqual([]);
  expect(paired()).toEqual([]);
});

test("the SAS step names the machine and its code; Cancel there stores no pairing", async () => {
  const { answer, hostPub } = await hostAnswers();
  const { prompt, claims, paired } = setup(answer);
  const done = prompt.pair(CODE, "typed");
  await until(prompt.node, () => title(prompt) === "Compare codes");

  const phonePub = claims[0]?.phonePub;
  if (phonePub === undefined) throw new Error("claim was never posted");
  const sas = await pairingSas(CODE, "desk", hostPub, phonePub);
  expect(shown(prompt)).toContain("desk");
  expect(shown(prompt)).toContain(sas);
  // Checked and shown, but not trusted yet.
  expect(paired()).toEqual([]);

  press(prompt, "Cancel");
  expect(await done).toBeUndefined();
  expect(prompt.node.open).toBe(false);
  expect(paired()).toEqual([]);
});

test("Codes match stores the pairing", async () => {
  const { answer } = await hostAnswers();
  const { prompt, paired } = setup(answer);
  const done = prompt.pair(CODE, "link");
  press(prompt, "Pair");
  await until(prompt.node, () => title(prompt) === "Compare codes");
  press(prompt, "Codes match");
  expect(await done).toBe("desk");
  expect(prompt.node.open).toBe(false);
  expect(paired()).toEqual(["desk"]);
});

test("a machine the server already has is refused with how to join under another name", async () => {
  const { prompt, paired } = setup(async () =>
    Response.json(
      { error: "machine-exists", machineId: "desk" },
      { status: 409 },
    ),
  );
  const done = prompt.pair(CODE, "typed");
  await until(prompt.node, () => title(prompt) === "Couldn't pair");
  expect(shown(prompt)).toContain(
    "A machine named desk is already on this server. If it is the same computer, revoke it below under Machines on this server, then pair again. Otherwise run omp-remote join on that computer with a different --name.",
  );
  press(prompt, "Close");
  expect(await done).toBeUndefined();
  expect(paired()).toEqual([]);
});

test("a host MAC made under another code fails and stores nothing", async () => {
  const host = await newIdentity();
  const { prompt, paired } = setup(async () => {
    const { mac: hostMac } = await hostCommitment(
      "0R2S-4T6V-8W0X",
      "desk",
      host.publicKey,
    );
    return Response.json({
      machineId: "desk",
      hostPub: host.publicKey,
      hostMac,
    });
  });
  const done = prompt.pair(CODE, "typed");
  await until(prompt.node, () => title(prompt) === "Couldn't pair");
  expect(shown(prompt)).toContain(
    "Pairing failed. Check the code and try again.",
  );
  press(prompt, "Close");
  expect(await done).toBeUndefined();
  expect(paired()).toEqual([]);
});

test("a pairing link opened while the app is open comes off the address and asks first", async () => {
  const { answer } = await hostAnswers();
  const { prompt, claims } = setup(answer);
  const opened: Promise<string | undefined>[] = [];
  watchPairLinks(window, location, history, (code) => {
    opened.push(prompt.pair(code, "link"));
  });
  history.pushState(null, "", "https://relay.test/app");
  history.pushState(null, "", `https://relay.test/app#pair=${CODE}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  expect(location.href).toBe("https://relay.test/app");
  expect(opened.length).toBe(1);
  expect(title(prompt)).toBe("Pair a new machine from this link?");
  expect(claims).toEqual([]);

  // Any other fragment change is not a pairing link.
  history.pushState(null, "", "https://relay.test/app#settings");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(opened.length).toBe(1);

  press(prompt, "Cancel");
  expect(await opened[0]).toBeUndefined();
});
