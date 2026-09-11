import assert from "node:assert/strict";
import test from "node:test";
import {
	QUESTIONNAIRE_I18N_NAMESPACE,
	createQuestionnaireLocalizer,
} from "../lib/questions/localization.ts";

const callerUrl = "file:///gentle-pi/extensions/ask-user-question.ts";

function loader(trace: string[], register: () => unknown = () => {}): unknown {
	return { registerLocalesFromDir: () => { trace.push("register"); return register(); } };
}

function provider(trace: string[], translate: () => unknown): unknown {
	return { scope: () => { trace.push("scope"); return () => { trace.push("translate"); return translate(); }; } };
}

async function fallback(trace: string[], options: Parameters<typeof createQuestionnaireLocalizer>[0], expected: string[]): Promise<void> {
	const localize = await createQuestionnaireLocalizer(options);
	assert.equal(localize("chrome.primary.next", "Next"), "Next");
	assert.deepEqual(trace, expected);
}

test("keeps incomplete bridge options on the intentional identity path", async () => {
	for (const [withProvider, withLoader] of [[true, false], [false, true], [true, true]]) {
		let loads = 0;
		const localize = await createQuestionnaireLocalizer({
			...(withProvider ? { loadProvider: async () => { loads++; return {}; } } : {}),
			...(withLoader ? { loadLoader: async () => { loads++; return {}; } } : {}),
		});
		assert.equal(localize("chrome.primary.next", "Next"), "Next");
		assert.equal(loads, 0, "missing packageUrl prevents optional loading");
	}
});

test("uses the injected provider and loader with the first-party namespace on every lookup", async () => {
	let language = "de";
	const scopedNamespaces: string[] = [];
	const registrations: unknown[][] = [];
	const lookups: Array<[string, string]> = [];
	const localize = await createQuestionnaireLocalizer({
		packageUrl: callerUrl,
		loadProvider: async () => ({
			scope: (namespace: string) => {
				scopedNamespaces.push(namespace);
				return (key: string, fallback: string) => {
					lookups.push([key, fallback]);
					return language === "de" && key === "chrome.primary.next" ? "Weiter" : fallback;
				};
			},
		}),
		loadLoader: async () => ({ registerLocalesFromDir: (...args: unknown[]) => registrations.push(args) }),
	});

	assert.equal(localize("chrome.primary.next", "Next"), "Weiter");
	language = "en";
	assert.equal(localize("chrome.primary.next", "Next"), "Next");
	assert.deepEqual(registrations, [[QUESTIONNAIRE_I18N_NAMESPACE, callerUrl]]);
	assert.deepEqual(scopedNamespaces, [QUESTIONNAIRE_I18N_NAMESPACE, QUESTIONNAIRE_I18N_NAMESPACE]);
	assert.deepEqual(lookups, [["chrome.primary.next", "Next"], ["chrome.primary.next", "Next"]]);
});

test("reaches each optional bridge failure site before falling back", async () => {
	const cases = [
		["provider rejection", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); throw new Error("provider"); },
			loadLoader: async () => { trace.push("loader"); return loader(trace); },
		}), ["provider", "loader"]],
		["loader rejection", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return provider(trace, () => "Weiter"); },
			loadLoader: async () => { trace.push("loader"); throw new Error("loader"); },
		}), ["provider", "loader"]],
		["malformed provider", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return {}; },
			loadLoader: async () => { trace.push("loader"); return loader(trace); },
		}), ["provider", "loader"]],
		["scope getter", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return { get scope() { trace.push("scope getter"); throw new Error("scope getter"); } }; },
			loadLoader: async () => { trace.push("loader"); return loader(trace); },
		}), ["provider", "loader", "scope getter"]],
		["registration rejection", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return provider(trace, () => "Weiter"); },
			loadLoader: async () => { trace.push("loader"); return loader(trace, async () => { throw new Error("register"); }); },
		}), ["provider", "loader", "register"]],
		["scope throw", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return { scope: () => { trace.push("scope"); throw new Error("scope"); } }; },
			loadLoader: async () => { trace.push("loader"); return loader(trace); },
		}), ["provider", "loader", "register", "scope"]],
		["translation throw", (trace: string[]) => ({
			packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return provider(trace, () => { throw new Error("translate"); }); },
			loadLoader: async () => { trace.push("loader"); return loader(trace); },
		}), ["provider", "loader", "register", "scope", "translate"]],
	];
	for (const [name, build, expected] of cases) {
		const trace: string[] = [];
		await fallback(trace, build(trace), expected);
	}
	for (const value of [42, "   ", "", "chrome.primary.next"]) {
		const trace: string[] = [];
		await fallback(trace, { packageUrl: callerUrl, loadProvider: async () => { trace.push("provider"); return provider(trace, () => value); }, loadLoader: async () => { trace.push("loader"); return loader(trace); } }, ["provider", "loader", "register", "scope", "translate"]);
	}
});
