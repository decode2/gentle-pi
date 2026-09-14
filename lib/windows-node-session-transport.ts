import { createHash, randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { type Server, type Socket } from "node:net";
import {
	SessionPresenceError,
	type PresenceRecord,
	type SessionPresenceCandidate,
	type SessionTransportRegistry,
} from "./agents-session-transport.ts";

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const PIPE_PREFIX = "\\\\.\\pipe\\gentle-pi-";

/**
 * Native Node transport entry point. This first slice is intentionally loadable
 * but not operational: it establishes the Windows-owned API before the named
 * pipe implementation lands. It never delegates to PowerShell, WSH, or a
 * broker, and every unimplemented operation fails closed.
 */
export class WindowsNodeSessionPresenceRegistry implements SessionTransportRegistry {
	readonly paths: Readonly<{ root: string; presence: string; sockets: string }>;
	private constructor(agentHome: string) {
		const profile = createHash("sha256").update(agentHome).digest("hex").slice(0, 32);
		const root = win32.join(agentHome, "gentle-agents", "transport", "windows-node", profile);
		this.paths = Object.freeze({ root, presence: win32.join(root, "presence"), sockets: win32.join(root, "sockets") });
	}

	static async create(agentHome: string) {
		if (process.platform !== "win32") throw new SessionPresenceError("io_error", "transport I/O failed");
		if (typeof agentHome !== "string" || !/^[A-Za-z]:\\/.test(agentHome) || agentHome.includes("..")) throw new SessionPresenceError("unsafe_path", "unsafe transport path");
		return new WindowsNodeSessionPresenceRegistry(agentHome);
	}

	private unsupportedError() { return new SessionPresenceError("io_error", "native Node transport is not implemented"); }
	async record(_id: string, _createdAt?: number): Promise<PresenceRecord> { throw this.unsupportedError(); }
	async publish(_record: PresenceRecord): Promise<void> { throw this.unsupportedError(); }
	async resolve(_id: string): Promise<PresenceRecord> { throw this.unsupportedError(); }
	async removeOwn(_record: PresenceRecord): Promise<void> { throw this.unsupportedError(); }
	async list(_excludeSessionId?: string): Promise<readonly SessionPresenceCandidate[]> { throw this.unsupportedError(); }
	async listActivations(_excludeSessionId?: string): Promise<readonly PresenceRecord[]> { throw this.unsupportedError(); }
	async prepareEndpoint(_record: PresenceRecord): Promise<void> { throw this.unsupportedError(); }
	createEndpointServer(_record: PresenceRecord, _onConnection: (socket: Socket) => void): Server { throw this.unsupportedError(); }
	async validateEndpoint(_record: PresenceRecord, _assertReady?: () => void): Promise<void> { throw this.unsupportedError(); }
	async cleanupEndpoint(_record: PresenceRecord): Promise<void> { throw this.unsupportedError(); }
	connectEndpoint(_endpoint: string): Socket { throw this.unsupportedError(); }
}

/** Pure metadata helpers used by portable validation tests before Windows CI. */
export function windowsNodePipeName(profileToken: string, activationToken = randomBytes(16).toString("base64url")): string {
	if (!TOKEN.test(profileToken) || !TOKEN.test(activationToken)) throw new SessionPresenceError("unsafe_path", "unsafe transport path");
	return `${PIPE_PREFIX}${profileToken}-${activationToken}`;
}

export function windowsNodeTransportPaths(agentHome: string) {
	if (typeof agentHome !== "string" || win32.isAbsolute(agentHome) === false || agentHome.includes("..")) throw new SessionPresenceError("unsafe_path", "unsafe transport path");
	const profile = createHash("sha256").update(agentHome).digest("hex").slice(0, 32);
	const root = win32.join(agentHome, "gentle-agents", "transport", "windows-node", profile);
	return Object.freeze({ root, presence: win32.join(root, "presence"), sockets: win32.join(root, "sockets") });
}
