/**
 * Delegate Tool — Lightweight subagents with auto model selection
 *
 * Spawns isolated `pi` processes for delegated tasks.
 * Models are auto-selected per agent tier from live modelRegistry.
 *
 * Modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent, task, model?, thinking? }, ...] } (up to 4 concurrent)
 *   - Background: add { background: true } to return a job ID immediately
 *
 * Extensions & Skills:
 *   - Child processes keep normal extension and skill auto-discovery enabled
 *   - Nested delegation is background-only and capped at depth 2
 *
 * Agents are markdown files in ~/.pi/agent/agents/ with frontmatter:
 *   name, description, tier (fast|standard|heavy), tools, model, thinking (optional overrides)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 4;
const PARENT_OUTPUT_CAP_BYTES = 16 * 1024;
const COLLAPSED_OUTCOME_CAP_BYTES = 2 * 1024;
const DELEGATE_DEPTH_ENV = "PI_DELEGATE_DEPTH";
const MAX_DELEGATION_DEPTH = 2;
const BUNDLED_AGENT_FILES = ["architect.md", "scout.md", "worker.md"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

type Tier = "fast" | "standard" | "heavy";
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface AgentConfig {
	name: string;
	description: string;
	tier: Tier;
	tools?: string[];
	model?: string; // explicit override
	thinking?: ThinkingLevel; // explicit override
	systemPrompt: string;
}

interface ResourceInfo {
	name: string;
	path: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface TaskResult {
	agent: string;
	task: string;
	cwd: string;
	childId?: string;
	exitCode: number;
	resolvedModel: string;
	thinking?: string;
	messages: any[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
}

interface ChildSession {
	send(type: "steer" | "follow_up", message: string): Promise<{ success: boolean; error?: string }>;
	terminate(): boolean;
}

interface ResolvedTask {
	agent: string;
	task: string;
	model: string;
	thinking?: ThinkingLevel;
	cwd: string;
	childId?: string;
}

interface BackgroundJobDetails {
	id: string;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: number;
	finishedAt?: number;
}

interface DelegateDetails {
	mode: "single" | "parallel";
	results: TaskResult[];
	background?: BackgroundJobDetails;
}

interface BackgroundJob extends BackgroundJobDetails {
	mode: "single" | "parallel";
	results: TaskResult[];
	children: Map<string, ChildSession>;
	controller: AbortController;
}

function getDelegateDepth(): number {
	const depth = Number.parseInt(process.env[DELEGATE_DEPTH_ENV] ?? "0", 10);
	return Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

function makePendingResult(
	agent: string,
	task: string,
	cwd: string,
	resolvedModel = "",
	childId?: string,
	thinking?: string,
): TaskResult {
	return {
		agent,
		task,
		cwd,
		childId,
		exitCode: -1,
		resolvedModel,
		thinking,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

// ─── Agent discovery ────────────────────────────────────────────────────────

function installBundledAgents() {
	const dir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(dir, { recursive: true });

	for (const fileName of BUNDLED_AGENT_FILES) {
		try {
			fs.copyFileSync(new URL(`./agents/${fileName}`, import.meta.url), path.join(dir, fileName), fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
}

function discoverAgents(): AgentConfig[] {
	const dir = path.join(getAgentDir(), "agents");
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			var content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter?.name) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const tier = frontmatter.tier;
		const rawThinking = frontmatter.thinking?.trim().toLowerCase();
		const thinking = THINKING_LEVELS.find((level) => level === rawThinking);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tier: tier === "fast" || tier === "heavy" ? tier : "standard",
			tools: tools?.length ? tools : undefined,
			model: frontmatter.model || undefined,
			thinking,
			systemPrompt: body.trim(),
		});
	}
	return agents;
}

// ─── Extension & skill discovery ─────────────────────────────────────────────

function addExtensionsFromDir(dir: string, results: ResourceInfo[]) {
	if (!fs.existsSync(dir)) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "delegate") continue; // avoid listing this tool as a child resource
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			results.push({ name: entry.name.replace(/\.ts$/, ""), path: path.join(dir, entry.name) });
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			const indexPath = path.join(dir, entry.name, "index.ts");
			if (fs.existsSync(indexPath)) {
				results.push({ name: entry.name, path: indexPath });
			}
		}
	}
}

function discoverExtensions(cwd: string): ResourceInfo[] {
	const results: ResourceInfo[] = [];
	const agentDir = getAgentDir();
	addExtensionsFromDir(path.join(agentDir, "extensions"), results);
	addExtensionsFromDir(path.join(cwd, ".pi", "extensions"), results);
	return results;
}

function addSkillsFromDir(dir: string, results: ResourceInfo[]) {
	if (!fs.existsSync(dir)) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
				results.push({ name: entry.name, path: path.join(dir, entry.name) });
			}
		}
	}
}

function discoverSkills(cwd: string): ResourceInfo[] {
	const results: ResourceInfo[] = [];
	const agentDir = getAgentDir();
	addSkillsFromDir(path.join(agentDir, "skills"), results);
	addSkillsFromDir(path.join(cwd, ".pi", "skills"), results);
	return results;
}

// ─── Model resolution ───────────────────────────────────────────────────────
//
// Scores models by capability (cost → context window → reasoning).
// Then picks: fast=cheapest, standard=median, heavy=most capable+reasoning.

function capabilityScore(m: any): number {
	const costTotal = (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
	const contextNorm = (m.contextWindow ?? 128000) / 1000;
	const reasoningBonus = m.reasoning ? 50 : 0;

	// Subscription models (cost=0): rank by context + reasoning
	if (costTotal === 0) return contextNorm + reasoningBonus;

	// Paid models: cost dominates, reasoning as tiebreaker
	return costTotal * 100 + reasoningBonus;
}

function resolveModelForTier(
	available: any[],
	tier: Tier,
	fallback?: string,
): string {
	if (available.length === 0) return fallback ?? "";

	const sorted = [...available].sort((a, b) => capabilityScore(a) - capabilityScore(b));

	let picked: any;
	if (tier === "fast") {
		const nonReasoning = sorted.filter((m) => !m.reasoning);
		picked = nonReasoning[0] ?? sorted[0];
	} else if (tier === "heavy") {
		const reasoning = sorted.filter((m) => m.reasoning);
		picked = reasoning.length > 0 ? reasoning[reasoning.length - 1] : sorted[sorted.length - 1];
	} else {
		// standard: median
		picked = sorted[Math.floor(sorted.length / 2)];
	}

	return `${picked.provider}/${picked.id}`;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtUsage(u: UsageStats, model?: string): string {
	const p: string[] = [];
	if (u.turns) p.push(`${u.turns}t`);
	if (u.input) p.push(`↑${fmtTokens(u.input)}`);
	if (u.output) p.push(`↓${fmtTokens(u.output)}`);
	if (u.cacheRead) p.push(`R${fmtTokens(u.cacheRead)}`);
	if (u.cacheWrite) p.push(`W${fmtTokens(u.cacheWrite)}`);
	if (u.cost) p.push(`$${u.cost.toFixed(4)}`);
	if (model) p.push(model);
	return p.join(" ");
}

function fmtModelLabel(r: TaskResult): string {
	if (!r.resolvedModel) return r.thinking ?? "";
	return r.thinking ? `${r.resolvedModel}:${r.thinking}` : r.resolvedModel;
}

function shortPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function fmtToolCall(name: string, args: Record<string, any>, fg: (c: any, t: string) => string): string {
	const cmd = (s: string, max = 60) => (s.length > max ? s.slice(0, max) + "…" : s);
	switch (name) {
		case "bash":
			return fg("muted", "$ ") + fg("toolOutput", cmd(args.command || "..."));
		case "read":
			return fg("muted", "read ") + fg("accent", shortPath((args.path || args.file_path || "...") as string));
		case "write":
			return fg("muted", "write ") + fg("accent", shortPath((args.path || args.file_path || "...") as string));
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortPath((args.path || args.file_path || "...") as string));
		case "grep":
			return (
				fg("muted", "grep ") +
				fg("accent", `/${args.pattern || ""}/`) +
				fg("dim", ` in ${shortPath((args.path || ".") as string)}`)
			);
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string);
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortPath((args.path || ".") as string));
		default:
			return fg("accent", name);
	}
}

// ─── Display helpers ────────────────────────────────────────────────────────

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: any[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			for (const part of messages[i].content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(r: TaskResult): boolean {
	if (r.exitCode === -1) {
		return r.stopReason === "error" || r.stopReason === "aborted" || Boolean(r.errorMessage);
	}
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || Boolean(r.errorMessage);
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function truncateForParent(text: string, maxBytes = PARENT_OUTPUT_CAP_BYTES): string {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return text;

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi + 1) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
		else hi = mid - 1;
	}

	const prefix = text.slice(0, lo).trimEnd();
	const shownBytes = Buffer.byteLength(prefix, "utf8");
	return `${prefix}\n\n[Delegate output truncated: ${fmtBytes(totalBytes - shownBytes)} omitted. Full child transcript remains in tool details.]`;
}

function getOutcomeForParent(r: TaskResult, maxBytes = PARENT_OUTPUT_CAP_BYTES): string {
	if (isFailedResult(r)) {
		const reason = r.stopReason || (r.exitCode !== 0 ? `exit ${r.exitCode}` : "error");
		const msg = (r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)").trim();
		return truncateForParent(`Agent ${r.agent} failed (${reason}):\n${msg}`, maxBytes);
	}
	return truncateForParent((getFinalOutput(r.messages) || "(no output)").trim(), maxBytes);
}

function getCollapsedOutcome(r: TaskResult): string {
	if (r.exitCode === -1) return "(running…)";
	return getOutcomeForParent(r, COLLAPSED_OUTCOME_CAP_BYTES);
}

function getParallelOutcome(results: TaskResult[]): string {
	const ok = results.filter((r) => !isFailedResult(r)).length;
	const perTaskOutputCap = Math.max(1024, Math.floor(PARENT_OUTPUT_CAP_BYTES / Math.max(results.length, 1)));
	const outcomes = results.map((r) => {
		const status = isFailedResult(r) ? "failed" : "succeeded";
		return `### [${r.agent}] ${status}\n\n${getOutcomeForParent(r, perTaskOutputCap)}`;
	});
	return truncateForParent(`Parallel: ${ok}/${results.length} succeeded\n\n${outcomes.join("\n\n---\n\n")}`);
}

type JobViewerTone = "text" | "accent" | "muted" | "dim" | "warning" | "success" | "error";

type JobViewerLine = {
	text: string;
	tone: JobViewerTone;
};

function getJobStatusTone(status: BackgroundJobDetails["status"]): JobViewerTone {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "aborted") return "warning";
	return "warning";
}

function getJobStatusIcon(status: BackgroundJobDetails["status"]): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "aborted") return "■";
	return "⏳";
}

function formatElapsed(startedAt: number, finishedAt?: number): string {
	const seconds = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function addJobViewerBlock(lines: JobViewerLine[], text: string, tone: JobViewerTone, prefix = ""): void {
	const normalized = text.replace(/\r\n?/g, "\n");
	for (const line of normalized.split("\n")) lines.push({ text: prefix + line, tone });
}

function getJobViewerLines(job: BackgroundJob): JobViewerLine[] {
	const lines: JobViewerLine[] = [];
	for (const [index, result] of job.results.entries()) {
		if (index > 0) lines.push({ text: "", tone: "dim" });

		const failed = isFailedResult(result);
		const running = result.exitCode === -1;
		const status = running ? "running" : failed ? "failed" : "completed";
		const tone = running ? "warning" : failed ? "error" : "success";
		const icon = running ? "⏳" : failed ? "✗" : "✓";
		lines.push({ text: `${icon} ${result.agent} · ${status}`, tone });
		if (result.childId) addJobViewerBlock(lines, `Child: ${result.childId}`, "dim");
		addJobViewerBlock(lines, `Directory: ${result.cwd}`, "dim");
		addJobViewerBlock(lines, `Task: ${result.task}`, "dim");

		let hasOutput = false;
		for (const message of result.messages) {
			if (message.role === "assistant") {
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part.type === "toolCall") {
						hasOutput = true;
						lines.push({
							text: `→ ${fmtToolCall(part.name, part.arguments ?? {}, (_color: any, text: string) => text)}`,
							tone: "muted",
						});
					} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
						hasOutput = true;
						addJobViewerBlock(lines, part.text, "text", "  ");
					}
				}
			} else if (message.role === "toolResult") {
				const tone: JobViewerTone = message.isError ? "error" : "muted";
				const textParts = (Array.isArray(message.content) ? message.content : [])
					.filter((part: any) => part.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text as string);
				if (textParts.length > 0) {
					hasOutput = true;
					lines.push({ text: `← ${message.toolName || "tool"}:`, tone });
					for (const text of textParts) addJobViewerBlock(lines, text, tone, "  ");
				}
			}
		}

		if (failed && result.errorMessage) addJobViewerBlock(lines, `Error: ${result.errorMessage}`, "error");
		if (failed && result.stderr.trim()) addJobViewerBlock(lines, `stderr: ${result.stderr.trim()}`, "error");
		if (running && !hasOutput) lines.push({ text: "(waiting for child output…)", tone: "muted" });
		if (!running && !hasOutput && !result.errorMessage && !result.stderr.trim()) lines.push({ text: "(no output)", tone: "muted" });

		const usage = fmtUsage(result.usage, result.resolvedModel);
		if (usage) lines.push({ text: usage, tone: "dim" });
	}

	if (lines.length === 0) lines.push({ text: "(waiting for child output…)", tone: "muted" });
	return lines;
}

class BackgroundJobsViewer {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getJobs: () => BackgroundJob[];
	private readonly done: () => void;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private selectedIndex = 0;
	private view: "list" | "output" = "list";
	private outputOffset = 0;
	private followOutput = true;
	private closed = false;

	constructor(tui: TUI, theme: Theme, getJobs: () => BackgroundJob[], done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.getJobs = getJobs;
		this.done = done;
		this.refreshTimer = setInterval(() => this.tui.requestRender(), 250);
		(this.refreshTimer as any).unref?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.view === "output") {
				this.view = "list";
				this.outputOffset = 0;
				this.followOutput = true;
				this.tui.requestRender();
			} else {
				this.close();
			}
			return;
		}

		if (this.view === "list") {
			const jobs = this.getJobs();
			if (jobs.length === 0) return;
			if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) {
				this.selectedIndex = this.selectedIndex === 0 ? jobs.length - 1 : this.selectedIndex - 1;
				this.tui.requestRender();
			} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) {
				this.selectedIndex = (this.selectedIndex + 1) % jobs.length;
				this.tui.requestRender();
			} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				this.view = "output";
				this.outputOffset = 0;
				this.followOutput = true;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
			this.view = "list";
			this.outputOffset = 0;
			this.followOutput = true;
			this.tui.requestRender();
		} else if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) {
			this.outputOffset = Math.max(0, this.outputOffset - 1);
			this.followOutput = false;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) {
			this.outputOffset++;
			this.followOutput = false;
			this.tui.requestRender();
		} else if (matchesKey(data, "pageup")) {
			this.outputOffset = Math.max(0, this.outputOffset - this.getOutputViewportLines());
			this.followOutput = false;
			this.tui.requestRender();
		} else if (matchesKey(data, "pagedown")) {
			this.outputOffset += this.getOutputViewportLines();
			this.followOutput = false;
			this.tui.requestRender();
		} else if (matchesKey(data, "home")) {
			this.outputOffset = 0;
			this.followOutput = false;
			this.tui.requestRender();
		} else if (matchesKey(data, "end")) {
			this.outputOffset = Number.MAX_SAFE_INTEGER;
			this.followOutput = true;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const jobs = this.getJobs();
		if (jobs.length === 0) {
			this.view = "list";
			this.selectedIndex = 0;
		}
		if (this.selectedIndex >= jobs.length) this.selectedIndex = Math.max(0, jobs.length - 1);

		return this.view === "output" && jobs[this.selectedIndex]
			? this.renderOutput(width, jobs[this.selectedIndex])
			: this.renderList(width, jobs);
	}

	invalidate(): void {}

	dispose(): void {
		this.close(false);
	}

	private close(notifyDone = true): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.refreshTimer);
		if (notifyDone) this.done();
	}

	private getBodyLineLimit(): number {
		const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
		return Math.max(3, Math.floor(rows * 0.85) - 2);
	}

	private getOutputViewportLines(): number {
		return Math.max(1, this.getBodyLineLimit() - 2);
	}

	private getJobSummary(job: BackgroundJob): string {
		if (job.mode === "parallel") return `${job.results.length} tasks`;
		const result = job.results[0];
		if (!result) return "single task";
		const task = result.task.replace(/\s+/g, " ").trim();
		return `${result.agent} · ${task}`;
	}

	private renderList(width: number, jobs: BackgroundJob[]): string[] {
		const body: string[] = [
			this.theme.fg("text", `${jobs.length} background job${jobs.length === 1 ? "" : "s"} in this session`),
			"",
		];

		if (jobs.length === 0) {
			body.push(this.theme.fg("muted", "No background delegate jobs yet."));
		} else {
			const maxRows = Math.max(1, this.getBodyLineLimit() - 5);
			const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxRows / 2), jobs.length - maxRows));
			const end = Math.min(jobs.length, start + maxRows);
			for (let i = start; i < end; i++) {
				const job = jobs[i]!;
				const selected = i === this.selectedIndex;
				const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
				const status = this.theme.fg(
					getJobStatusTone(job.status),
					`${getJobStatusIcon(job.status)} ${job.status}`,
				);
				const id = selected ? this.theme.fg("accent", job.id) : this.theme.fg("text", job.id);
				const summary = this.theme.fg("dim", `· ${this.getJobSummary(job)} · ${formatElapsed(job.startedAt, job.finishedAt)}`);
				body.push(`${prefix}${id} ${status} ${summary}`);
			}
			if (start > 0 || end < jobs.length) {
				body.push(this.theme.fg("dim", `  ${start + 1}-${end}/${jobs.length}`));
			}
		}

		body.push("", this.theme.fg("dim", "↑↓ navigate · Enter view output · Esc close"));
		return this.frame(body.slice(0, this.getBodyLineLimit()), width, "delegate:tasks");
	}

	private renderOutput(width: number, job: BackgroundJob): string[] {
		const innerWidth = Math.max(1, width - 2);
		const content = this.renderJobLines(getJobViewerLines(job), innerWidth);
		const viewportLines = this.getOutputViewportLines();
		const maxOffset = Math.max(0, content.length - viewportLines);
		if (this.followOutput) this.outputOffset = maxOffset;
		else this.outputOffset = Math.max(0, Math.min(this.outputOffset, maxOffset));

		const visible = content.slice(this.outputOffset, this.outputOffset + viewportLines);
		const status = this.theme.fg(getJobStatusTone(job.status), `${getJobStatusIcon(job.status)} ${job.status}`);
		const header = `${status} ${this.theme.fg("accent", job.id)} ${this.theme.fg("dim", `${job.mode} · ${formatElapsed(job.startedAt, job.finishedAt)}`)}`;
		const range = content.length === 0 ? "0 lines" : `${this.outputOffset + 1}-${Math.min(content.length, this.outputOffset + visible.length)}/${content.length}`;
		const footer = this.theme.fg("dim", `←/Esc back · ↑↓/PgUp/PgDn scroll · Home/End · ${range}`);
		const body = [header, ...visible, footer];
		return this.frame(body.slice(0, this.getBodyLineLimit()), width, "child output");
	}

	private renderJobLines(lines: JobViewerLine[], width: number): string[] {
		const rendered: string[] = [];
		for (const line of lines) {
			const wrapped = wrapTextWithAnsi(line.text, Math.max(1, width));
			for (const part of wrapped.length > 0 ? wrapped : [""]) rendered.push(this.theme.fg(line.tone, part));
		}
		return rendered;
	}

	private frame(body: string[], width: number, title: string): string[] {
		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("accent", text);
		const titleText = truncateToWidth(` ${title} `, innerWidth, "", true);
		const titleWidth = visibleWidth(titleText);
		const remaining = Math.max(0, innerWidth - titleWidth);
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		const output = [
			border(`╭${"─".repeat(left)}`) + this.theme.fg("dim", titleText) + border(`${"─".repeat(right)}╮`),
		];

		for (const line of body) {
			const fitted = truncateToWidth(line, innerWidth, "", true);
			const padded = fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
			output.push(border("│") + padded + border("│"));
		}
		output.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return output;
	}
}

// ─── Process spawning ───────────────────────────────────────────────────────

function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: extraArgs };
	}
	return { command: "pi", args: extraArgs };
}

async function runAgent(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	modelId: string,
	thinking: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	makeDetails: (results: TaskResult[]) => DelegateDetails,
	childId?: string,
	onReady?: (child: ChildSession) => void,
	onSettled?: () => void,
): Promise<TaskResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const names = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			cwd,
			childId,
			exitCode: 1,
			resolvedModel: modelId,
			thinking,
			messages: [],
			stderr: `Unknown agent "${agentName}". Available: ${names}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
	}

	// Keep normal extension and skill discovery enabled. RPC keeps stdin open so
	// background children can receive steering messages while they are active.
	const args = ["--mode", "rpc", "--no-session"];
	if (modelId) args.push("--model", modelId);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	const result: TaskResult = {
		agent: agentName,
		task,
		cwd,
		childId,
		exitCode: -1,
		resolvedModel: modelId,
		thinking,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const emit = () => {
		onUpdate?.({
			content: [{ type: "text", text: `Agent ${agentName} running…` }],
			details: makeDetails([result]),
		});
	};

	try {
		if (agent.systemPrompt) {
			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-delegate-"));
			const tmpPath = path.join(tmpDir, "system-prompt.md");
			await fs.promises.writeFile(tmpPath, agent.systemPrompt, { mode: 0o600 });
			args.push("--append-system-prompt", tmpPath);
		}

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd,
				env: { ...process.env, [DELEGATE_DEPTH_ENV]: String(getDelegateDepth() + 1) },
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let buf = "";
			let closed = false;
			let settled = false;
			let requestId = 0;
			const pending = new Map<string, (reply: { success: boolean; error?: string }) => void>();

			const settlePending = (error: string) => {
				for (const reply of pending.values()) reply({ success: false, error });
				pending.clear();
			};
			const endInput = () => {
				if (!proc.stdin.destroyed && proc.stdin.writable) proc.stdin.end();
			};
			const sendRpc = (type: "prompt" | "steer" | "follow_up", message: string, timeoutMs = 10_000) =>
				new Promise<{ success: boolean; error?: string }>((reply) => {
					if (closed || proc.stdin.destroyed || !proc.stdin.writable) {
						reply({ success: false, error: "Child session is no longer active." });
						return;
					}
					const id = `delegate-rpc-${++requestId}`;
					const timeout = timeoutMs > 0 ? setTimeout(() => {
						if (pending.delete(id)) reply({ success: false, error: "Timed out waiting for the child session." });
					}, timeoutMs) : undefined;
					(timeout as any)?.unref?.();
					pending.set(id, (result) => {
						if (timeout) clearTimeout(timeout);
						reply(result);
					});
					proc.stdin.write(`${JSON.stringify({ id, type, message })}\n`, (error) => {
						if (error && pending.delete(id)) reply({ success: false, error: error.message });
					});
				});
			const terminate = () => {
				if (closed) return false;
				wasAborted = true;
				endInput();
				if (!proc.kill("SIGTERM")) return false;
				const killTimer = setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
				}, 5000);
				(killTimer as any).unref?.();
				return true;
			};
			const child: ChildSession = {
				send: (type, message) => sendRpc(type, message),
				terminate,
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}

				if (ev.type === "response" && ev.id && pending.has(ev.id)) {
					const reply = pending.get(ev.id)!;
					pending.delete(ev.id);
					reply({ success: ev.success === true, error: ev.error });
					return;
				}
				if (ev.type === "agent_settled") {
					settled = true;
					onSettled?.();
					endInput();
				}
				if (ev.type === "message_end" && ev.message) {
					result.messages.push(ev.message);
					const msg = ev.message;
					if (msg.role === "assistant") {
						result.usage.turns++;
						if (msg.usage) {
							result.usage.input += msg.usage.input || 0;
							result.usage.output += msg.usage.output || 0;
							result.usage.cacheRead += msg.usage.cacheRead || 0;
							result.usage.cacheWrite += msg.usage.cacheWrite || 0;
							result.usage.cost += msg.usage.cost?.total || 0;
						}
						if (msg.model) result.resolvedModel = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emit();
				}
				if (ev.type === "tool_result_end" && ev.message) {
					result.messages.push(ev.message);
					emit();
				}
			};

			proc.stdout.on("data", (d: Buffer) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const line of lines) processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			});
			proc.stderr.on("data", (d: Buffer) => {
				result.stderr += d.toString();
			});
			proc.on("close", (code) => {
				closed = true;
				if (buf.trim()) processLine(buf);
				settlePending("Child session closed.");
				resolve(code ?? (settled ? 0 : 1));
			});
			proc.on("error", (err) => {
				result.errorMessage = err.message;
				settlePending(err.message);
				resolve(1);
			});

			onReady?.(child);
			void sendRpc("prompt", `Task: ${task}`, 0).then((reply) => {
				if (!reply.success) {
					result.errorMessage ||= reply.error || "Child session rejected the task.";
					endInput();
				}
			});

			if (signal) {
				if (signal.aborted) terminate();
				else signal.addEventListener("abort", terminate, { once: true });
			}
		});

		result.exitCode = wasAborted ? 1 : exitCode;
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage ||= "Aborted";
		}
		return result;
	} finally {
		if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
}

// ─── Concurrency helper ─────────────────────────────────────────────────────

async function mapConcurrent<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	if (!items.length) return [];
	const limit = Math.max(1, Math.min(n, items.length));
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		}),
	);
	return results;
}

function resolveChildCwd(parentCwd: string, requested?: string): { cwd?: string; error?: string } {
	const candidate = requested?.trim() ? path.resolve(parentCwd, requested.trim()) : parentCwd;
	try {
		if (!fs.statSync(candidate).isDirectory()) return { error: `Working directory is not a directory: ${candidate}` };
		return { cwd: candidate };
	} catch {
		return { error: `Working directory does not exist: ${candidate}` };
	}
}

// ─── Tool parameter schema ──────────────────────────────────────────────────

const ThinkingLevelParam = Type.Union(
	THINKING_LEVELS.map((level) => Type.Literal(level)),
	{ description: "Thinking level: off, minimal, low, medium, high, xhigh, max. Without it the child starts at pi's configured startup thinking level." },
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task description" }),
	model: Type.Optional(Type.String({ description: "Model override for this task (e.g. 'provider/model-id')." })),
	thinking: Type.Optional(ThinkingLevelParam),
	cwd: Type.Optional(Type.String({ description: "Working directory for this child; overrides the invocation cwd." })),
});

const DelegateParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
	task: Type.Optional(Type.String({ description: "Task for single mode" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks for parallel mode; runs up to 4 concurrently and queues the rest" })),
	model: Type.Optional(Type.String({ description: "Default model override for this invocation (e.g. 'provider/model-id')." })),
	thinking: Type.Optional(ThinkingLevelParam),
	cwd: Type.Optional(Type.String({ description: "Default child working directory; relative paths resolve from the parent cwd." })),
	background: Type.Optional(Type.Boolean({ description: "Start work in the background and return a job ID immediately." })),
});

const DelegateMessageParams = Type.Object({
	jobId: Type.String({ description: "Background job ID." }),
	childId: Type.String({ description: "Target child ID reported when the background job starts." }),
	message: Type.String({ description: "Instruction to send to the child." }),
	delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "Deliver after the current turn or after the child settles; defaults to steer." })),
});

const DelegateTerminateParams = Type.Object({
	jobId: Type.String({ description: "Background job ID." }),
	childId: Type.String({ description: "Active child ID reported when the background job starts." }),
});

const DelegateStatusParams = Type.Object({
	jobId: Type.Optional(Type.String({ description: "Background job ID. Omit to list jobs in this session." })),
});

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	installBundledAgents();

	const depth = getDelegateDepth();
	if (depth >= MAX_DELEGATION_DEPTH) return;

	const backgroundJobs = new Map<string, BackgroundJob>();
	let acceptingBackgroundCompletions = true;

	const toDetails = (job: BackgroundJob): DelegateDetails => ({
		mode: job.mode,
		results: job.results.map((result) => ({ ...result, messages: [...result.messages], usage: { ...result.usage } })),
		background: {
			id: job.id,
			status: job.status,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
		},
	});

	const backgroundSummary = (job: BackgroundJob) =>
		job.mode === "single" ? getOutcomeForParent(job.results[0]) : getParallelOutcome(job.results);

	pi.on("session_shutdown", () => {
		acceptingBackgroundCompletions = false;
		for (const job of backgroundJobs.values()) job.controller.abort();
		backgroundJobs.clear();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task) or parallel (tasks array, max 4 concurrent; extra tasks are queued).",
			"Each parallel task may specify its own model; a top-level model is the default for tasks without one.",
			"thinking may be set per task or top-level (off|minimal|low|medium|high|xhigh|max); without it children start at pi's configured default thinking level, not the parent's current level.",
			"Set background: true to start work without blocking; it returns a job ID and auto-reports completion to the parent session.",
			"Nested delegation is background-only and capped at two levels.",
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents with isolated context",
		promptGuidelines: [
			"Use delegate to run subtasks in isolated context windows.",
			"Use scout for quick codebase lookups, worker for code changes, architect for deep analysis.",
			"Use parallel mode when multiple tasks are independent; tasks beyond the concurrency limit are queued.",
			"Set tasks[].model to choose a model for a specific parallel task; use top-level model as the batch default.",
			"Set thinking for tasks that need more or less reasoning effort; per-task thinking overrides the top-level value.",
			"After starting delegate with background: true, do not poll with delegate_status, bash sleep, wait loops, or repeated status checks. Continue independent work or end the response; the completion message will automatically trigger a new turn.",
		],
		parameters: DelegateParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const agents = discoverAgents();
			const available = ctx.modelRegistry.getAvailable();
			const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			const extList = discoverExtensions(ctx.cwd);
			const skillList = discoverSkills(ctx.cwd);
			const tierModel = new Map<Tier, string>();
			for (const tier of ["fast", "standard", "heavy"] as Tier[]) {
				tierModel.set(tier, resolveModelForTier(available, tier, fallback));
			}

			const defaultModel = params.model?.trim() || "";
			function modelFor(agentName: string, taskModel?: string): string {
				if (taskModel?.trim()) return taskModel.trim();
				if (defaultModel) return defaultModel;
				const agent = agents.find((candidate) => candidate.name === agentName);
				return agent?.model || (agent ? tierModel.get(agent.tier) : undefined) || fallback;
			}
			const defaultThinking = params.thinking;
			function thinkingFor(agentName: string, taskThinking?: ThinkingLevel): ThinkingLevel | undefined {
				if (taskThinking) return taskThinking;
				if (defaultThinking) return defaultThinking;
				return agents.find((candidate) => candidate.name === agentName)?.thinking;
			}

			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			const mode = hasSingle ? "single" : "parallel";
			const mkDetails = (results: TaskResult[], background?: BackgroundJobDetails): DelegateDetails => ({ mode, results, background });

			if (hasSingle && hasParallel) {
				return { content: [{ type: "text", text: "Provide either agent+task or tasks, not both." }], details: mkDetails([]) };
			}

			if (!hasSingle && !hasParallel) {
				const agentList = agents.map((agent) => `  ${agent.name} (${agent.tier}): ${agent.description}`).join("\n") || "No agents in ~/.pi/agent/agents/*.md";
				const extNames = extList.map((extension) => `  ${extension.name}`).join("\n") || "  (none)";
				const skillNames = skillList.map((skill) => `  ${skill.name}`).join("\n") || "  (none)";
				return {
					content: [{ type: "text", text: `Provide agent+task or tasks array.\n\nAvailable agents:\n${agentList}\n\nAvailable extensions:\n${extNames}\n\nAvailable skills:\n${skillNames}` }],
					details: mkDetails([]),
				};
			}

			if (depth > 0 && !params.background) {
				return {
					content: [{ type: "text", text: "Nested delegation must use background: true (maximum depth is 2)." }],
					details: mkDetails([]),
				};
			}

			const rawTasks = hasSingle
				? [{ agent: params.agent!, task: params.task!, model: undefined, thinking: undefined, cwd: undefined }]
				: params.tasks!;
			const tasks: ResolvedTask[] = [];
			for (const task of rawTasks) {
				const requestedCwd = task.cwd?.trim() ? task.cwd : params.cwd;
				const resolved = resolveChildCwd(ctx.cwd, requestedCwd);
				if (!resolved.cwd) {
					return {
						content: [{ type: "text", text: resolved.error! }],
						details: mkDetails([]),
						isError: true,
					};
				}
				tasks.push({
					agent: task.agent,
					task: task.task,
					model: modelFor(task.agent, task.model),
					thinking: thinkingFor(task.agent, task.thinking),
					cwd: resolved.cwd,
				});
			}

			const makeInitialResults = (withChildIds: boolean, jobId?: string) =>
				tasks.map((task, index) =>
					makePendingResult(task.agent, task.task, task.cwd, task.model, withChildIds ? `${jobId}:${index + 1}` : undefined, task.thinking),
				);

			const runTask = async (
				task: ResolvedTask,
				runSignal: AbortSignal | undefined,
				onTaskUpdate: (result: TaskResult) => void,
				onReady?: (child: ChildSession) => void,
				onSettled?: () => void,
			): Promise<TaskResult> => {
				try {
					const result = await runAgent(task.cwd, agents, task.agent, task.task, task.model, task.thinking, runSignal, (partial: any) => {
						const update = partial.details?.results[0] as TaskResult | undefined;
						if (update) onTaskUpdate(update);
					}, (results) => mkDetails(results), task.childId, onReady, onSettled);
					onTaskUpdate(result);
					return result;
				} catch (error) {
					const failed = makePendingResult(task.agent, task.task, task.cwd, task.model, task.childId, task.thinking);
					failed.exitCode = 1;
					failed.errorMessage = error instanceof Error ? error.message : String(error);
					onTaskUpdate(failed);
					return failed;
				}
			};

			const runParallel = async (
				results: TaskResult[],
				runSignal: AbortSignal | undefined,
				onProgress?: () => void,
				onChildReady?: (task: ResolvedTask, child: ChildSession) => void,
				onChildSettled?: (task: ResolvedTask) => void,
			): Promise<TaskResult[]> =>
				mapConcurrent(tasks, MAX_CONCURRENCY, async (task, index) => {
					task.childId = results[index].childId;
					const result = await runTask(task, runSignal, (update) => {
						results[index] = update;
						onProgress?.();
					}, (child) => onChildReady?.(task, child), () => onChildSettled?.(task));
					return result;
				});

			if (params.background) {
				const id = `delegate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				const initialResults = makeInitialResults(true, id);
				for (const [index, task] of tasks.entries()) task.childId = initialResults[index].childId;
				const job: BackgroundJob = {
					id,
					mode,
					status: "running",
					startedAt: Date.now(),
					results: initialResults,
					children: new Map(),
					controller: new AbortController(),
				};
				backgroundJobs.set(id, job);

				const updateResult = (index: number, update: TaskResult) => {
					job.results[index] = update;
					if (update.exitCode !== -1 && update.childId) job.children.delete(update.childId);
				};
				const registerChild = (task: ResolvedTask, child: ChildSession) => {
					if (task.childId) job.children.set(task.childId, child);
				};
				void (async () => {
					if (hasSingle) {
						job.results[0] = await runTask(
							tasks[0],
							job.controller.signal,
							(update) => updateResult(0, update),
							(child) => registerChild(tasks[0], child),
							() => {
								if (tasks[0].childId) job.children.delete(tasks[0].childId);
							},
						);
					} else {
						job.results = await runParallel(
							job.results,
							job.controller.signal,
							undefined,
							registerChild,
							(task) => {
								if (task.childId) job.children.delete(task.childId);
							},
						);
					}
					job.status = job.controller.signal.aborted ? "aborted" : job.results.every((result) => !isFailedResult(result)) ? "completed" : "failed";
					job.children.clear();
					job.finishedAt = Date.now();

					if (!acceptingBackgroundCompletions) return;
					try {
						pi.sendMessage(
							{
								customType: "delegate-background",
								content: `Background job ${job.id} ${job.status}.\n\n${backgroundSummary(job)}`,
								display: true,
								details: toDetails(job),
							},
							{ deliverAs: "steer", triggerTurn: true },
						);
					} catch {
						// The parent session may have ended between the completion check and injection.
					}
				})();

				const targets = initialResults.map((result) => `${result.childId} (${result.agent})`).join(", ");
				return {
					content: [{ type: "text", text: `Started background job ${job.id}. Target child IDs: ${targets}. Use delegate_message to steer an active child; do not poll the job. Completion will be delivered automatically and trigger a new turn.` }],
					details: toDetails(job),
				};
			}

			const initialResults = makeInitialResults(false);
			if (hasSingle) {
				const result = await runTask(tasks[0], signal, (update) => onUpdate?.({
					content: [{ type: "text", text: `Agent ${tasks[0].agent} running…` }],
					details: mkDetails([update]),
				}));
				return {
					content: [{ type: "text", text: getOutcomeForParent(result) }],
					details: mkDetails([result]),
					isError: isFailedResult(result) || undefined,
				};
			}

			const allResults = initialResults;
			const emitParallelProgress = () => {
				if (!onUpdate) return;
				const completed = allResults.filter((result) => result.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${completed}/${allResults.length} done, ${allResults.length - completed} running…` }],
					details: mkDetails([...allResults]),
				});
			};
			const results = await runParallel(allResults, signal, emitParallelProgress);
			const succeeded = results.filter((result) => !isFailedResult(result)).length;
			return {
				content: [{ type: "text", text: getParallelOutcome(results) }],
				details: mkDetails(results),
				isError: succeeded !== results.length || undefined,
			};
		},

		// ── Render call ────────────────────────────────────────────────────

		renderCall(args, theme) {
			const tasks = args.tasks;
			if (tasks?.length) {
				let t = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", `parallel (${tasks.length})`);
				if (args.background) t += theme.fg("warning", " background");
				if (args.thinking) t += theme.fg("dim", ` thinking:${args.thinking}`);
				for (const task of tasks.slice(0, 3)) {
					const p = task.task.length > 40 ? task.task.slice(0, 40) + "…" : task.task;
					t += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${p}`)}`;
				}
				if (tasks.length > 3) t += `\n  ${theme.fg("muted", `… +${tasks.length - 3} more`)}`;
				return new Text(t, 0, 0);
			}
			const name = args.agent || "…";
			const p = args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task) : "…";
			const background = args.background ? theme.fg("warning", " background") : "";
			const thinking = args.thinking ? theme.fg("dim", ` thinking:${args.thinking}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", name) + background + thinking + `\n  ${theme.fg("dim", p)}`, 0, 0);
		},

		// ── Render result ──────────────────────────────────────────────────

		renderResult(result, { expanded }, theme) {
			const details = result.details as DelegateDetails | undefined;
			if (!details?.results.length) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const aggUsage = (results: TaskResult[]) => {
				const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					u.input += r.usage.input;
					u.output += r.usage.output;
					u.cacheRead += r.usage.cacheRead;
					u.cacheWrite += r.usage.cacheWrite;
					u.cost += r.usage.cost;
					u.turns += r.usage.turns;
				}
				return u;
			};

			// ── Single ─────────────────────────────────────────────────────

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const running = r.exitCode === -1;
				const failed = isFailedResult(r);
				const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);
				const output = getFinalOutput(r.messages);

				if (expanded) {
					const c = new Container();
					let h = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
					if (details.background) h += theme.fg("warning", ` [${details.background.id}]`);
					const modelLabel = fmtModelLabel(r);
					if (modelLabel) h += theme.fg("dim", ` → ${modelLabel}`);
					if (failed && r.stopReason) h += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					c.addChild(new Text(h, 0, 0));
					if (failed && r.errorMessage) c.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					for (const item of items) {
						if (item.type === "toolCall")
							c.addChild(
								new Text(theme.fg("muted", "→ ") + fmtToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
							);
					}
					if (output) {
						c.addChild(new Spacer(1));
						c.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					}
					const u = fmtUsage(r.usage, r.resolvedModel);
					if (u) {
						c.addChild(new Spacer(1));
						c.addChild(new Text(theme.fg("dim", u), 0, 0));
					}
					return c;
				}

				// Collapsed: final outcome/status only. Expand to inspect child transcript.
				let t = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
				if (details.background) t += theme.fg("warning", ` [${details.background.id}]`);
				const modelLabel = fmtModelLabel(r);
				if (modelLabel) t += theme.fg("dim", ` → ${modelLabel}`);
				const outcomeColor = running ? "muted" : failed ? "error" : "toolOutput";
				t += `\n${theme.fg(outcomeColor, getCollapsedOutcome(r))}`;
				const u = fmtUsage(r.usage);
				if (u) t += `\n${theme.fg("dim", u)}`;
				if (items.length || output) t += `\n${theme.fg("muted", "(Ctrl+O to show child transcript)")}`;
				return new Text(t, 0, 0);
			}

			// ── Parallel ───────────────────────────────────────────────────

			const results = details.results;
			const running = results.filter((r) => r.exitCode === -1).length;
			const succeeded = results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failedN = results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const isRunning = running > 0;
			const icon = isRunning ? theme.fg("warning", "⏳") : failedN ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const status = isRunning
				? `${succeeded + failedN}/${results.length} done, ${running} running`
				: `${succeeded}/${results.length}`;

			if (expanded && !isRunning) {
				const c = new Container();
				c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));

				for (const r of results) {
					const ri = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const items = getDisplayItems(r.messages);
					const output = getFinalOutput(r.messages);

					c.addChild(new Spacer(1));
					c.addChild(
						new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}${theme.fg("dim", ` → ${fmtModelLabel(r)}`)}`,
							0,
							0,
						),
					);
					c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					for (const item of items) {
						if (item.type === "toolCall")
							c.addChild(
								new Text(theme.fg("muted", "→ ") + fmtToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
							);
					}
					if (output) {
						c.addChild(new Spacer(1));
						c.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					}
					const su = fmtUsage(r.usage);
					if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
				}

				const total = fmtUsage(aggUsage(results));
				if (total) {
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", `Total: ${total}`), 0, 0));
				}
				return c;
			}

			// Collapsed parallel: final outcomes/status only. Expand to inspect child transcripts.
			let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			if (details.background) t += theme.fg("warning", ` [${details.background.id}]`);
			for (const r of results) {
				const rRunning = r.exitCode === -1;
				const rFailed = isFailedResult(r);
				const ri = rRunning ? theme.fg("warning", "⏳") : rFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const outcomeColor = rRunning ? "muted" : rFailed ? "error" : "toolOutput";
				t += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}${theme.fg("dim", ` → ${fmtModelLabel(r)}`)}`;
				t += `\n${theme.fg(outcomeColor, getCollapsedOutcome(r))}`;
			}
			if (!isRunning) {
				const total = fmtUsage(aggUsage(results));
				if (total) t += `\n\n${theme.fg("dim", `Total: ${total}`)}`;
			}
			if (!expanded) t += `\n${theme.fg("muted", "(Ctrl+O to show child transcripts)")}`;
			return new Text(t, 0, 0);
		},
	});

	pi.registerTool({
		name: "delegate_message",
		label: "Delegate Message",
		description: "Send a steering or follow-up instruction to one active child in a background delegate job.",
		promptSnippet: "Send an instruction to an active background delegate child",
		promptGuidelines: [
			"Use delegate_message only to steer an active background child when new information materially affects its task.",
			"Target exactly one child using the job ID and child ID returned by delegate.",
		],
		parameters: DelegateMessageParams,
		async execute(_id, params) {
			const job = backgroundJobs.get(params.jobId);
			if (!job) {
				return { content: [{ type: "text", text: `Unknown background job: ${params.jobId}` }], details: {}, isError: true };
			}
			const child = job.children.get(params.childId);
			if (!child) {
				return {
					content: [{ type: "text", text: `Child ${params.childId} is not active in background job ${params.jobId}.` }],
					details: { jobId: job.id, childId: params.childId, status: job.status },
					isError: true,
				};
			}
			const delivery = params.delivery === "followUp" ? "follow_up" : "steer";
			const reply = await child.send(delivery, params.message);
			if (!reply.success) {
				return {
					content: [{ type: "text", text: `Could not message ${params.childId}: ${reply.error || "child rejected the instruction."}` }],
					details: { jobId: job.id, childId: params.childId, delivery },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Sent ${params.delivery === "followUp" ? "follow-up" : "steering"} instruction to ${params.childId}.` }],
				details: { jobId: job.id, childId: params.childId, delivery },
			};
		},
	});

	pi.registerTool({
		name: "delegate_terminate",
		label: "Delegate Terminate",
		description: "Terminate one active child in a background delegate job.",
		promptSnippet: "Terminate an active background delegate child",
		promptGuidelines: [
			"Use delegate_terminate only when explicitly asked to stop an active background child or when continuing it would be harmful or wasteful.",
			"Target exactly one active child using the job ID and child ID returned by delegate.",
		],
		parameters: DelegateTerminateParams,
		async execute(_id, params) {
			const job = backgroundJobs.get(params.jobId);
			if (!job) {
				return { content: [{ type: "text", text: `Unknown background job: ${params.jobId}` }], details: {}, isError: true };
			}
			const child = job.children.get(params.childId);
			if (!child) {
				return {
					content: [{ type: "text", text: `Child ${params.childId} is not active in background job ${params.jobId}.` }],
					details: { jobId: job.id, childId: params.childId, status: job.status },
					isError: true,
				};
			}
			if (!child.terminate()) {
				return {
					content: [{ type: "text", text: `Could not terminate ${params.childId}; the child is no longer active.` }],
					details: { jobId: job.id, childId: params.childId },
					isError: true,
				};
			}
			job.children.delete(params.childId);
			return {
				content: [{ type: "text", text: `Terminating ${params.childId}.` }],
				details: { jobId: job.id, childId: params.childId },
			};
		},
	});

	pi.registerTool({
		name: "delegate_status",
		label: "Delegate Status",
		description: "Inspect active or completed background delegate jobs by ID. Omit jobId to list jobs started in this session.",
		promptSnippet: "Inspect a background delegate job's status and result",
		promptGuidelines: [
			"Use delegate_status only for manual inspection when explicitly requested or when an auto-reported completion needs more detail; never use it to poll a running job.",
		],
		parameters: DelegateStatusParams,
		async execute(_id, params) {
			if (params.jobId && !backgroundJobs.has(params.jobId)) {
				return {
					content: [{ type: "text", text: `Unknown background job: ${params.jobId}` }],
					details: { jobs: [] },
					isError: true,
				};
			}

			const jobs = params.jobId ? [backgroundJobs.get(params.jobId)!] : [...backgroundJobs.values()];
			if (jobs.length === 0) {
				return { content: [{ type: "text", text: "No background delegate jobs in this session." }], details: { jobs: [] } };
			}

			const text = jobs
				.map((job) => {
					const outcome = job.status === "running" ? "(running…)" : backgroundSummary(job);
					return `### ${job.id} — ${job.status}\n\n${outcome}`;
				})
				.join("\n\n---\n\n");
			return {
				content: [{ type: "text", text: truncateForParent(text) }],
				details: { jobs: jobs.map(toDetails) },
			};
		},
	});

	pi.registerCommand("delegate:tasks", {
		description: "Browse background delegate jobs and view child output",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/delegate:tasks requires interactive TUI mode.", "warning");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new BackgroundJobsViewer(tui, theme, () => [...backgroundJobs.values()], done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "92%",
						minWidth: 40,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
		},
	});
}
