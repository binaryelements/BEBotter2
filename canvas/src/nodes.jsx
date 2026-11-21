// How each kind of step looks on the canvas: one source handle per exit.
import { createContext, useContext, useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { EXITS, NAMES } from "./model.js";

// The people an Ask can go to, the wired exits, and the wire being dragged.
export const Ctx = createContext(null);

export const exitWords = (exit) => ({ next: "next", needs_person: "needs a person", new_message: "new message", time_up: "time up", no_answer: "no answer" })[exit] ?? exit;

export const duration = (minutes) =>
  minutes % 1440 === 0 ? `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}` : minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} min`;

function summary(d, people) {
  switch (d.type) {
    case "trigger": return d.trigger === "email" ? "on email" : "started by hand";
    case "ai": return d.instruction;
    case "wait": return duration(d.minutes) + (d.businessHours ? " · business hours" : "");
    case "ask": return (d.personId ? (people.find((p) => p.id === d.personId)?.name ?? "someone") + ": " : "") + d.question;
    default: return d.outcome;
  }
}

function StepNode({ id, data }) {
  const { people, wired, wiring } = useContext(Ctx);
  const exits = EXITS(data);
  const update = useUpdateNodeInternals();
  // handles move when results or choices change; tell React Flow
  useEffect(() => { update(id); }, [id, exits.join(), update]);
  const mine = wired.get(id) || new Set();
  const state = !wiring || wiring.source === id ? "" : wiring.targets.has(id) ? " can" : " cannot";
  return (
    <div className={"wf-node k-" + data.type + state}>
      {data.type === "trigger" ? null : <Handle type="target" position={Position.Left} id="in" />}
      <div className="wf-top"><span className="wf-kind">{NAMES[data.type]}</span><span className="wf-title">{data.label}</span></div>
      <div className="wf-sub">{summary(data, people)}</div>
      {exits.map((exit) => (
        <div key={exit} className={"wf-row" + (exit === "new_message" ? " quiet" : "")}>
          <span>{exitWords(exit)}</span>
          {/* an open exit hands the run to a person */}
          {mine.has(exit) || exit === "new_message" ? null : <em>a person</em>}
          <Handle type="source" position={Position.Right} id={exit} />
        </div>
      ))}
    </div>
  );
}

export const nodeTypes = { trigger: StepNode, ai: StepNode, wait: StepNode, ask: StepNode, end: StepNode };
