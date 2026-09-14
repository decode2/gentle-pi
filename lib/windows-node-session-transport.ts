import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, opendir, open, unlink, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
	SessionPresenceError,
	type PresenceRecord,
	type SessionPresenceCandidate,
	type SessionTransportRegistry,
} from "./agents-session-transport.ts";

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const PROFILE = /^[a-f0-9]{32}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PIPE_PREFIX = "\\\\.\\pipe\\gentle-pi-";
const MAX_RECORD_BYTES = 8192;
const MAX_ENTRIES = 64;
const profileHash = (agentHome: string) => createHash("sha256").update(agentHome).digest("hex").slice(0, 32);
const unsafe = () => new SessionPresenceError("unsafe_path", "unsafe transport path");
const invalid = () => new SessionPresenceError("invalid_presence", "invalid presence record");

/**
 * Native Node named-pipe transport. The profile directory is trusted input
 * supplied by the caller; this implementation makes no SID, ACL, or ownership
 * guarantee beyond keeping its metadata below that selected profile directory.
 */
export class WindowsNodeSessionPresenceRegistry implements SessionTransportRegistry {
	readonly paths: Readonly<{ root: string; presence: string; sockets: string }>;
	private readonly profile: string;
	private readonly servers = new Map<string, Server>();
	private constructor(agentHome: string) {
		this.profile = profileHash(agentHome);
		const root = win32.join(agentHome, "gentle-agents", "transport", "windows-node", this.profile);
		this.paths = Object.freeze({ root, presence: win32.join(root, "presence"), sockets: win32.join(root, "sockets") });
	}

	static async create(agentHome: string) {
		if (process.platform !== "win32") throw new SessionPresenceError("io_error", "transport I/O failed");
		if (typeof agentHome !== "string" || !/^[A-Za-z]:\\/.test(agentHome) || agentHome.includes("..")) throw unsafe();
		const registry = new WindowsNodeSessionPresenceRegistry(agentHome);
		try {
			await mkdir(registry.paths.presence, { recursive: true });
			await mkdir(registry.paths.sockets, { recursive: true });
		} catch { throw new SessionPresenceError("io_error", "transport I/O failed"); }
		return registry;
	}

	async record(id: string, createdAt = Date.now()): Promise<PresenceRecord> {
		if (typeof id !== "string" || !SESSION.test(id)) throw new SessionPresenceError("invalid_session", "invalid session ID");
		if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw invalid();
		const token = randomBytes(16).toString("base64url");
		return Object.freeze({ version: 1 as const, sessionId: id, endpoint: windowsNodePipeName(this.profile, token), createdAt });
	}

	async publish(record: PresenceRecord) {
		this.validate(record);
		const target = this.presencePath(record), temporary = win32.join(this.paths.presence, `.${randomBytes(16).toString("hex")}.tmp`);
		try {
			await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
			await link(temporary, target);
		} catch (error) {
			if (error instanceof SessionPresenceError) throw error;
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SessionPresenceError("busy", "activation already exists");
			throw new SessionPresenceError("io_error", "transport I/O failed");
		} finally { await unlink(temporary).catch(() => {}); }
	}

	async resolve(id: string) {
		const records = await this.listActivations(id, true);
		const record = records[0];
		if (!record) throw new SessionPresenceError("not_found", "presence not found");
		return record;
	}

