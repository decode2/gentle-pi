import {
	MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, RESERVED_LABELS,
	type FrozenQuestionnaireRequest, type QuestionnaireFailure, type QuestionnaireInput,
} from "./contract.ts";

export type FrozenRequestResult =
	| { ok: true; request: FrozenQuestionnaireRequest }
	| { ok: false; failure: QuestionnaireFailure };

const RESERVED = new Set<string>(RESERVED_LABELS);

export function createFrozenQuestionnaireRequest(correlationId: string, input: unknown): FrozenRequestResult {
	if (typeof correlationId !== "string") return { ok: false, failure: invalid("Correlation id must be a string") };
	const questionnaire = validateQuestionnaireInput(input);
	if (isFailure(questionnaire)) return { ok: false, failure: questionnaire };
	const request = {
		protocol: "gentle-pi/questions/v1" as const,
		correlationId,
		questions: questionnaire.questions.map((question) => ({
			question: question.question,
			header: question.header,
			multiSelect: question.multiSelect === true,
			options: question.options.map((option) => ({ ...option })),
		})),
	};
	return { ok: true, request: freeze(request) };
}

export function validateQuestionnaireInput(input: unknown): QuestionnaireInput | QuestionnaireFailure {
	if (!record(input) || !Array.isArray(input.questions)) return invalid("Questions must be an array");
	if (input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) return invalid("Questions must contain 1-4 entries");
	const seenQuestions = new Set<string>();
	const questions = [];
	for (const candidate of input.questions) {
		if (!record(candidate) || typeof candidate.question !== "string" || typeof candidate.header !== "string") return invalid("Question text and header must be strings");
		if (candidate.header.length > MAX_HEADER_LENGTH || !Array.isArray(candidate.options) || candidate.options.length < MIN_OPTIONS || candidate.options.length > MAX_OPTIONS) return invalid("Question limits are invalid");
		if (has(candidate, "multiSelect") && typeof candidate.multiSelect !== "boolean") return invalid("multiSelect must be boolean");
		if (seenQuestions.has(candidate.question)) return invalid("Question text must be unique");
		seenQuestions.add(candidate.question);
		const labels = new Set<string>();
		const options = [];
		for (const option of candidate.options) {
			if (!record(option) || typeof option.label !== "string" || typeof option.description !== "string" || (has(option, "preview") && typeof option.preview !== "string")) return invalid("Option fields are invalid");
			if (option.label.length > MAX_LABEL_LENGTH || RESERVED.has(option.label) || labels.has(option.label)) return invalid("Option labels are invalid");
			labels.add(option.label);
			options.push(!has(option, "preview") ? { label: option.label, description: option.description } : { label: option.label, description: option.description, preview: option.preview as string });
		}
		questions.push(!has(candidate, "multiSelect") ? { question: candidate.question, header: candidate.header, options } : { question: candidate.question, header: candidate.header, options, multiSelect: candidate.multiSelect as boolean });
	}
	return { questions };
}

function invalid(message: string): QuestionnaireFailure {
	return { code: "invalid_input", message };
}

function isFailure(value: QuestionnaireInput | QuestionnaireFailure): value is QuestionnaireFailure {
	return "code" in value;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
