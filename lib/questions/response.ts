import type {
	FrozenQuestionnaireRequest, QuestionAnswer, QuestionnaireFailure, QuestionnaireResult,
	QuestionnaireToolResult, RawQuestionAnswer,
} from "./contract.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
const ANSWERED_PREFIX = "User has answered your questions:";
const ANSWERED_SUFFIX = "You can now continue with the user's answers in mind.";

export type FormatResult =
	| { ok: true; result: QuestionnaireToolResult }
	| { ok: false; failure: QuestionnaireFailure; result: QuestionnaireToolResult };

export function validateAndFormat(request: FrozenQuestionnaireRequest, outcome: unknown): FormatResult {
	const answers = validateOutcome(request, outcome);
	if (!answers) return failed();
	const globalNote = answers.globalNote || undefined;
	const result = details(answers.cancelled, answers.answers, globalNote);
	if (answers.cancelled) return { ok: true, result: toolResult(DECLINE_MESSAGE, result) };
	const segments = request.questions.flatMap((question, index) => {
		const answer = answers.answers.find((candidate) => candidate.questionIndex === index);
		return answer ? [segment(answer)] : [];
	});
	if (globalNote !== undefined) segments.push(`global note: ${globalNote}.`);
	if (segments.length === 0) return { ok: true, result: toolResult(DECLINE_MESSAGE, details(true, answers.answers)) };
	return { ok: true, result: toolResult(`${ANSWERED_PREFIX} ${segments.join(" ")} ${ANSWERED_SUFFIX}`, result) };
}

type ValidRawAnswer = Record<string, unknown> & {
	questionIndex: number;
	question: string;
	kind: QuestionAnswer["kind"];
	answer: string | null;
	notes?: string;
	preview?: string;
	selected?: unknown;
};

function validateOutcome(request: FrozenQuestionnaireRequest, value: unknown): { cancelled: boolean; answers: QuestionAnswer[]; globalNote?: string } | undefined {
	if (!exactRecord(value, ["correlationId", "answers", "cancelled", "globalNote"]) || value.correlationId !== request.correlationId || typeof value.cancelled !== "boolean" || !Array.isArray(value.answers) || !optionalString(value, "globalNote")) return undefined;
	const seen = new Set<number>();
	const answers: QuestionAnswer[] = [];
	for (const raw of value.answers) {
		if (!exactRecord(raw, ["questionIndex", "question", "kind", "answer", "selected", "notes", "preview"]) || !validRawAnswer(raw) || (has(raw, "selected") && !Array.isArray(raw.selected))) return undefined;
		const question = request.questions[raw.questionIndex];
		if (!question || raw.question !== question.question || seen.has(raw.questionIndex)) return undefined;
		const answer = answerFor(question, raw);
		if (!answer) return undefined;
		if (answer.notes === "") delete answer.notes;
		seen.add(raw.questionIndex);
		answers.push(answer);
	}
	return value.globalNote === undefined ? { cancelled: value.cancelled, answers } : { cancelled: value.cancelled, answers, globalNote: value.globalNote };
}

function validRawAnswer(value: Record<string, unknown>): value is ValidRawAnswer {
	return typeof value.questionIndex === "number" && Number.isInteger(value.questionIndex)
		&& typeof value.question === "string" && (value.kind === "option" || value.kind === "custom" || value.kind === "multi")
		&& (typeof value.answer === "string" || value.answer === null)
		&& optionalString(value, "notes") && optionalString(value, "preview");
}

function answerFor(question: FrozenQuestionnaireRequest["questions"][number], raw: ValidRawAnswer): QuestionAnswer | undefined {
	const base = { questionIndex: raw.questionIndex, question: raw.question, kind: raw.kind };
	if (raw.kind === "option") {
		const selected = question.options.find((option) => option.label === raw.answer);
		if (question.multiSelect || !selected || typeof raw.answer !== "string" || raw.selected !== undefined || raw.preview !== selected.preview) return undefined;
		return raw.notes === undefined && raw.preview === undefined ? { ...base, answer: raw.answer } : { ...base, answer: raw.answer, ...(raw.notes === undefined ? {} : { notes: raw.notes }), ...(raw.preview === undefined ? {} : { preview: raw.preview }) };
	}
	if (raw.kind === "custom") {
		if (raw.selected !== undefined || raw.preview !== undefined) return undefined;
		return raw.notes === undefined ? { ...base, answer: raw.answer } : { ...base, answer: raw.answer, notes: raw.notes };
	}
	const selected = raw.selected;
	if (!question.multiSelect || raw.answer !== null || raw.preview !== undefined || !stringArray(selected) || new Set(selected).size !== selected.length || selected.some((label) => !question.options.some((option) => option.label === label))) return undefined;
	return raw.notes === undefined ? { ...base, answer: null, selected: [...selected] } : { ...base, answer: null, selected: [...selected], notes: raw.notes };
}

function exactRecord(value: unknown, allowed: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
		&& Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function has(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function optionalString<Key extends string>(
	value: Record<string, unknown>, key: Key,
): value is Record<string, unknown> & { [Property in Key]?: string } {
	return !has(value, key) || typeof value[key] === "string";
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function segment(answer: QuestionAnswer): string {
	const scalar = answer.kind === "option" ? answer.answer ?? "(no input)"
		: answer.kind === "multi" ? answer.selected!.join(", ") || "(no input)"
			: answer.answer || "(no input)";
	const parts = [`"${answer.question}"="${scalar}"`];
	if (answer.preview && answer.preview.length > 0) parts.push(`selected preview: ${answer.preview}`);
	if (answer.notes && answer.notes.length > 0) parts.push(`user notes: ${answer.notes}`);
	return `${parts.join(". ")}.`;
}

function details(cancelled: boolean, answers: QuestionAnswer[], globalNote?: string): QuestionnaireResult {
	return globalNote === undefined ? { answers, cancelled } : { answers, cancelled, globalNote };
}

function toolResult(text: string, details: QuestionnaireResult): QuestionnaireToolResult {
	return { content: [{ type: "text", text }], details };
}

function failed(): FormatResult {
	const failure = { code: "invalid_response" as const, message: "Questionnaire response is invalid" };
	return { ok: false, failure, result: toolResult(`Error: ${failure.message}`, { answers: [], cancelled: true, error: failure.code }) };
}
