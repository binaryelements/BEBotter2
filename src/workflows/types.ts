export type NodeBase = { id: string; label: string; x: number; y: number };
export type TriggerNode = NodeBase & { type: "trigger"; trigger: "email" | "manual"; fields?: string[] };
export type AiNode = NodeBase & { type: "ai"; instruction: string; success: string; results: { name: string; meaning: string }[]; saves?: string[] };
export type WaitNode = NodeBase & { type: "wait"; minutes: number; businessHours: boolean };
export type AskNode = NodeBase & { type: "ask"; question: string; choices: string[]; personId?: string; timeoutMinutes: number };
export type EndNode = NodeBase & { type: "end"; outcome: string };
export type WorkflowNode = TriggerNode | AiNode | WaitNode | AskNode | EndNode;
export type Edge = { from: string; exit: string; to: string };
export type WorkflowGraph = { nodes: WorkflowNode[]; edges: Edge[]; holidays: string[] };
export type RunEvent = { type: "email"; from: string; subject: string; messageId: string; threadId: string | null } | { type: "manual"; fields: Record<string, string> };
/** A queued event; `woke` is set once it has taken new_message so it never wakes a second wait; `inStep` once an AI step was given it (dropped when that step settles). */
export type QueuedEvent = RunEvent & { woke?: boolean; inStep?: boolean };
export type RunKeys = { threadIds: string[]; emails: string[]; domain: string | null };
export type ReportedResult = { result: string; reason: string; fields?: Record<string, string> };
