import {
	createQuestionnaireExternalEditor,
	type ExternalEditorSettings,
	type ExternalEditorTemporaryFile,
	type QuestionnaireExternalEditor,
} from "./external-editor.ts";

export interface QuestionnaireExternalEditorRuntimeContext {
	readonly cwd: string;
	readonly agentHome: string;
	readonly isProjectTrusted?: () => boolean;
}

export interface QuestionnaireExternalEditorRuntimeHost {
	createSettings(cwd: string, agentHome: string, options: { projectTrusted: boolean }): ExternalEditorSettings;
	createTemporaryDirectory(options: { prefix: string; mode: number }): Promise<string>;
	createTemporaryFile(directory: string, options: { name: string; mode: number }): Promise<string>;
	writeFile(path: string, contents: string): Promise<void>;
	readFile(path: string): Promise<string>;
	removeTemporaryDirectory(path: string): Promise<void>;
	execute(command: string, filePath: string, options: { cwd: string; stdio: "inherit" }): Promise<{ exitCode: number | null }>;
}

/** Bridges current questionnaire context to injected external-editor resources. */
export function createQuestionnaireExternalEditorRuntime(
	context: QuestionnaireExternalEditorRuntimeContext,
	host: QuestionnaireExternalEditorRuntimeHost,
): QuestionnaireExternalEditor {
	return createQuestionnaireExternalEditor({
		isProjectTrusted: context.isProjectTrusted,
		createSettings: (projectTrusted) => host.createSettings(context.cwd, context.agentHome, { projectTrusted }),
		resolveCommand: (settings) => settings.getExternalEditorCommand(),
		createTemporaryFile: () => createTemporaryFile(host),
		execute: (command, filePath) => host.execute(command, filePath, { cwd: context.cwd, stdio: "inherit" }),
	});
}

async function createTemporaryFile(host: QuestionnaireExternalEditorRuntimeHost): Promise<ExternalEditorTemporaryFile> {
	let directory: string | undefined;
	try {
		directory = await host.createTemporaryDirectory({ prefix: "pi-editor-", mode: 0o700 });
		const path = await host.createTemporaryFile(directory, { name: "prompt.md", mode: 0o600 });
		return {
			path,
			write: (draft) => host.writeFile(path, draft),
			read: () => host.readFile(path),
			cleanup: () => host.removeTemporaryDirectory(directory),
		};
	} catch (error) {
		if (directory !== undefined) {
			try {
				await host.removeTemporaryDirectory(directory);
			} catch {
				// The initialization error remains primary.
			}
		}
		throw error;
	}
}
