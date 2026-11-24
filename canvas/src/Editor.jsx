// The workflow canvas: drop steps from the palette, link exits to steps, edit a step in the inspector,
// save the draft, publish it. Shell copied from BE Voice's routing canvas.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, useReactFlow, useNodesInitialized } from "@xyflow/react";
import { EXITS, NAMES, graphProblems, newNode, openExits, relink, tidy, toFlow, toGraph, whyNot } from "./model.js";
import { Ctx, nodeTypes } from "./nodes.jsx";
import { Inspector } from "./Inspector.jsx";
import { Versions } from "./Versions.jsx";

const PALETTE = ["trigger", "ai", "wait", "ask", "end"];
const edgeOf = (c) => ({ id: `${c.source}:${c.sourceHandle}`, source: c.source, sourceHandle: c.sourceHandle, target: c.target });
const others = (edges, c) => edges.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle));

export function Editor({ init }) {
  const { readOnly } = init;
  const start = useMemo(() => toFlow(init.draft), [init]);
  const [nodes, setNodes, onNodesChange] = useNodesState(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(start.edges);
  const [selected, setSelected] = useState(null);
  const [base, setBase] = useState(init.base); // the server's hash of the draft this canvas started from; never hashed here
  const [saved, setSaved] = useState(() => JSON.stringify(toGraph(start.nodes, start.edges, init.draft.holidays)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // [kind, text] shown in the bar
  const [versions, setVersions] = useState(false);
  const [stranded, setStranded] = useState(null); // publish asked where runs on removed steps go
  const [wiring, setWiring] = useState(null);
  const flow = useReactFlow();
  // show the whole graph once every node has been measured
  const measured = useNodesInitialized();
  const [fitted, setFitted] = useState(start.nodes.length === 0); // a new, empty workflow has nothing to fit
  useEffect(() => {
    if (!measured || fitted) return;
    setFitted(true);
    flow.fitView({ padding: 0.08, maxZoom: 1 });
  }, [measured, fitted, flow]);

  const graph = useMemo(() => toGraph(nodes, edges, init.draft.holidays), [nodes, edges, init]);
  const dirty = JSON.stringify(graph) !== saved;
  const open = useMemo(() => openExits(graph).length, [graph]);
  // the same checks the server runs at publish, shown here before anything is sent
  const problems = useMemo(() => (readOnly ? [] : graphProblems(graph)), [graph, readOnly]);
  const [showProblems, setShowProblems] = useState(false);
  const badSteps = useMemo(() => new Map(problems.filter((p) => p.nodeId).map((p) => [p.nodeId, true])), [problems]);
  const pick = (id) => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  // leaving with an unsaved draft asks first, unless the page reloads on purpose
  const leaving = useRef(false);
  const reload = () => { leaving.current = true; location.reload(); };
  useEffect(() => {
    const warn = (e) => { if (dirty && !leaving.current) e.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const api = useCallback(async (method, path, body) => {
    const r = await fetch(`/admin/workflows/${init.workflowId}/${path}`, {
      method, credentials: "same-origin",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ csrf: init.csrf, ...body }) } : {}),
    }).catch(() => null);
    if (!r) return { status: 0, data: { error: "no connection; try again" } };
    // a redirect or an HTML page (a lost session, a refused token) is a failure, whatever its status
    const json = !r.redirected && (r.headers.get("content-type") || "").includes("application/json");
    const data = json ? await r.json().catch(() => null) : null;
    return { status: data ? r.status : 0, data: data && (r.ok || data.error || data.stranded) ? data : { error: "something went wrong; reload" } };
  }, [init]);

  // a handle leads to one place: a new link replaces the old one
  const valid = useCallback((c) => !whyNot(c, nodes, others(edges, c)), [nodes, edges]);
  const onConnect = useCallback((c) => setEdges((es) => [...others(es, c), edgeOf(c)]), [setEdges]);
  const onConnectStart = useCallback((_, from) => {
    if (from.handleType !== "source") return;
    setWiring({ source: from.nodeId, targets: new Set(nodes.filter((n) => valid({ source: from.nodeId, sourceHandle: from.handleId, target: n.id })).map((n) => n.id)) });
  }, [nodes, valid]);
  const onSelectionChange = useCallback(({ nodes: sel }) => setSelected(sel.length === 1 ? sel[0].id : null), []);

  const add = (type, position) => {
    const n = newNode(type, position);
    setNodes((ns) => [...ns.map((x) => (x.selected ? { ...x, selected: false } : x)), { id: n.id, type, position, data: n, selected: true }]);
  };
  const onDrop = (e) => {
    const type = e.dataTransfer.getData("application/wf-step");
    if (!type) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    add(type, { x: p.x - 100, y: p.y - 26 });
  };
  const addCentre = (type) => {
    const el = document.querySelector(".wf-flow").getBoundingClientRect();
    const p = flow.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 });
    add(type, { x: p.x - 100 + Math.random() * 40, y: p.y - 26 + Math.random() * 40 });
  };

  // change edits one step; links follow renamed exits and go with removed ones
  const change = useCallback((id, data, renamed) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data } : n)));
    setEdges((es) => relink(es, id, EXITS(data), renamed));
  }, [setNodes, setEdges]);
  const remove = useCallback((id) => flow.deleteElements({ nodes: [{ id }] }), [flow]);

  const save = async () => {
    setBusy(true);
    const { status, data } = await api("POST", "draft", { graph, base });
    setBusy(false);
    if (status !== 200) { setNote(["bad", data.error]); return false; }
    setBase(data.base);
    setSaved(JSON.stringify(graph));
    setNote(["good", "saved"]);
    return data.base;
  };
  const publish = async (moves = {}) => {
    if (problems.length) { setShowProblems(true); setNote(["bad", "fix these before publishing"]); return; }
    let current = base; // setBase is not applied yet after a save, so take the saved hash directly
    if (dirty) { current = await save(); if (!current) return; }
    setBusy(true);
    const { status, data } = await api("POST", "publish", { moves, base: current });
    setBusy(false);
    if (status === 409 && data.stranded) { setStranded({ list: data.stranded, moves: Object.fromEntries(data.stranded.map((s) => [s.nodeId, "needs_person"])) }); return; }
    setStranded(null);
    setNote(status === 200 ? ["good", `published v${data.version}`] : ["bad", data.error]);
  };
  // fit after the moved nodes have rendered
  const tidyUp = () => { setNodes((ns) => tidy(ns, edges)); requestAnimationFrame(() => flow.fitView({ padding: 0.08, maxZoom: 1, duration: 300 })); };
  const discard = async () => {
    if (!confirm("Discard the draft? The canvas goes back to what is live.")) return;
    const { status, data } = await api("POST", "discard", { base });
    if (status === 200) reload(); else setNote(["bad", data.error]);
  };

  const wired = useMemo(() => {
    const m = new Map();
    for (const e of edges) m.set(e.source, (m.get(e.source) || new Set()).add(e.sourceHandle));
    return m;
  }, [edges]);
  // node id -> its places on the traced path, numbered in order
  const trace = useMemo(() => {
    if (!init.trace) return null;
    const m = new Map();
    init.trace.steps.forEach((s, i) => m.set(s.nodeId, [...(m.get(s.nodeId) || []), { no: i + 1, ...s }]));
    return m;
  }, [init]);
  const ctx = useMemo(() => ({ people: init.people, wired, wiring, trace, badSteps }), [init, wired, wiring, trace, badSteps]);
  const node = nodes.find((n) => n.id === selected) || null;
  const theme = document.documentElement.dataset.theme || "system";

  return (
    <Ctx.Provider value={ctx}>
      <div className={"wf" + (readOnly ? " ro" : "") + (node || versions ? " has-sel" : "")}>
        <div className="wf-bar">
          <span className={"wf-pill" + (dirty ? " dirty" : "")}>{dirty ? "not saved" : "saved"}</span>
          {open ? <span className="hint">{open} open {open === 1 ? "exit goes" : "exits go"} to a person</span> : null}
          {problems.length ? <button className={"be-btn sm wf-fix" + (showProblems ? " on" : "")} type="button" onClick={() => setShowProblems(!showProblems)}>{problems.length} to fix</button> : null}
          {note ? <span className={"wf-note " + note[0]} role="status">{note[1]}</span> : null}
          {init.trace ? <span className="wf-pill">tracing {init.trace.title}</span> : null}
          {init.trace ? <button className="be-btn sm" type="button" onClick={() => { leaving.current = true; location.href = location.pathname; }}>stop</button> : null}
          <span className="wf-spacer" />
          <button className={"be-btn sm" + (versions ? " on" : "")} type="button" onClick={() => setVersions(!versions)}>versions</button>
          {readOnly ? null : (
            <>
              <button className="be-btn sm" type="button" disabled={busy || !nodes.length} onClick={tidyUp} title="Arrange the steps left to right">tidy</button>
              <button className="be-btn sm" type="button" disabled={busy} onClick={discard}>discard</button>
              <button className="be-btn sm" type="button" disabled={busy || !dirty} onClick={save}>save</button>
              <button className="be-btn sm primary" type="button" disabled={busy} onClick={() => publish()}>publish</button>
            </>
          )}
        </div>
        {readOnly ? null : (
          <aside className="wf-palette" aria-label="add a step">
            {PALETTE.map((type) => (
              <button key={type} type="button" className={"wf-chip k-" + type} draggable
                onDragStart={(e) => { e.dataTransfer.setData("application/wf-step", type); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => addCentre(type)}>
                <i />{NAMES[type]}
              </button>
            ))}
          </aside>
        )}
        {showProblems && problems.length ? (
          <ul className="wf-problems" aria-label="to fix">
            {problems.map((p, i) => <li key={i}>{p.nodeId ? <button type="button" className="wf-link" onClick={() => pick(p.nodeId)}>{p.message}</button> : p.message}</li>)}
          </ul>
        ) : null}
        <div className="wf-flow">
          <ReactFlow proOptions={{ hideAttribution: true }} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={valid} onConnectStart={onConnectStart} onConnectEnd={() => setWiring(null)} onSelectionChange={onSelectionChange}
            onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            minZoom={0.2} maxZoom={1.6} colorMode={theme} connectionRadius={28}>
            <Background gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="wf-minimap" style={{ width: 130, height: 84 }} />
          </ReactFlow>
          {stranded ? (
            <div className="wf-dialog" role="dialog" aria-modal="true" aria-labelledby="wf-stranded">
              <h2 id="wf-stranded">runs on removed steps</h2>
              <p className="hint">Choose where each one goes.</p>
              {stranded.list.map((s) => (
                <label className="wf-field" key={s.nodeId}>{s.label} · {s.runs} {s.runs === 1 ? "run" : "runs"}
                  <select className="be-select" value={stranded.moves[s.nodeId]} onChange={(e) => setStranded({ ...stranded, moves: { ...stranded.moves, [s.nodeId]: e.target.value } })}>
                    <option value="needs_person">a person</option>
                    {nodes.filter((n) => n.type !== "trigger").map((n) => <option key={n.id} value={n.id}>{n.data.label}</option>)}
                  </select>
                </label>
              ))}
              <div className="wf-inline">
                <button className="be-btn sm primary" type="button" disabled={busy} onClick={() => publish(stranded.moves)}>move and publish</button>
                <button className="be-btn sm" type="button" onClick={() => setStranded(null)}>cancel</button>
              </div>
            </div>
          ) : null}
        </div>
        <aside className="wf-inspector">
          {trace && node && trace.get(node.id) ? (
            <div className="wf-trace">
              {trace.get(node.id).map((h) => <p key={h.no}><b>{h.no}</b> {h.result ?? "still here"}{h.reason ? <span className="hint"> {h.reason}</span> : null}</p>)}
            </div>
          ) : null}
          {versions
            ? <Versions api={api} base={base} readOnly={readOnly} restored={reload} close={() => setVersions(false)} />
            : <Inspector problems={node ? problems.filter((p) => p.nodeId === node.id) : []} node={node} change={change} remove={remove} readOnly={readOnly} />}
        </aside>
      </div>
    </Ctx.Provider>
  );
}
