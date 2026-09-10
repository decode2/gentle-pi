import { join } from "node:path";

export type QuestionOwner = "legacy-external" | "gentle-pi" | "disabled";

export type QuestionOwnerResolution =
	| { allowRegistration: true; owner: "gentle-pi"; reason: "configured_gentle_pi" }
	| { allowRegistration: false; owner: "legacy-external" | "disabled"; reason: "configured_external" | "configured_disabled" }
	| { allowRegistration: false; reason: "missing" | "invalid_json" | "invalid_shape" | "invalid_keys" | "invalid_schema" | "invalid_owner" };

export function questionOwnerConfigPath(agentHome: string): string {
	return join(agentHome, "gentle-ai", "question-owner.json");
}

export function resolveQuestionOwner(raw: string | undefined): QuestionOwnerResolution {
	if (raw === undefined) return { allowRegistration: false, reason: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { allowRegistration: false, reason: "invalid_json" };
	}
	if (!record(parsed) || Array.isArray(parsed)) return { allowRegistration: false, reason: "invalid_shape" };
	const keys = Object.keys(parsed);
	if (keys.length !== 2 || !Object.hasOwn(parsed, "schema") || !Object.hasOwn(parsed, "owner")) {
		return { allowRegistration: false, reason: "invalid_keys" };
	}
	if (parsed.schema !== "gentle-pi.question-owner/v1") return { allowRegistration: false, reason: "invalid_schema" };
	switch (parsed.owner) {
		case "gentle-pi":
			return { allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi" };
		case "legacy-external":
			return { allowRegistration: false, owner: "legacy-external", reason: "configured_external" };
		case "disabled":
			return { allowRegistration: false, owner: "disabled", reason: "configured_disabled" };
		default:
			return { allowRegistration: false, reason: "invalid_owner" };
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
