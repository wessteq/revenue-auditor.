import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { RevenueAuditorSettings } from "./main";
import { DEFAULT_AI_PAYLOAD_CHARS } from "./textSanitizer";

export const AI_RISK_TABLE_HEADER =
	"| Category | Risk | Penalty | Subsection |";
export const AI_RISK_TABLE_SEPARATOR = "| :--- | :--- | :--- | :--- |";
export const AI_RISK_TABLE_EXAMPLE =
	"| Unusual or Concealed Penalty | Interest rate increases during an Event of Default | 2.0% per annum | 1.3(c) |";

export const AI_RISK_SYSTEM_PROMPT = [
	"You are an elite Big 4 financial auditor. Analyze the provided contract text and identify ONLY hidden financial risks, unusual or concealed penalties, auto-renewal traps, and termination / early-exit conditions that could create cost or lock-in.",
	"Respond with ONLY a Markdown table. No preamble, no bullet lists, no headings, no explanations, and no code fences.",
	"Use exactly this table format:",
	AI_RISK_TABLE_HEADER,
	AI_RISK_TABLE_SEPARATOR,
	AI_RISK_TABLE_EXAMPLE,
	"Category must be one of: Hidden Financial Risk, Unusual or Concealed Penalty, Termination / Early-Exit.",
	'One finding per row. Copy rates, amounts, and subsection IDs exactly from the contract. Do not invent numbers. If a cell is not stated in the contract, write "—". Do not put pipe characters inside cells.',
].join("\n");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;
const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

export function aiRequestTimeoutMs(settings: RevenueAuditorSettings): number {
	return settings.aiProvider === "Ollama (Local)" ? OLLAMA_REQUEST_TIMEOUT_MS : CLOUD_REQUEST_TIMEOUT_MS;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * Sends extracted contract text to the configured LLM and returns the
 * model's risk findings as a Markdown table. Failures are returned as a
 * readable message so the audit report can still render the AI section
 * instead of aborting the whole run.
 */
export async function runAiAudit(
	text: string,
	settings: RevenueAuditorSettings
): Promise<string> {
	const contractText = text.trim();
	if (!contractText) {
		return "- No contract text was available for AI analysis.";
	}

	const messages: ChatMessage[] = [
		{ role: "system", content: AI_RISK_SYSTEM_PROMPT },
		{ role: "user", content: buildUserPrompt(contractText) },
	];

	try {
		if (settings.aiProvider === "Ollama (Local)") {
			return stripMarkdownFences(await requestOllamaChat(settings, messages));
		}
		return stripMarkdownFences(await requestOpenAiCompatibleChat(settings, messages));
	} catch (error) {
		return `- AI risk analysis failed: ${describeAnalyzerError(error)}`;
	}
}

/**
 * Formats the model reply for the audit report. Markdown tables are
 * written as a real table (not a collapsed callout) so Obsidian renders
 * the grid. Error / fallback prose stays in the warning callout.
 */
export function formatAiRiskAnalysisCallout(analysis: string): string[] {
	const body = stripMarkdownFences(analysis)
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));

	const calloutLines = body.length > 0 ? body : ["- No AI findings returned."];
	if (looksLikeMarkdownTable(calloutLines)) {
		return ["### AI Risk Analysis", "", ...calloutLines];
	}
	return ["> [!warning]- AI Risk Analysis", ...calloutLines.map((line) => `> ${line}`)];
}

function buildUserPrompt(text: string): string {
	const clipped = text.length > DEFAULT_AI_PAYLOAD_CHARS;
	const payload = clipped
		? `${text.slice(0, DEFAULT_AI_PAYLOAD_CHARS)}\n\n[Contract text truncated for analysis.]`
		: text;
	return [
		"Audit this contract. The text is already filtered to financial clauses.",
		"Return ONLY a Markdown table in this exact format (no other text):",
		"",
		AI_RISK_TABLE_HEADER,
		AI_RISK_TABLE_SEPARATOR,
		AI_RISK_TABLE_EXAMPLE,
		"",
		"Cover these categories in the Category column (do not use headings or bullets):",
		"- Hidden Financial Risk",
		"- Unusual or Concealed Penalty",
		"- Termination / Early-Exit",
		"One finding per row. Copy rates and subsection IDs exactly as they appear.",
		"",
		"---",
		payload,
		"---",
	].join("\n");
}

