process.on("SIGTERM", () => {});
process.on("message", (message) => {
	if (message && typeof message === "object" && "id" in message) process.send?.({ type: "response", id: message.id, success: true });
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	for (const line of chunk.split("\n")) {
		if (!line) continue;
		try {
			const command = JSON.parse(line);
			process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: { sessionFile: "child.jsonl" } })}\n`);
		} catch {}
	}
});
process.send?.({ type: "ready" });
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
