// Published versions of the workflow: restore one into the draft, then publish it again.
import { useEffect, useState } from "react";

export function Versions({ api, readOnly, restored, close }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api("GET", "versions").then(({ status, data }) => (status === 200 ? setList(data) : setError(data.error)));
  }, [api]);
  const restore = async (v) => {
    if (!confirm(`Put v${v.version} in the draft? Unsaved changes are lost.`)) return;
    const { status, data } = await api("POST", "restore", { version: v.version });
    if (status === 200) restored();
    else setError(data.error);
  };
  return (
    <div className="wf-form">
      <div className="wf-form-head"><h2>versions</h2><button className="be-btn sm" type="button" onClick={close} aria-label="close">×</button></div>
      {error ? <p className="hint warn">{error}</p> : null}
      {list === null && !error ? <p className="hint">loading…</p> : null}
      {list && !list.length ? <p className="hint">Nothing published yet.</p> : null}
      {(list || []).map((v) => (
        <div className="wf-version" key={v.version}>
          <div className="wf-version-head"><strong>v{v.version}</strong>{v.live ? <span className="be-chip g">live</span> : null}</div>
          <div className="hint">{new Date(v.publishedAt).toLocaleString()} · {v.publishedBy}</div>
          {readOnly ? null : <div><button className="be-btn sm" type="button" onClick={() => restore(v)}>restore</button></div>}
        </div>
      ))}
    </div>
  );
}
