/** What the relay says about a session token: accepted, refused, or no answer. */
export type SessionCheck = "valid" | "invalid" | "unknown";

/** Where and how to ask; production passes the page origin and `fetch`. */
export interface SessionCheckDeps {
  baseUrl: string;
  fetch: typeof fetch;
}

/**
 * Ask the relay whether it still accepts `token` (`GET /auth/session`). Only a
 * 401 is a refusal, and 200 or 204 an acceptance. Anything else gives no
 * answer and must not sign the device out: the network or the relay failed, or
 * the relay predates the route (405) or runs without sign-in (404).
 */
export async function checkSession(
  deps: SessionCheckDeps,
  token: string,
): Promise<SessionCheck> {
  let status: number;
  try {
    const res = await deps.fetch(`${deps.baseUrl}/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    status = res.status;
  } catch {
    return "unknown";
  }
  if (status === 401) return "invalid";
  return status === 200 || status === 204 ? "valid" : "unknown";
}
