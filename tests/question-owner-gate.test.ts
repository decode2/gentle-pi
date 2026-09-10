import assert from "node:assert/strict";
import test from "node:test";
import {
	questionOwnerConfigPath, resolveQuestionOwner,
} from "../lib/questions/owner-gate.ts";

function config(owner: string, schema = "gentle-pi.question-owner/v1"): string {
	return JSON.stringify({ schema, owner });
}

test("permits only the valid gentle-pi owner", () => {
	assert.deepEqual(resolveQuestionOwner(config("gentle-pi")), {
		allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi",
	});
	assert.deepEqual(resolveQuestionOwner(config("legacy-external")), {
		allowRegistration: false, owner: "legacy-external", reason: "configured_external",
	});
	assert.deepEqual(resolveQuestionOwner(config("disabled")), {
		allowRegistration: false, owner: "disabled", reason: "configured_disabled",
	});
});

test("denies absent configuration without assigning an external owner", () => {
	assert.deepEqual(resolveQuestionOwner(undefined), { allowRegistration: false, reason: "missing" });
});

test("distinguishes malformed JSON from non-object configuration", () => {
	assert.deepEqual(resolveQuestionOwner("{"), { allowRegistration: false, reason: "invalid_json" });
	for (const raw of ["null", "[]", "true", '"owner"']) {
		assert.deepEqual(resolveQuestionOwner(raw), { allowRegistration: false, reason: "invalid_shape" }, raw);
	}
});

test("rejects a wrong schema and unknown owner", () => {
	assert.deepEqual(resolveQuestionOwner(config("gentle-pi", "gentle-pi.question-owner/v2")), {
		allowRegistration: false, reason: "invalid_schema",
	});
	assert.deepEqual(resolveQuestionOwner(config("external-rpiv")), {
		allowRegistration: false, reason: "invalid_owner",
	});
});

test("rejects extra JSON own keys, including __proto__", () => {
	assert.deepEqual(resolveQuestionOwner('{"schema":"gentle-pi.question-owner/v1","owner":"gentle-pi","extra":true}'), {
		allowRegistration: false, reason: "invalid_keys",
	});
	assert.deepEqual(resolveQuestionOwner('{"schema":"gentle-pi.question-owner/v1","owner":"gentle-pi","__proto__":{}}'), {
		allowRegistration: false, reason: "invalid_keys",
	});
});

test("derives each profile's configuration path without filesystem access", () => {
	const first = questionOwnerConfigPath("/profiles/first");
	const second = questionOwnerConfigPath("/profiles/second");
	assert.equal(first, "/profiles/first/gentle-ai/question-owner.json");
	assert.equal(second, "/profiles/second/gentle-ai/question-owner.json");
	assert.notEqual(first, second);
});
