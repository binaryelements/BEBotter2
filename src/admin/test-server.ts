import type { Express } from "express";
import type { AddressInfo } from "node:net";

export function serve(app: Express): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
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
