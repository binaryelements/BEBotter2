import { setTimeout as delay } from "node:timers/promises";

const BASE = "https://graph.microsoft.com/v1.0";
const MAX_WAIT_MS = 10_000;

/** A failed Graph call: its status and Graph's error code only. Messages reach logs, so never the token, headers or bodies. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Microsoft Graph ${status} ${code}`);
    this.name = "GraphError";
  }
}

/** token: asked for on every call, so a warm engine always acts with the turn running now. */
export type GraphDeps = { fetchFn: typeof fetch; token: () => Promise<string | undefined>; sleep?: (ms: number) => Promise<void> };
type Init = { method?: string; json?: unknown; body?: string; headers?: Record<string, string> };

const errorCode = async (res: Response): Promise<string> => {
  try {
    const code = ((await res.json()) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
};

/** A Graph request as the person; resolves only with an ok response. No token is a 401, like an expired one. */
export async function graphFetch(deps: GraphDeps, path: string, init: Init = {}): Promise<Response> {
  const token = await deps.token();
  if (!token) throw new GraphError(401, "NoToken");
  const json = init.json !== undefined;
  const send = () =>
    deps.fetchFn(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}), ...init.headers },
      ...(json ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
    });
  let res = await send();
  // a 401 is never retried: within a turn the token service may hand back the same token
  if (res.status === 429 || res.status === 503) {
    await res.body?.cancel();
    // shortcut: one retry and at most 10 s of waiting, so a longer Retry-After fails the call; queue calls if throttling becomes common
    const wait = Math.min(Math.max(Number(res.headers.get("Retry-After")) * 1000 || 1000, 0), MAX_WAIT_MS);
    await (deps.sleep ?? delay)(wait);
    res = await send();
  }
  if (!res.ok) throw new GraphError(res.status, await errorCode(res));
  return res;
}
