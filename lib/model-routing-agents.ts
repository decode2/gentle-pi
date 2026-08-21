import type { AgentSource } from "./model-routing-authority.ts";

export interface AgentEntry { name: string; source: AgentSource; filePath?: string }
export type ModelRoutingAgentDiscovery = (cwd: string, agentDir: string) => readonly AgentEntry[] | Promise<readonly AgentEntry[]>;