	async removeOwn(record: PresenceRecord) {
		this.validate(record);
		const file = this.presencePath(record);
		try {
			const current = await this.read(file, record.sessionId, this.activationToken(record.endpoint));
			if (JSON.stringify(current) !== JSON.stringify(record)) return;
			await unlink(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof SessionPresenceError ? error : new SessionPresenceError("io_error", "transport I/O failed");
		}
	}

	async list(excludeSessionId?: string): Promise<readonly SessionPresenceCandidate[]> {
		return (await this.listActivations(excludeSessionId)).map(({ sessionId }) => Object.freeze({ sessionId, reachability: "unknown" as const }));
	}

	async listActivations(excludeSessionId?: string, exact = false): Promise<readonly PresenceRecord[]> {
		if (excludeSessionId !== undefined && !SESSION.test(excludeSessionId)) throw new SessionPresenceError("invalid_session", "invalid session ID");
		const newest = new Map<string, PresenceRecord>();
		let count = 0, dir;
		try {
			dir = await opendir(this.paths.presence);
			for await (const entry of dir) {
				if (++count > MAX_ENTRIES) throw new SessionPresenceError("busy", "presence registry is busy");
				const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z0-9_-]{22})\.json$/.exec(entry.name);
				if (!match || (excludeSessionId !== undefined && match[1] === excludeSessionId && !exact)) continue;
				try {
					const candidate = await this.read(win32.join(this.paths.presence, entry.name), match[1], match[2]);
					if (exact && candidate.sessionId !== excludeSessionId) continue;
					const prior = newest.get(candidate.sessionId);
					if (!prior || candidate.createdAt > prior.createdAt || (candidate.createdAt === prior.createdAt && candidate.endpoint > prior.endpoint)) newest.set(candidate.sessionId, candidate);
				} catch (error) {
					if (!(error instanceof SessionPresenceError) || !["invalid_presence", "not_found", "unsafe_path"].includes(error.code)) throw error;
				}
			}
		} catch (error) {
			if (error instanceof SessionPresenceError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new SessionPresenceError("io_error", "transport I/O failed");
		}
		return [...newest.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
	}

	prepareEndpoint(record: PresenceRecord) { this.validate(record); return Promise.resolve(); }
	createEndpointServer(record: PresenceRecord, onConnection: (socket: Socket) => void) {
		this.validate(record);
		const server = createServer(onConnection);
		this.servers.set(record.endpoint, server);
		server.once("close", () => { if (this.servers.get(record.endpoint) === server) this.servers.delete(record.endpoint); });
		return server;
	}
	async validateEndpoint(record: PresenceRecord, assertReady?: () => void) {
		this.validate(record);
		assertReady?.();
		if (!this.servers.get(record.endpoint)?.listening) throw new SessionPresenceError("io_error", "transport I/O failed");
	}
	cleanupEndpoint(record: PresenceRecord) { this.validate(record); return Promise.resolve(); }
	connectEndpoint(endpoint: string) { this.validateEndpointName(endpoint); return createConnection(endpoint); }

	private presencePath(record: PresenceRecord) { return win32.join(this.paths.presence, `${record.sessionId}.${this.activationToken(record.endpoint)}.json`); }
	private activationToken(endpoint: string) {
		this.validateEndpointName(endpoint);
		return endpoint.slice(`${PIPE_PREFIX}${this.profile}-`.length);
	}
	private validateEndpointName(endpoint: string) {
		if (typeof endpoint !== "string" || endpoint !== `${PIPE_PREFIX}${this.profile}-${this.activationTokenFromEndpoint(endpoint)}`) throw unsafe();
	}
	private activationTokenFromEndpoint(endpoint: string) {
		const prefix = `${PIPE_PREFIX}${this.profile}-`, token = endpoint.startsWith(prefix) ? endpoint.slice(prefix.length) : "";
		if (!PROFILE.test(this.profile) || !TOKEN.test(token)) throw unsafe();
		return token;
	}
	private validate(value: unknown): asserts value is PresenceRecord {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
		const record = value as Record<string, unknown>, keys = Reflect.ownKeys(record);
		if (keys.length !== 4 || !["version", "sessionId", "endpoint", "createdAt"].every((key) => keys.includes(key)) || record.version !== 1 || typeof record.sessionId !== "string" || typeof record.endpoint !== "string" || typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !SESSION.test(record.sessionId)) throw invalid();
		this.validateEndpointName(record.endpoint);
	}
	private async read(file: string, id: string, token: string) {
		let handle;
		try {
			handle = await open(file, constants.O_RDONLY);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw invalid();
			const value = JSON.parse((await handle.readFile({ encoding: "utf8" })).toString()) as unknown;
			this.validate(value);
			if (value.sessionId !== id || this.activationToken(value.endpoint) !== token) throw invalid();
			return Object.freeze({ ...value });
		} catch (error) {
			if (error instanceof SessionPresenceError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionPresenceError("not_found", "presence not found");
			throw invalid();
		} finally { await handle?.close().catch(() => {}); }
	}
}

export function windowsNodePipeName(profileToken: string, activationToken = randomBytes(16).toString("base64url")): string {
	if (!PROFILE.test(profileToken) || !TOKEN.test(activationToken)) throw unsafe();
	return `${PIPE_PREFIX}${profileToken}-${activationToken}`;
}

export function windowsNodeTransportPaths(agentHome: string) {
	if (typeof agentHome !== "string" || win32.isAbsolute(agentHome) === false || agentHome.includes("..")) throw unsafe();
	const root = win32.join(agentHome, "gentle-agents", "transport", "windows-node", profileHash(agentHome));
	return Object.freeze({ root, presence: win32.join(root, "presence"), sockets: win32.join(root, "sockets") });
}
