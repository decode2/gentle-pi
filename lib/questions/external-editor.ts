export type QuestionnaireExternalEditor = (draft: string) => Promise<string>;

export interface ExternalEditorSettings {
	getExternalEditorCommand(): string;
}

export interface ExternalEditorTemporaryFile {
	readonly path: string;
	write(draft: string): Promise<void>;
	read(): Promise<string>;
	cleanup(): Promise<void>;
}

export interface ExternalEditorDependencies {
	isProjectTrusted?: () => boolean;
	createSettings(projectTrusted: boolean): ExternalEditorSettings;
	resolveCommand(settings: ExternalEditorSettings): string;
	createTemporaryFile(): Promise<ExternalEditorTemporaryFile>;
	execute(command: string, filePath: string): Promise<{ exitCode: number | null }>;
}

export function createQuestionnaireExternalEditor(dependencies: ExternalEditorDependencies): QuestionnaireExternalEditor {
	return async (draft) => {
		let projectTrusted = false;
		try {
			projectTrusted = dependencies.isProjectTrusted?.() === true;
		} catch {
			// Unavailable context trust must not admit project settings.
		}
		const settings = dependencies.createSettings(projectTrusted);
		const command = dependencies.resolveCommand(settings);
		const temporaryFile = await dependencies.createTemporaryFile();
		let failed = false;
		try {
			await temporaryFile.write(draft);
			const { exitCode } = await dependencies.execute(command, temporaryFile.path);
			if (exitCode !== 0) throw new Error("External editor exited unsuccessfully");
			return (await temporaryFile.read()).replace(/^\uFEFF/, "").replace(/\n$/, "");
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			try {
				await temporaryFile.cleanup();
			} catch (cleanupError) {
				if (!failed) throw cleanupError;
			}
		}
	};
}
