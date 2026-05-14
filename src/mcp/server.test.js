// MCP server integration test: spawns the server as a child process, speaks
// MCP protocol via the SDK client, asserts the tool surface and a round-trip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = resolve(fileURLToPath(import.meta.url), "..", "server.js");

let client;
let transport;
let projectDir;

beforeAll(async () => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-mcp-"));
	transport = new StdioClientTransport({
		command: "node",
		args: [SERVER_PATH],
		env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
	});
	client = new Client({ name: "lazy-dev-test", version: "0" }, { capabilities: {} });
	await client.connect(transport);
});

afterAll(async () => {
	await client?.close?.();
	rmSync(projectDir, { recursive: true, force: true });
});

describe("MCP server: tool surface", () => {
	test("exposes exactly 12 lazy-dev tools with JSON Schema input", async () => {
		const { tools } = await client.listTools();
		expect(tools).toHaveLength(12);
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"approve",
				"cancel",
				"create_run",
				"dispatch",
				"doctor",
				"merger_envelope",
				"plan_next",
				"planner_dispatch",
				"prune",
				"retry_tasks",
				"review_build",
				"status",
			].sort(),
		);
		for (const t of tools) {
			expect(typeof t.description).toBe("string");
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}
	});

	test("id-shaped params carry the SAFE_ID pattern constraint", async () => {
		const { tools } = await client.listTools();
		const dispatch = tools.find((t) => t.name === "dispatch");
		expect(dispatch.inputSchema.properties.run_id.pattern).toBe("^[\\w.:-]+$");
		expect(dispatch.inputSchema.properties.task_id.pattern).toBe("^[\\w.:-]+$");
	});
});

describe("MCP server: create_run round-trip", () => {
	test("creates a run, returns run_id + run_dir, writes brief + status", async () => {
		const result = await client.callTool({
			name: "create_run",
			arguments: { brief: "Test brief for integration test" },
		});
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(result.content[0].text);
		expect(body.ok).toBe(true);
		expect(body.schema_version).toBe(1);
		expect(body.run_id).toMatch(/^20\d\d-/);
		expect(body.run_dir).toContain(projectDir);
		expect(() => statSync(join(body.run_dir, "brief.md"))).not.toThrow();
		expect(() => statSync(join(body.run_dir, "status.json"))).not.toThrow();
	});

	test("rejects empty brief", async () => {
		const result = await client.callTool({
			name: "create_run",
			arguments: { brief: "" },
		});
		// Empty brief either errors via schema (minLength) or sanitiseBrief throw.
		expect(result.isError || JSON.parse(result.content[0].text).ok === false).toBeTruthy();
	});
});

describe("MCP server: input validation", () => {
	test("rejects run_id path traversal", async () => {
		const result = await client.callTool({
			name: "plan_next",
			arguments: { run_id: "../etc/passwd" },
		});
		const body = JSON.parse(result.content[0].text);
		expect(body.ok).toBe(false);
	});

	test("unknown tool returns error", async () => {
		try {
			const result = await client.callTool({
				name: "does_not_exist",
				arguments: {},
			});
			// If it didn't throw, the result must indicate error.
			const body = JSON.parse(result.content[0].text);
			expect(body.ok).toBe(false);
		} catch (err) {
			// SDK may throw for unknown tools; either branch is acceptable.
			expect(err.message).toBeDefined();
		}
	});
});
