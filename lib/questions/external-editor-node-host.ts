import { spawn } from "node:child_process";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalEditorSettings } from "./external-editor.ts";
import type { QuestionnaireExternalEditorRuntimeHost } from "./external-editor-runtime.ts";

type SettingsManagerModule = {
	SettingsManager: {
		create(cwd: string, agentHome: string, options: { projectTrusted: boolean }): ExternalEditorSettings;
	};
};

export async function createQuestionnaireExternalEditorNodeHost(): Promise<QuestionnaireExternalEditorRuntimeHost> {
	const { SettingsManager } = await import("@earendil-works/pi-coding-agent") as SettingsManagerModule;
	return {
		createSettings: (cwd, agentHome, options) => SettingsManager.create(cwd, agentHome, options),
		async createTemporaryDirectory({ prefix, mode }) {
			const directory = await mkdtemp(join(tmpdir(), prefix));
			try {
				await chmod(directory, mode);
				return directory;
			} catch (error) {
				try {
					await rm(directory, { recursive: true, force: true });
				} catch {
					// The chmod failure remains primary.
				}
				throw error;
			}
		},
		async createTemporaryFile(directory, { name, mode }) {
			const path = join(directory, name);
			const handle = await open(path, "wx", mode);
			try {
				return path;
			} finally {
				await handle.close();
			}
		},
		writeFile: (path, contents) => writeFile(path, contents, "utf8"),
		readFile: (path) => readFile(path, "utf8"),
		removeTemporaryDirectory: (path) => rm(path, { recursive: true, force: true }),
		execute(command, filePath, { cwd, stdio }) {
			const [editor, ...editorArgs] = command.split(" ");
			return new Promise((resolve) => {
				const child = spawn(editor, [...editorArgs, filePath], { cwd, stdio, shell: process.platform === "win32" });
				let settled = false;
				const finish = (exitCode: number | null) => {
					if (settled) return;
					settled = true;
					resolve({ exitCode });
				};
				child.once("error", () => finish(null));
				child.once("close", finish);
			});
		},
	};
}
