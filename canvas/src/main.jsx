// Entry point: the canvas page calls WFCanvas.mount(el, init), as BE Voice's console calls BECanvas.mount.
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { Editor } from "./Editor.jsx";

window.WFCanvas = {
  // mount draws the editor in el and returns a function that removes it.
  mount(el, init) {
    const root = createRoot(el);
    root.render(<ReactFlowProvider><Editor init={init} /></ReactFlowProvider>);
    return () => root.unmount();
  },
};
