import { useEffect, useState } from "react";
import markCyan from "../../../src/admin/assets/be/be-mark-cyan.png";
import markRed from "../../../src/admin/assets/be/be-mark-red.png";
import { API, get, type Me, type Notice, type Notifications } from "./api";

// The menu, icons and markup follow layout() in src/admin/html.ts so both admins look the same.
// A page that has moved here gets a route; the rest open the current page.
const groups = [
  {
    name: "Operate",
    items: [
      { label: "Dashboard", path: "overview", head: true, icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
      { label: "Bots", path: "bots", head: false, icon: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M9 12h.01M15 12h.01"/>' },
      { label: "Personal assistants", path: "assistants", head: false, icon: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/>' },
      { label: "To-dos", path: "todos", head: false, icon: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>' },
      { label: "People", path: "people", head: true, icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>' },
      { label: "Connections", path: "connections", head: false, icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' },
      { label: "Runbooks", path: "runbooks", head: true, icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
      { label: "Shared notes", path: "knowledge", head: true, icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>' },
    ],
  },
  {
    name: "Configure",
    items: [
      { label: "Assignments", path: "assignments", head: false, icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
      { label: "Departments", path: "departments", head: true, icon: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01"/>' },
      { label: "Settings", path: "settings", head: false, icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
    ],
  },
  { name: "Audit", items: [{ label: "Activity", path: "activity", head: true, icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' }] },
];

const themes = {
  device: { label: "follow device", icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
  light: { label: "light", icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  dark: { label: "dark", icon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>' },
};
type Theme = keyof typeof themes;

/** A line icon in the text colour; `d` is one of the fixed strings in this file, never data. */
const Icon = ({ d, size = 16, join = true }: { d: string; size?: number; join?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin={join ? "round" : undefined} aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />
);

const ago = (at: string, now: number) => {
  const m = Math.round((now - Date.parse(at)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function NoticeRow({ item, now }: { item: Notice; now: number }) {
  const failed = item.kind === "failure";
  return (
    <a className="panel-item" href={item.href}>
      <div className={`ico ${failed ? "bad" : "warn"}`}>
        <Icon size={14} join={false} d={failed ? '<path d="M18 6 6 18M6 6l12 12"/>' : '<path d="M12 8v4M12 16h.01"/><circle cx="12" cy="12" r="9"/>'} />
      </div>
      <div className="grow">
        <b>{item.title}</b>
        <div className="meta">{failed ? "failed" : "waiting for approval"} · {ago(item.at, now)}</div>
      </div>
    </a>
  );
}

const Notices = ({ items, now }: { items: Notice[]; now: number }) =>
  items.length ? items.map((item) => <NoticeRow key={item.id} item={item} now={now} />) : <div className="panel-empty">Nothing needs attention.</div>;

export function App() {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Notifications>({ approvals: 0, failures: 0, items: [] });
  const [now, setNow] = useState(Date.now());
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme | undefined) ?? "device");

  useEffect(() => {
    get<Me>("/me").then(setMe, (e: Error) => setError(e.message));
    // the server says when something needs attention; nothing here reloads the page
    const events = new EventSource(`${API}/events`);
    events.addEventListener("notifications", (e) => {
      setNotes(JSON.parse(e.data));
      setNow(Date.now());
    });
    // a refused stream stays closed: ask who we are, which sends a signed-out browser to sign in
    events.onerror = () => void (events.readyState === EventSource.CLOSED && get<Me>("/me").catch(() => {}));
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      const search = document.querySelector<HTMLInputElement>(".search input");
      if (!search) return;
      e.preventDefault();
      search.focus();
      search.select();
    };
    document.addEventListener("keydown", key);
    return () => {
      events.close();
      clearInterval(clock);
      document.removeEventListener("keydown", key);
    };
  }, []);

  // the same cookie the current pages read (/admin/theme), so the choice follows you between the two
  const setTheme = (t: Theme) => {
    document.cookie = t === "device" ? "theme=; Path=/admin; Max-Age=0; SameSite=Lax" : `theme=${t}; Path=/admin; Max-Age=31536000; SameSite=Lax`;
    if (t === "device") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    setThemeState(t);
  };

  if (error)
    return (
      <div className="app signed-out">
        <div className="main">
          <main className="content">
            <div className="be-notice bad"><span>{error}</span></div>
            <p><a className="be-btn" href="/admin">back to the admin</a></p>
          </main>
        </div>
      </div>
    );
  if (!me) return null;

  const count = notes.approvals + notes.failures;
  const initials = me.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const menu = groups.map((g) => ({ ...g, items: g.items.filter((s) => me.admin || s.head) })).filter((g) => g.items.length);

  return (
    <>
      <input type="checkbox" id="nav-open" className="nav-open" aria-label="menu" />
      <div className="app">
        <aside className="sidebar">
          <a className="brand" href="/admin/console/">
            <img className="be-mark-dark" src={markCyan} alt="" />
            <img className="be-mark-light" src={markRed} alt="" />
            <span>TEAMMATE<span className="by">by Binary Elements</span></span>
          </a>
          <nav className="be-nav nav" aria-label="admin">
            {menu.map((g) => (
              <div className="nav-group" key={g.name}>
                <div className="nav-label nh">{g.name}</div>
                {g.items.map((s) => (
                  <a className="nav-item" href={`/admin/${s.path}`} key={s.path}><Icon d={s.icon} />{s.label}</a>
                ))}
              </div>
            ))}
          </nav>
          <div className="spacer" />
          <div className="user">
            <div className="avatar">{initials}</div>
            <div className="whoami"><b>{me.name}</b><span>{me.admin ? "admin" : "head"}{me.company ? ` · ${me.company}` : ""}</span></div>
            <form method="post" action="/admin/auth/logout">
              <input type="hidden" name="csrf" value={me.csrf} />
              <button className="out" type="submit" aria-label="sign out" title="sign out"><Icon size={15} d='<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>' /></button>
            </form>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <label htmlFor="nav-open" className="icon-btn burger" title="menu" aria-label="menu"><Icon size={17} join={false} d='<path d="M4 6h16M4 12h16M4 18h16"/>' /></label>
            <div className="crumb">{me.company && <><span>{me.company}</span><span className="sep">/</span></>}<b>Console</b></div>
            <form className="search" method="get" action="/admin/activity" role="search">
              <Icon size={15} join={false} d='<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>' />
              <input type="search" name="q" placeholder="Search activity…" aria-label="Search activity" />
              <kbd>⌘K</kbd>
            </form>
            <details className="notif">
              <summary className="icon-btn" aria-label="Notifications" title="Notifications">
                <Icon size={17} d='<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>' />
                {count > 0 && <span className="dot" />}
              </summary>
              <div className="panel">
                <div className="panel-head">
                  <b>Notifications</b>
                  {count > 0 && <span className="be-chip bad">{count} new</span>}
                  <a className="be-btn sm quiet" href="/admin/activity">All activity</a>
                </div>
                <div className="panel-list"><Notices items={notes.items} now={now} /></div>
              </div>
            </details>
            <div className="theme" role="group" aria-label="theme">
              {(Object.keys(themes) as Theme[]).map((t) => (
                <button className="be-btn sm icon" type="button" key={t} aria-label={themes[t].label} title={themes[t].label} aria-pressed={theme === t} onClick={() => setTheme(t)}><Icon d={themes[t].icon} /></button>
              ))}
            </div>
          </header>
          <main className="content">
            <header className="be-pagehead">
              <div className="pt">
                <h1>Console</h1>
                <p className="meta">The new admin, running beside the current one. Pages move here one at a time; until then the menu opens the current page.</p>
              </div>
            </header>
            <section className="be-card">
              <h2>Needs attention</h2>
              <Notices items={notes.items} now={now} />
            </section>
          </main>
        </div>
      </div>
    </>
  );
}
