import { mkdir } from "node:fs/promises";

export type ComposeQuestionnaireMainOptions = {
	readonly sourceRoot: string;
	readonly overlayRoot: string;
	readonly outputRoot: string;
};

/**
 * RED-only scaffold for the hosted QMC-02c composition contract.
 *
 * The hosted assertions intentionally observe the missing copy and validation
 * behavior. Do not replace this with a success shortcut; GREEN must implement
 * the preflight, immutable copy, overlay, and confinement contract here.
 */
export async function composeQuestionnaireMainArtifact(
	options: ComposeQuestionnaireMainOptions,
): Promise<void> {
	void options.sourceRoot;
	void options.overlayRoot;
	await mkdir(options.outputRoot, { recursive: true });
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
	return value;
}

if (process.env.GENTLE_PI_COMPOSE_MAIN === "1") {
	await composeQuestionnaireMainArtifact({
		sourceRoot: requiredEnvironment("ACQUIRED_MAIN_ROOT"),
		overlayRoot: requiredEnvironment("QUESTIONNAIRE_OVERLAY_ROOT"),
		outputRoot: requiredEnvironment("COMPOSED_ROOT"),
	});
}
