#!/usr/bin/env node
// server.js — lazy-dev MCP server. Stdio transport. Exposes 12 tools to
// Claude Code. Every tool input is schema-validated; handler-level guards
// catch what the schema cannot (path traversal, size limits, metacharacters).
//
// The server is stateless: state lives on disk under `.lazy-dev/runs/<run-id>/`.
// Writer tools acquire a per-run advisory lock before mutating.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { approveTool } from "./tools/approve.js";
import { cancelRunTool } from "./tools/cancel.js";
import { createRunTool } from "./tools/create-run.js";
import { dispatchTool } from "./tools/dispatch.js";
import { doctorTool } from "./tools/doctor.js";
import { mergerEnvelopeTool } from "./tools/merger-envelope.js";
import { planNextTool } from "./tools/plan-next.js";
import { plannerDispatchTool } from "./tools/planner-dispatch.js";
import { pruneTool } from "./tools/prune.js";
import { retryTasksTool } from "./tools/retry-tasks.js";
import { reviewBuildTool } from "./tools/review-build.js";
import { statusTool } from "./tools/status.js";

const SCHEMA_VERSION = 1;
const SERVER_VERSION = "0.13.0";

// Registry: each entry = { name, description, inputSchema, handler }.
// Handlers receive validated params + a shared ctx (projectDir).
// Tool names use underscores to match the Claude Code MCP tool-name convention
// (`mcp__lazy-dev__<name>`); schema files in this directory use kebab-case.
const tools = [
	createRunTool,
	planNextTool,
	plannerDispatchTool,
	dispatchTool,
	approveTool,
	reviewBuildTool,
	retryTasksTool,
	mergerEnvelopeTool,
	doctorTool,
	statusTool,
	cancelRunTool,
	pruneTool,
];

function ctx() {
	return { projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() };
}

function ok(obj) {
	return {
		content: [
			{ type: "text", text: JSON.stringify({ schema_version: SCHEMA_VERSION, ok: true, ...obj }) },
		],
	};
}

function fail(message) {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ schema_version: SCHEMA_VERSION, ok: false, error: message }),
			},
		],
		isError: true,
	};
}

const server = new Server(
	{ name: "lazy-dev", version: SERVER_VERSION },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const { name, arguments: args } = req.params;
	const tool = tools.find((t) => t.name === name);
	if (!tool) return fail(`unknown tool: ${name}`);
	try {
		const result = await tool.handler(args || {}, ctx());
		return ok(result);
	} catch (err) {
		return fail(err.message || String(err));
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
