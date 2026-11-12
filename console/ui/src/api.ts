export type Me = { name: string; admin: boolean; headOf: string[]; company: string | null; csrf: string };
export type Notice = { id: string; kind: "approval" | "failure"; title: string; at: string; href: string };
export type Notifications = { approvals: number; failures: number; items: Notice[] };

export const API = "/admin/console/api";

/** Reads from the console API. Signed out: the browser goes to sign in and comes back here. */
export async function get<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (res.status === 401) {
    location.assign("/admin/auth/login?returnTo=/admin/console");
    return new Promise<T>(() => {});
  }
  if (!res.ok) throw new Error(res.status === 403 ? "This account has no access to the admin." : "The console could not be reached.");
  return res.json();
}
