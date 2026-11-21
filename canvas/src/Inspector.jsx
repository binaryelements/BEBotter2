// The panel that edits the selected step.
import { useContext, useState } from "react";
import { Ctx } from "./nodes.jsx";
import { NAMES } from "./model.js";

const Field = ({ label, hint, children }) => <label className="wf-field">{label}{children}{hint ? <span className="hint">{hint}</span> : null}</label>;
const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

// A comma list keeps what is typed (a trailing comma included) and saves the parsed list.
function CommaField({ label, hint, value, set }) {
  const [text, setText] = useState((value || []).join(", "));
  return <Field label={label} hint={hint}><input className="be-input" value={text} onChange={(e) => { setText(e.target.value); set(list(e.target.value)); }} /></Field>;
}

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

function Results({ results, set }) {
  const at = (i, patch) => set(results.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="wf-field">results
      {results.map((r, i) => (
        <div className="wf-result" key={i}>
          <input className="be-input" placeholder="name" value={r.name} onChange={(e) => at(i, { name: e.target.value.trim() })} />
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
  const set = (patch) => change(node.id, { ...d, ...patch });
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
          <Field label="instruction"><textarea className="be-input" rows={5} {...text("instruction")} /></Field>
          <Field label="success test" hint="how the bot knows the step worked"><textarea className="be-input" rows={2} {...text("success")} /></Field>
          <Results results={d.results} set={(results) => set({ results })} />
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
          <Field label="question"><textarea className="be-input" rows={3} {...text("question")} /></Field>
          <CommaField label="choices" hint="comma separated" value={d.choices} set={(choices) => set({ choices })} />
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
