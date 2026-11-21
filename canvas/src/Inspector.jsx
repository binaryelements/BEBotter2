// The panel that edits the selected step.
import { useContext, useRef, useState } from "react";
import { Ctx } from "./nodes.jsx";
import { NAMES } from "./model.js";

const Field = ({ label, hint, children }) => <label className="wf-field">{label}{children}{hint ? <span className="hint">{hint}</span> : null}</label>;
const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

// Text that names an exit is committed on leaving the box or Enter, so its link isn't dropped on every keystroke.
const commitOn = (commit) => ({ onBlur: commit, onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } } });

// A comma list, committed as a parsed list.
function CommaField({ label, hint, value, set }) {
  const [text, setText] = useState((value || []).join(", "));
  return <Field label={label} hint={hint}><input className="be-input" value={text} onChange={(e) => setText(e.target.value)} {...commitOn(() => set(list(text)))} /></Field>;
}

// Same length means each choice was edited in place: its link follows the new name.
const renames = (old, next) => (old.length === next.length ? Object.fromEntries(old.flatMap((o, i) => (o !== next[i] ? [[o, next[i]]] : []))) : {});

// A length in hours or days, stored as minutes.
function Duration({ label, minutes, set }) {
  const [unit, setUnit] = useState(minutes % 1440 === 0 ? 1440 : 60);
  return (
    <Field label={label}>
      <span className="wf-inline">
        <input className="be-input" type="number" min="0" step="any" value={minutes / unit} onChange={(e) => set(Math.round(Number(e.target.value) * unit))} />
        <select className="be-select" value={unit} onChange={(e) => setUnit(Number(e.target.value))}><option value={60}>hours</option><option value={1440}>days</option></select>
      </span>
    </Field>
  );
}

// Long text grows with what's typed (up to half the screen) and opens in a large editor for anything longer.
function LongText({ label, hint, rows, value, onChange, readOnly }) {
  const dlg = useRef(null);
  return (
    <div className="wf-field">
      <span className="wf-field-head">{label}<button className="be-btn sm quiet" type="button" onClick={() => dlg.current?.showModal()}>expand</button></span>
      <textarea className="be-input wf-long" rows={rows} aria-label={label} value={value} onChange={onChange} />
      {hint ? <span className="hint">{hint}</span> : null}
      <dialog className="wf-dialog wf-editor" ref={dlg} onClick={(e) => { if (e.target === dlg.current) dlg.current.close(); }}>
        <div className="wf-editor-head"><h2>{label}</h2><button className="be-btn sm" type="button" onClick={() => dlg.current.close()}>done</button></div>
        <textarea className="be-input" aria-label={label} value={value} onChange={onChange} readOnly={readOnly} />
      </dialog>
    </div>
  );
}

function ResultName({ name, rename }) {
  const [text, setText] = useState(name);
  return <input className="be-input" placeholder="name" value={text} onChange={(e) => setText(e.target.value)} {...commitOn(() => { const next = text.trim(); setText(next); if (next !== name) rename(next); })} />;
}

function Results({ results, set }) {
  const at = (i, patch, renamed) => set(results.map((r, j) => (j === i ? { ...r, ...patch } : r)), renamed);
  return (
    <div className="wf-field">results
      {results.map((r, i) => (
        <div className="wf-result" key={`${i}:${results.length}`}>
          <ResultName name={r.name} rename={(name) => at(i, { name }, { [r.name]: name })} />
          <input className="be-input" placeholder="meaning" value={r.meaning} onChange={(e) => at(i, { meaning: e.target.value })} />
          <button className="be-btn sm" type="button" aria-label="remove result" onClick={() => set(results.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <span><button className="be-btn sm" type="button" onClick={() => set([...results, { name: "", meaning: "" }])}>add result</button></span>
    </div>
  );
}

export function Inspector({ node, change, remove, readOnly }) {
  const { people } = useContext(Ctx);
  if (!node) return <div className="wf-empty"><p className="hint">{readOnly ? "Select a step to see it." : "Drag a step in, link exits to steps, select a step to edit it. An exit left open goes to a person."}</p></div>;
  const d = node.data;
  const set = (patch, renamed) => change(node.id, { ...d, ...patch }, renamed);
  const text = (key) => ({ value: d[key] ?? "", onChange: (e) => set({ [key]: e.target.value }) });
  return (
    <fieldset className="wf-form" disabled={readOnly} key={node.id}>
      <div className="wf-form-head"><h2>{NAMES[d.type]}</h2></div>
      <Field label="label"><input className="be-input" {...text("label")} /></Field>
      {d.type === "trigger" ? (
        <Field label="starts on">
          <select className="be-select" {...text("trigger")}><option value="email">email</option><option value="manual">by hand</option></select>
        </Field>
      ) : null}
      {d.type === "ai" ? (
        <>
          <LongText label="instruction" rows={5} readOnly={readOnly} {...text("instruction")} />
          <LongText label="success test" hint="how the bot knows the step worked" rows={2} readOnly={readOnly} {...text("success")} />
          <Results results={d.results} set={(results, renamed) => set({ results }, renamed)} />
          <CommaField label="saved fields" hint="comma separated" value={d.saves} set={(saves) => set({ saves: saves.length ? saves : undefined })} />
        </>
      ) : null}
      {d.type === "wait" ? (
        <>
          <Duration label="wait" minutes={d.minutes} set={(minutes) => set({ minutes })} />
          <label className="be-toggle"><input type="checkbox" checked={d.businessHours} onChange={(e) => set({ businessHours: e.target.checked })} /> business hours</label>
        </>
      ) : null}
      {d.type === "ask" ? (
        <>
          <LongText label="question" rows={3} readOnly={readOnly} {...text("question")} />
          <CommaField label="choices" hint="comma separated" value={d.choices} set={(choices) => set({ choices }, renames(d.choices, choices))} />
          <Field label="person">
            <select className="be-select" value={d.personId ?? ""} onChange={(e) => set({ personId: e.target.value || undefined })}>
              <option value="">the bot's chat</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Duration label="timeout" minutes={d.timeoutMinutes} set={(timeoutMinutes) => set({ timeoutMinutes })} />
        </>
      ) : null}
      {d.type === "end" ? <Field label="outcome"><input className="be-input" {...text("outcome")} /></Field> : null}
      {readOnly ? null : <div className="wf-danger"><button className="be-btn sm danger" type="button" onClick={() => remove(node.id)}>remove</button></div>}
    </fieldset>
  );
}
