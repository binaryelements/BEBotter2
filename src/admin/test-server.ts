import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { sessionKey, signSession } from "./session.js";

export function serve(app: Express): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      // PGlite blocks the event loop; after a >5s block fetch reused a socket the server's idle timer was closing (ECONNRESET).
      server.keepAliveTimeout = 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((e) => (e ? fail(e) : done()));
            server.closeAllConnections(); // fetch keeps connections alive
          }),
      });
    });
  });
}

/** A signed `bb_session` cookie for the given person, as the sign-in callback would set it. */
export const sessionCookie = (secretsKey: Buffer, tenantId: string, personId: string, csrf = "csrf-1") =>
  `bb_session=${signSession(sessionKey(secretsKey), { personId, tenantId, csrf, exp: Date.now() + 60_000 })}`;
