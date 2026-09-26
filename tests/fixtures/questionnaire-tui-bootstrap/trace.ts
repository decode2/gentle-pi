import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only observer: no tools, commands, prompts, or model calls.
export default function (pi: ExtensionAPI): void {
	const record = (value: object) => appendFileSync(process.env.UM06A_TRACE!, `${JSON.stringify(value)}\n`);
	record({ phase: "factory" });
	pi.on("agent_start", () => record({ phase: "agent_start" }));
	pi.on("turn_start", () => record({ phase: "turn_start" }));
	const inventory = () => {
		try { return pi.getAllTools().filter((tool) => tool.name === "ask_user_question").map((tool) => tool.name); }
		catch { return "inventory-unavailable"; }
	};
	pi.on("session_start", (_event, ctx) => {
		record({ phase: "session_start", mode: ctx.mode, tools: inventory() });
		// Explicit CLI observers may run before discovered package handlers.
		if (process.env.UM06B_WAIT_PHASE === "post_session_start") {
			setTimeout(() => record({ phase: "post_session_start", tools: inventory() }), 1000);
		}
	});
}