function looksLikeMarkdownTable(lines: string[]): boolean {
	const tableLines = lines.filter((line) => /^\s*\|.+\|\s*$/.test(line));
	return (
		tableLines.length >= 2 &&
		tableLines.some((line) => /^\s*\|[-:\s|]+\|\s*$/.test(line) && line.includes("-"))
	);
}

function stripMarkdownFences(text: string): string {
	const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return fenced[1].trim();
	}
	return text.trim();
}

async function requestOllamaChat(
	settings: RevenueAuditorSettings,
	messages: ChatMessage[]
): Promise<string> {
	const endpoint = joinEndpoint(settings.ollamaEndpoint || "http://localhost:11434", "/api/chat");
	const payload = await postJson(
		endpoint,
		{
			model: settings.ollamaModel || "llama3",
			stream: false,
			messages,
		},
		{},
		aiRequestTimeoutMs(settings)
	);
	const content = readOllamaContent(payload);
	if (!content) {
		throw new Error("Ollama returned an empty response.");
	}
	return content;
}

async function requestOpenAiCompatibleChat(
	settings: RevenueAuditorSettings,
	messages: ChatMessage[]
): Promise<string> {
	const apiKey = settings.apiKey.trim();
	if (!apiKey) {
		return `- AI risk analysis skipped: add an API key in Revenue Auditor settings for ${settings.aiProvider}.`;
	}

	const { url, model } =
		settings.aiProvider === "OpenAI"
			? { url: OPENAI_CHAT_URL, model: "gpt-4o-mini" }
			: { url: DEEPSEEK_CHAT_URL, model: "deepseek-chat" };

	const payload = await postJson(
		url,
		{
			model,
			stream: false,
			temperature: 0.1,
			messages,
		},
		{
			Authorization: `Bearer ${apiKey}`,
		},
		aiRequestTimeoutMs(settings)
	);
	const content = readOpenAiContent(payload);
	if (!content) {
		throw new Error(`${settings.aiProvider} returned an empty response.`);
	}
	return content;
}

async function postJson(
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
	timeoutMs = CLOUD_REQUEST_TIMEOUT_MS
): Promise<unknown> {
	const response = await requestJsonWithTimeout(url, body, headers, timeoutMs);
	const raw = response.text ?? "";
	let parsed: unknown = null;
	if (raw.trim()) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`Non-JSON response (${response.status}): ${truncateErrorBody(raw)}`);
		}
	}

	if (response.status < 200 || response.status >= 300) {
		throw new Error(formatHttpError(response.status, parsed, raw));
	}
	return parsed;
}

/**
 * `requestUrl` has no AbortSignal. Race the HTTP call against a timer so
 * the previous fetch-based timeout (and its error message) stay the same.
 */
function requestJsonWithTimeout(
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	timeoutMs: number
): Promise<RequestUrlResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeoutId = window.setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(new Error(`Request timed out after ${timeoutMs / 1000}s.`));
			}
		}, timeoutMs);

		const finish = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timeoutId);
			callback();
		};

		void requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			headers,
			body: JSON.stringify(body),
			throw: false,
		}).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error))
		);
	});
}

function readOllamaContent(payload: unknown): string {
	if (!payload || typeof payload !== "object") {
		return "";
	}
	const message = (payload as { message?: { content?: unknown } }).message;
	return typeof message?.content === "string" ? message.content.trim() : "";
}

function readOpenAiContent(payload: unknown): string {
	if (!payload || typeof payload !== "object") {
		return "";
	}
	const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
	const content = choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

function joinEndpoint(base: string, pathSuffix: string): string {
	return `${base.replace(/\/+$/, "")}${pathSuffix}`;
}

function formatHttpError(status: number, parsed: unknown, raw: string): string {
	if (parsed && typeof parsed === "object") {
		const error = (parsed as { error?: { message?: unknown } | string }).error;
		if (typeof error === "string" && error.trim()) {
			return `HTTP ${status}: ${error.trim()}`;
		}
		if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
			return `HTTP ${status}: ${error.message.trim()}`;
		}
	}
	return `HTTP ${status}: ${truncateErrorBody(raw || "empty response")}`;
}

function truncateErrorBody(raw: string): string {
	const compact = raw.replace(/\s+/g, " ").trim();
	return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

function describeAnalyzerError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}
