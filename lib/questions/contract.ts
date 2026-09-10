export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
export const RESERVED_LABELS = ["Other", "Type something.", "Next"] as const;

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface QuestionnaireQuestion {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface QuestionnaireInput {
	questions: QuestionnaireQuestion[];
}

export interface FrozenQuestionOption {
	readonly label: string;
	readonly description: string;
	readonly preview?: string;
}

export interface FrozenQuestion {
	readonly question: string;
	readonly header: string;
	readonly options: readonly FrozenQuestionOption[];
	readonly multiSelect: boolean;
}

export interface FrozenQuestionnaireRequest {
	readonly protocol: "gentle-pi/questions/v1";
	readonly correlationId: string;
	readonly questions: readonly FrozenQuestion[];
}

export interface RawQuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface RawQuestionnaireOutcome {
	correlationId: string;
	answers: RawQuestionAnswer[];
	cancelled: boolean;
	globalNote?: string;
}

export interface QuestionPresentationDriver {
	present(request: FrozenQuestionnaireRequest, signal?: AbortSignal): RawQuestionnaireOutcome | Promise<RawQuestionnaireOutcome>;
}

export interface QuestionAnswer extends RawQuestionAnswer {}

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	globalNote?: string;
	error?: string;
}

export interface QuestionnaireToolResult {
	content: [{ type: "text"; text: string }];
	details: QuestionnaireResult;
}

export interface QuestionnaireFailure {
	code: "invalid_input" | "invalid_response";
	message: string;
}
