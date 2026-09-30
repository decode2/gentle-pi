import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractArtifact, loadArtifact, verifyExtraction, verifyIntegrity,
	type PackedArtifact,
} from "./fixtures/questionnaire-packed-artifact.ts";

function artifact(): PackedArtifact {
	const directory = process.env.PACK_ARTIFACT_DIR;
	assert.ok(directory, "BLOCKED FIXTURE: PACK_ARTIFACT_DIR is required");
	return loadArtifact(directory);
}

function withExtraction(observe: (packed: PackedArtifact, root: string, temporary: string) => void): void {
	const packed = artifact();
	const temporary = mkdtempSync(join(tmpdir(), "questionnaire-pack-"));
	try {
		const root = join(temporary, "pristine");
		extractArtifact(packed, root);
		verifyExtraction(root, packed.report);
		observe(packed, root, temporary);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

// No producer imports, SDK services, package installation or ownership fixtures.
test("UM06b1 artifact: npm integrity, manifest and eight frozen modules agree", () => {
	withExtraction((packed, root) => {
		verifyIntegrity(readFileSync(packed.archivePath), packed.report);
		verifyExtraction(root, packed.report);
		console.log("PACKED BASELINE", JSON.stringify({
			archive: packed.report.filename, integrity: packed.report.integrity,
			archiveBytes: packed.report.size, frozenModules: 8,
		}));
	});
});

test("UM06b1 artifact: altered tarball bytes reject original npm integrity", () => {
	const packed = artifact();
	const original = readFileSync(packed.archivePath);
	const altered = Buffer.from(original);
	altered[0] ^= 1;
	assert.throws(() => verifyIntegrity(altered, packed.report), {
		message: /packed archive SHA-512 integrity mismatch/,
	});
	verifyIntegrity(readFileSync(packed.archivePath), packed.report);
	assert.deepEqual(readFileSync(packed.archivePath), original);
});

test("UM06b1 artifact: fresh corrupt, missing and symlinked module controls reject", () => {
	withExtraction((packed, pristine, temporary) => {
		const relative = "lib/questionnaire/questionnaire-view.ts";
		for (const control of ["corrupt", "missing", "symlink"] as const) {
			const root = join(temporary, control);
			extractArtifact(packed, root);
			verifyExtraction(root, packed.report);
			const target = join(root, relative);
			if (control === "corrupt") {
				const bytes = readFileSync(target);
				bytes[0] ^= 1; // Same length: exercises the Git-blob check, not size alone.
				writeFileSync(target, bytes);
			} else {
				unlinkSync(target);
				if (control === "symlink") symlinkSync(join(pristine, relative), target);
			}
			const diagnostic = control === "corrupt" ? "Git blob mismatch" : control === "missing" ? "member missing" : "member not regular";
			assert.throws(() => verifyExtraction(root, packed.report), {
				message: new RegExp(`packed ${diagnostic}: lib/questionnaire/questionnaire-view\\.ts`),
			});
		}
		verifyExtraction(pristine, packed.report);
		verifyIntegrity(readFileSync(packed.archivePath), packed.report);
	});
});
