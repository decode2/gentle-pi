import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only observer: no tools, commands, prompts, or model calls.
export default function (pi: ExtensionAPI): void {
	const record = (value: object) => appendFileSync(process.env.UM06A_TRACE!, `${JSON.stringify(value)}\n`);
	record({ phase: "factory" });
	pi.on("agent_start", () => record({ phase: "agent_start" }));
	pi.on("session_start", (_event, ctx) => {
		let tools: unknown;
		try { tools = pi.getAllTools().filter((tool) => tool.name === "ask_user_question").map((tool) => tool.name); }
		catch { tools = "inventory-unavailable"; }
		record({ phase: "session_start", mode: ctx.mode, tools });
	});
}
