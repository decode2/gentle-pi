import assert from "node:assert/strict";
import test from "node:test";
import { readQuestionOwnerConfig } from "../lib/questions/owner-config.ts";

function config(owner: string): string {
	return JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner });
}

function errorWithCode(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

test("reads each supplied profile path in sequence and preserves pure-gate owner decisions", async () => {
	const firstHome = "/profiles/first";
	const secondHome = "/profiles/second";
	const calls: string[] = [];
	const outcomes: Array<string | Error> = [
		config("gentle-pi"),
		errorWithCode("ENOENT"),
		"{",
		config("legacy-external"),
		config("disabled"),
	];
	const readFile = async (path: string): Promise<string> => {
		calls.push(path);
		const outcome = outcomes.shift();
		if (outcome instanceof Error) throw outcome;
		assert.notEqual(outcome, undefined);
		return outcome;
	};

	assert.deepEqual(await readQuestionOwnerConfig(firstHome, readFile), {
		allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi",
		path: "/profiles/first/gentle-ai/question-owner.json",
	});
	assert.deepEqual(await readQuestionOwnerConfig(secondHome, readFile), {
		allowRegistration: false, reason: "missing",
		path: "/profiles/second/gentle-ai/question-owner.json",
	});
	assert.deepEqual(await readQuestionOwnerConfig(firstHome, readFile), {
		allowRegistration: false, reason: "invalid_json",
		path: "/profiles/first/gentle-ai/question-owner.json",
	});
	assert.deepEqual(await readQuestionOwnerConfig(secondHome, readFile), {
		allowRegistration: false, owner: "legacy-external", reason: "configured_external",
		path: "/profiles/second/gentle-ai/question-owner.json",
	});
	assert.deepEqual(await readQuestionOwnerConfig(firstHome, readFile), {
		allowRegistration: false, owner: "disabled", reason: "configured_disabled",
		path: "/profiles/first/gentle-ai/question-owner.json",
	});
	assert.deepEqual(calls, [
		"/profiles/first/gentle-ai/question-owner.json",
		"/profiles/second/gentle-ai/question-owner.json",
		"/profiles/first/gentle-ai/question-owner.json",
		"/profiles/second/gentle-ai/question-owner.json",
		"/profiles/first/gentle-ai/question-owner.json",
	]);
});

test("denies unreadable config as read_error while retaining the safe error code", async () => {
	for (const code of ["EACCES", "EISDIR"]) {
		assert.deepEqual(await readQuestionOwnerConfig("/profiles/locked", async () => {
			throw errorWithCode(code);
		}), {
			allowRegistration: false, reason: "read_error", errorCode: code,
			path: "/profiles/locked/gentle-ai/question-owner.json",
		});
	}
});

test("normalizes synchronous throws and asynchronous rejections without allowing registration", async () => {
	const readers = [
		() => { throw errorWithCode("EIO"); },
		async () => Promise.reject(new Error("unreadable")),
	];
	for (const readFile of readers) {
		assert.deepEqual(await readQuestionOwnerConfig("/profiles/failure", readFile), {
			allowRegistration: false, reason: "read_error",
			path: "/profiles/failure/gentle-ai/question-owner.json",
		});
	}
});

function hostileCodeGetter(): object {
	return Object.defineProperty({}, "code", {
		get() { throw new Error("secondary code getter"); },
	});
}

function hostileCodeProxy(trap: "has" | "get"): object {
	return new Proxy({}, {
		has() {
			if (trap === "has") throw new Error("secondary proxy has");
			return true;
		},
		get() {
			throw new Error("secondary proxy get");
		},
	});
}

test("denies hostile error-code inspection without leaking the thrown value", async () => {
	const readers = [
		() => { throw hostileCodeGetter(); },
		async () => Promise.reject(hostileCodeProxy("has")),
		async () => Promise.reject(hostileCodeProxy("get")),
	];
	for (const readFile of readers) {
		const result = await readQuestionOwnerConfig("/profiles/hostile", readFile);
		assert.deepEqual(result, {
			allowRegistration: false, reason: "read_error",
			path: "/profiles/hostile/gentle-ai/question-owner.json",
		});
	}
});
