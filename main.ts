import { App, FileSystemAdapter, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, apiVersion } from "obsidian";
import { aiRequestTimeoutMs, formatAiRiskAnalysisCallout, runAiAudit } from "./aiAnalyzer";
import {
	DocumentExtractorRegistry,
	DoclingLocalExtractor,
	ExtractedDocument,
	MarkdownExtractor,
	PdfParseExtractor,
	sanitizeExtractedText,
	testDoclingExecutable,
} from "./documentExtractors";
import { isIgnorableSourceLine, prepareContractTextForAi, type PreparedAiText } from "./textSanitizer";
import {
	VAULT_FOLDER_ANALYSIS,
	VAULT_FOLDER_AUDIT_REPORTS,
	VAULT_FOLDER_CONTRACTS,
	VAULT_FOLDER_PAYMENTS,
	ensureAnalysisFolder as ensureVaultAnalysisFolder,
	ensureAuditReportsFolder as ensureVaultAuditReportsFolder,
	organizeAuditWorkspace,
} from "./vaultFileRouter";

const CONTRACT_FILE_EXTENSIONS = new Set(["md", "markdown", "txt", "pdf"]);

const ANALYSIS_FOLDER = VAULT_FOLDER_ANALYSIS;
const AUDIT_REPORTS_FOLDER = VAULT_FOLDER_AUDIT_REPORTS;
const AUDIT_INDEX_FILENAME = "Audit_Index.md";
const AUDIT_INDEX_TABLE_HEADER = "| Date | Contract File | Total Value | Findings Count | Link |";
const AUDIT_INDEX_TABLE_SEPARATOR = "| --- | --- | --- | --- | --- |";
const BATCH_AUDIT_SUMMARY_FILENAME = "Batch_Audit_Summary.md";
const BATCH_CONTRACT_EXTENSIONS = new Set(["md", "markdown", "pdf"]);
const AUDIT_ARTIFACT_FILENAME = /^Audit_\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?\.(md|json)$/i;
const VAULT_ROOT_FOLDER_KEY = "/";
/** Hang-protection timeout for AI analysis (Docling uses `cliTimeoutMs`). */
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_PLUGIN_LOG_ENTRIES = 200;
const BUG_REPORT_PROTOCOL = "revenue-auditor";
const BUG_REPORT_CMD = "report-bug";
const BUG_REPORT_URI = `obsidian://${BUG_REPORT_PROTOCOL}?cmd=${BUG_REPORT_CMD}`;

type AuditorStatusPhase =
	| "ready"
	| "starting"
	| "parsing"
	| "analyzing"
	| "reconciling"
	| "writing"
	| "batch";

class OperationTimeoutError extends Error {
	readonly timeoutMs: number;
	readonly operation: string;

	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s.`);
		this.name = "OperationTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

function describeUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves `operation` or rejects with `OperationTimeoutError` so a hung
 * Docling/AI call cannot leave the UI stuck on a static "Auditing..." state.
 * The underlying work is not cancelled (child_process / fetch have their
 * own abort/timeout); this unblocks the plugin and surfaces a Notice.
 */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: number | undefined;
	let timedOut = false;

	const observed = operation.then(
		(value) => value,
		(error: unknown) => {
			if (timedOut) {
				return undefined as unknown as T;
			}
			throw error;
		}
	);

	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => {
			timedOut = true;
			reject(new OperationTimeoutError(label, timeoutMs));
		}, timeoutMs);
	});

	try {
		return await Promise.race([observed, timeoutPromise]);
	} finally {
		if (timer !== undefined) {
			window.clearTimeout(timer);
		}
	}
}

type PluginLogLevel = "info" | "warn" | "error";

interface PluginLogEntry {
	timestamp: string;
	level: PluginLogLevel;
	message: string;
}

/** Ring-buffer logger so "Report a Bug" can attach recent plugin output. */
class PluginLogger {
	private readonly entries: PluginLogEntry[] = [];

	info(message: string): void {
		this.record("info", message);
	}

	warn(message: string): void {
		this.record("warn", message);
		console.warn(`[Revenue Auditor] ${message}`);
	}

	error(message: string, error?: unknown): void {
		const suffix = error !== undefined ? ` ${describeUnknownError(error)}` : "";
		this.record("error", `${message}${suffix}`);
		if (error !== undefined) {
			console.error(`[Revenue Auditor] ${message}`, error);
		} else {
			console.error(`[Revenue Auditor] ${message}`);
		}
	}

	formatForBugReport(): string {
		if (this.entries.length === 0) {
			return "(no plugin log entries yet)";
		}
		return this.entries
			.map((entry) => `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`)
			.join("\n");
	}

	private record(level: PluginLogLevel, message: string): void {
		this.entries.push({
			timestamp: new Date().toISOString(),
			level,
			message,
		});
		if (this.entries.length > MAX_PLUGIN_LOG_ENTRIES) {
			this.entries.shift();
		}
	}
}

interface AuditFindingRecord {
	entityType: string;
	value: string;
	lineNumber: number;
	context: string;
}

interface FindingTableRow {
	classification: string;
	value: string;
	context: string;
}

interface AuditReportJson {
	timestamp: string;
	contract_file: string;
	total_value: number;
	findings: AuditFindingRecord[];
}

interface AuditReportBuildResult {
	markdown: string;
	totalValue: number;
	findings: AuditFindingRecord[];
	csvLedgerSkipped: boolean;
	contractId: string | null;
	reconciliation: ReconciliationResult;
	riskKeywordCount: number;
	penaltyFound: boolean;
}

type BatchReconciliationStatus = "Matched" | "Discrepancy" | "Overpaid";
type LegalRiskLevel = "Low" | "Medium" | "High";

interface BatchAuditRow {
	filePath: string;
	clientLabel: string;
	detectedAmount: number;
	reconciliationStatus: BatchReconciliationStatus;
	legalRisk: LegalRiskLevel;
	error: string | null;
}

interface AuditStamp {
	/** `YYYY-MM-DD_HHMMSS` used in `Audit_*.md` / `Audit_*.json` filenames. */
	fileStamp: string;
	/** `YYYY-MM-DD HH:MM:SS` stored in the JSON sidecar. */
	timestamp: string;
	/** `YYYY-MM-DD HH:MM` shown in `Audit_Index.md`. */
	displayDate: string;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** Local-time stamp so filenames match the clock the user sees, not UTC. */
function formatAuditStamp(date: Date): AuditStamp {
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hours = pad2(date.getHours());
	const minutes = pad2(date.getMinutes());
	const seconds = pad2(date.getSeconds());
	return {
		fileStamp: `${year}-${month}-${day}_${hours}${minutes}${seconds}`,
		timestamp: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
		displayDate: `${year}-${month}-${day} ${hours}:${minutes}`,
	};
}

function isAuditHistoryFile(file: TFile): boolean {
	return (
		file.name === AUDIT_INDEX_FILENAME ||
		file.name === "Audit_Report.md" ||
		file.name === BATCH_AUDIT_SUMMARY_FILENAME ||
		AUDIT_ARTIFACT_FILENAME.test(file.name)
	);
}

function isBatchContractFile(file: TFile): boolean {
	return BATCH_CONTRACT_EXTENSIONS.has(file.extension.toLowerCase()) && !isAuditHistoryFile(file);
}

function folderDropdownValue(folder: TFolder): string {
	return folder.isRoot() ? VAULT_ROOT_FOLDER_KEY : folder.path;
}

function listVaultFolders(root: TFolder): TFolder[] {
	const folders: TFolder[] = [];
	const walk = (folder: TFolder) => {
		folders.push(folder);
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				walk(child);
			}
		}
	};
	walk(root);
	return folders.sort((a, b) => folderDropdownValue(a).localeCompare(folderDropdownValue(b)));
}

function collectBatchContractFiles(folder: TFolder, includeSubfolders: boolean): TFile[] {
	const files: TFile[] = [];
	const walk = (node: TFolder, depth: number) => {
		for (const child of node.children) {
			if (child instanceof TFolder) {
				if (!includeSubfolders) {
					continue;
				}
				if (
					child.name === ANALYSIS_FOLDER ||
					child.name === VAULT_FOLDER_AUDIT_REPORTS ||
					child.name === VAULT_FOLDER_PAYMENTS ||
					child.name === "Payments"
				) {
					continue;
				}
				walk(child, depth + 1);
				continue;
			}
			if (child instanceof TFile && isBatchContractFile(child)) {
				files.push(child);
			}
		}
	};
	walk(folder, 0);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function mapBatchReconciliationStatus(
	skipLedger: boolean,
	status: ReconciliationStatus
): BatchReconciliationStatus {
	if (skipLedger) {
		return "Discrepancy";
	}
	if (status === "paid_in_full") {
		return "Matched";
	}
	if (status === "overpaid") {
		return "Overpaid";
	}
	return "Discrepancy";
}

function classifyLegalRisk(input: {
	riskKeywordCount: number;
	penaltyFound: boolean;
	reconciliationStatus: BatchReconciliationStatus;
	ledgerSkipped: boolean;
	expectedValue: number;
	outstandingBalance: number;
}): LegalRiskLevel {
	const unmatched = input.reconciliationStatus !== "Matched" && !input.ledgerSkipped;
	const ratio =
		input.expectedValue !== 0 ? Math.abs(input.outstandingBalance) / Math.abs(input.expectedValue) : 0;
	const materialVariance = unmatched && ratio >= 0.1;

	if (input.riskKeywordCount >= 3 || (input.penaltyFound && input.riskKeywordCount >= 1) || materialVariance) {
		return "High";
	}
	if (input.riskKeywordCount >= 1 || input.penaltyFound || unmatched) {
		return "Medium";
	}
	return "Low";
}

function vaultJoin(folder: string, fileName: string): string {
	return folder ? `${folder}/${fileName}` : fileName;
}

function isMarkdownTableSeparator(line: string): boolean {
	return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function isAuditIndexTableHeader(line: string): boolean {
	const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
	return (
		normalized.startsWith("|") &&
		normalized.includes("date") &&
		normalized.includes("contract file") &&
		normalized.includes("total value") &&
		normalized.includes("findings count") &&
		normalized.includes("link")
	);
}

/**
 * Inserts `row` into the first Audit Index markdown table (newest first,
 * immediately after the header separator). Creates the table if the note
 * has no matching header yet. Preserves any prose above/below the table.
 */
function insertAuditIndexTableRow(markdown: string, row: string): string {
	const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/);
	const headerIdx = lines.findIndex(isAuditIndexTableHeader);

	if (headerIdx < 0) {
		const body = markdown.trimEnd();
		const table = [AUDIT_INDEX_TABLE_HEADER, AUDIT_INDEX_TABLE_SEPARATOR, row].join(newline);
		if (!body) {
			return `# Audit Index${newline}${newline}${table}${newline}`;
		}
		return `${body}${newline}${newline}${table}${newline}`;
	}

	let insertAt = headerIdx + 1;
	if (insertAt < lines.length && isMarkdownTableSeparator(lines[insertAt])) {
		insertAt += 1;
	}

	if (insertAt < lines.length && /no audits yet/i.test(lines[insertAt])) {
		lines[insertAt] = row;
	} else {
		lines.splice(insertAt, 0, row);
	}

	let result = lines.join(newline);
	if (!result.endsWith(newline)) {
		result += newline;
	}
	return result;
}

/**
 * True for a real `.csv` file, and for Obsidian notes named `*.csv.md`
 * (creating "payments2.csv" in the vault often yields `payments2.csv.md`).
 */
function isVaultCsvFile(file: TFile): boolean {
	if (file.extension.toLowerCase() === "csv") {
		return true;
	}
	return /\.csv$/i.test(file.basename) || /\.csv\.md$/i.test(file.name);
}

function listVaultCsvFiles(app: App): TFile[] {
	return app.vault
		.getFiles()
		.filter((file) => isVaultCsvFile(file))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Dropdown label: show `Payments/payments2.csv` even when the vault file is `*.csv.md`. */
function csvDropdownLabel(file: TFile): string {
	if (file.extension.toLowerCase() === "md" && /\.csv\.md$/i.test(file.name)) {
		return file.path.replace(/\.md$/i, "");
	}
	return file.path;
}

type ContractLanguage = "auto" | "en" | "ru";

const CONTRACT_LANGUAGE_LABELS: Record<ContractLanguage, string> = {
	auto: "Auto",
	en: "English",
	ru: "Russian",
};

// Maps our UI language choice to Docling's `--ocr-lang` value (only used
// when OCR is enabled - see DoclingLocalExtractor). "auto" omits the flag
// entirely and lets Docling's OCR engine use its own default language set.
const CONTRACT_LANGUAGE_TO_OCR_LANG: Record<ContractLanguage, string | null> = {
	auto: null,
	en: "en",
	ru: "ru",
};

type NumberFormat = "auto" | "us" | "eu" | "asia";

const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
	auto: "Auto",
	us: "US (1,000.00)",
	eu: "EU (1.000,00)",
	asia: "Asia (1,00,000.00)",
};

type AiProvider = "OpenAI" | "DeepSeek" | "Ollama (Local)";

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
	OpenAI: "OpenAI",
	DeepSeek: "DeepSeek",
	"Ollama (Local)": "Ollama (Local)",
};

type OllamaModel = "llama3" | "mistral" | "deepseek-coder";

const OLLAMA_MODEL_LABELS: Record<OllamaModel, string> = {
	llama3: "llama3",
	mistral: "mistral",
	"deepseek-coder": "deepseek-coder",
};

export interface RevenueAuditorSettings {
	/** Secret used to call the selected AI provider. Stored locally in plugin data. */
	apiKey: string;
	/** Which AI backend to use when a key is configured. */
	aiProvider: AiProvider;
	/** Base URL of the local Ollama server. Used only when `aiProvider` is `"Ollama (Local)"`. */
	ollamaEndpoint: string;
	/** Ollama model tag to send in `/api/generate` / `/api/chat` requests. */
	ollamaModel: OllamaModel;
	/** ISO-style currency code used as the plugin's default (e.g. USD, EUR). */
	defaultCurrency: string;
	riskKeywords: string;
	financialKeywords: string;
	/** Explicit override for the Docling CLI executable. Empty string = auto-detect (see resolveDoclingBinaryPath in documentExtractors.ts). */
	doclingBinaryPath: string;
	/** Explicit Python interpreter path. Empty string = not provided. When set (and doclingBinaryPath is empty), Docling is looked for alongside this interpreter (same bin/ directory) before falling back to well-known install paths. */
	pythonPath: string;
	/** Vault-relative path pre-selected in the Audit modal's CSV dropdown. */
	defaultPaymentsCsvPath: string;
	/** Max time (ms) to let the Docling CLI run before giving up and falling back to pdf-parse. */
	cliTimeoutMs: number;
	/** Whether to pass `--ocr` (true) or `--no-ocr` (false) to Docling - relevant for scanned PDFs with no text layer. */
	enableOcr: boolean;
	/** Passed to Docling as `--ocr-lang` when OCR is enabled, and used to pick English/Russian `FINANCIAL_PATTERNS` keywords. `"auto"` searches both languages and omits the OCR lang flag. */
	contractLanguage: ContractLanguage;
	/** Locale convention used when parsing numbers out of payments.csv and the contract text (thousands/decimal separator placement). */
	numberFormat: NumberFormat;
}

const DEFAULT_SETTINGS: RevenueAuditorSettings = {
	apiKey: "",
	aiProvider: "DeepSeek",
	ollamaEndpoint: "http://localhost:11434",
	ollamaModel: "llama3",
	defaultCurrency: "USD",
	riskKeywords: "penalty, penalties, late fee, late fees, termination, indexation",
	financialKeywords: "price, total",
	doclingBinaryPath: "",
	pythonPath: "",
	defaultPaymentsCsvPath: "Payments/payments.csv",
	cliTimeoutMs: 120_000,
	enableOcr: false,
	contractLanguage: "auto",
	numberFormat: "auto",
};

interface EntityMatch {
	entityType: string;
	value: string;
	lineNumber: number;
	lineText: string;
	/** Already-parsed numeric amount, set for Currency & Prices rows so Total Contract Value does not have to re-parse the display string. */
	numericValue?: number;
}

interface EntityCategory {
	entityType: string;
	patterns: RegExp[];
	emptyMessage: string;
}

// --- CSV parsing ------------------------------------------------------
// Inlined directly into main.ts (rather than a separate module) because
// this plugin's build is a plain `tsc` compile with no bundler, and
// Obsidian only loads a single main.js - a separate compiled file's
// require() calls do not resolve at runtime.

interface PaymentRecord {
	date: string;
	contractId: string;
	amount: number;
	penaltyCharged: number;
	daysLate: number;
	/** Optional CSV `description` / memo column; empty when the file has none. */
	description: string;
}

interface PaymentsCsvParseResult {
	records: PaymentRecord[];
	validRowCount: number;
	skippedRowCount: number;
}

type PaymentsCsvLoadResult =
	| { kind: "skipped" }
	| { kind: "read_error"; path: string; message: string }
	| {
			kind: "parsed";
			path: string;
			records: PaymentRecord[];
			validRowCount: number;
			skippedRowCount: number;
	  };

function roundCurrency(value: number): number {
	return Math.round(value * 100) / 100;
}

function normalizeCsvHeader(cell: string): string {
	return cell.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function findCsvColumn(header: string[], aliases: string[]): number {
	for (const alias of aliases) {
		const idx = header.indexOf(alias);
		if (idx >= 0) {
			return idx;
		}
	}
	return -1;
}

/**
 * Turns a CSV Amount cell into a float. Spreadsheet exports often wrap
 * numbers as `"$10,000.00"` / `"10 000,50 €"`; those have to be stripped
 * to digit/separator characters before `parseNumberByLocale` (which uses
 * `parseFloat` internally). Empty / non-numeric cells return `NaN` so the
 * caller can skip the row instead of treating it as $0.00.
 */
function parseCsvAmount(raw: string, numberFormat: NumberFormat): number {
	const cleaned = raw.replace(/[^0-9.,\-]/g, "");
	if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "," || cleaned === "-." || cleaned === "-,") {
		return Number.NaN;
	}
	return parseNumberByLocale(cleaned, numberFormat);
}

/**
 * Tokenizes raw CSV text into rows of cells per RFC 4180: fields may be
 * wrapped in double quotes (allowing embedded commas/newlines), and a
 * doubled quote (`""`) inside a quoted field represents a literal `"`.
 * A naive `split(",")`/`split("\n")` breaks on exactly this kind of input
 * (e.g. a quoted `"102-PRO"` contract_id would keep its quote characters,
 * or a quoted field containing a comma would be split into extra columns),
 * which is why contract IDs that visually "look the same" can silently
 * fail to match.
 *
 * Every cell is trimmed of surrounding whitespace (including stray `\r`
 * from CRLF line endings that leak in outside of quoted fields).
 */
function parseCsvRows(raw: string): string[][] {
	// Strip a UTF-8 BOM, which some spreadsheet exports prepend and which
	// would otherwise corrupt the very first header/cell.
	const text = raw.replace(/^\uFEFF/, "");

	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	const pushField = () => {
		row.push(field.trim());
		field = "";
	};
	const pushRow = () => {
		pushField();
		rows.push(row);
		row = [];
	};

	while (i < text.length) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += char;
			i++;
			continue;
		}

		if (char === '"') {
			inQuotes = true;
			i++;
			continue;
		}

		if (char === ",") {
			pushField();
			i++;
			continue;
		}

		if (char === "\r") {
			pushRow();
			i++;
			if (text[i] === "\n") {
				i++;
			}
			continue;
		}

		if (char === "\n") {
			pushRow();
			i++;
			continue;
		}

		field += char;
		i++;
	}

	// Flush a trailing field/row if the file doesn't end with a newline.
	if (field.length > 0 || row.length > 0) {
		pushRow();
	}

	// Drop fully-blank rows (e.g. a trailing empty line).
	return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
}

/**
 * Parses a payments CSV. The documented layout is:
 * date,contract_id,amount,penalty_charged,days_late[,description]
 *
 * Column names are matched case-insensitively (`payment_date`, `memo`,
 * `Amount`, etc.). When an `Amount` header is present it is used even if
 * date/contract_id are missing; the header row is skipped and each Amount
 * cell is parsed to a float. Missing penalty/days-late cells default to 0.
 * An optional `description` / `memo` / `note` column is stored on each
 * record for the reconciliation table.
 *
 * Uses a proper RFC 4180 tokenizer (see `parseCsvRows`) so quoted fields,
 * embedded commas, and CRLF line endings don't corrupt column values -
 * notably the `contract_id` used for exact matching against extracted
 * contract IDs in `filterPaymentsByContractId`. `amount`/`penalty_charged` are parsed via
 * `parseCsvAmount` → `parseNumberByLocale` according to the configured
 * Number Format setting, so "$10,000.00" and EU-style "1.234,56" both
 * survive instead of becoming NaN / $0.00.
 */
function parsePaymentsCsv(raw: string, numberFormat: NumberFormat): PaymentsCsvParseResult {
	const rows = parseCsvRows(raw);

	if (rows.length === 0) {
		return { records: [], validRowCount: 0, skippedRowCount: 0 };
	}

	const header = rows[0].map(normalizeCsvHeader);
	const namedDate = findCsvColumn(header, ["date", "payment_date"]);
	const namedContract = findCsvColumn(header, ["contract_id", "contractid"]);
	const namedAmount = findCsvColumn(header, ["amount", "payment_amount", "paid"]);
	const namedPenalty = findCsvColumn(header, ["penalty_charged", "penalty", "penalty_amount"]);
	const namedDaysLate = findCsvColumn(header, ["days_late", "dayslate", "late_days"]);
	const namedDescription = findCsvColumn(header, ["description", "memo", "note", "details", "comment"]);

	const looksLikeHeader =
		namedDate >= 0 || namedContract >= 0 || namedAmount >= 0 || namedDescription >= 0;
	// Use named columns whenever an Amount header exists, even if
	// date/contract_id are missing (e.g. `Date,Description,Amount`).
	// Requiring all three headers used to fall back to positional
	// columns, which mapped Description → contract_id and then dropped
	// every row during ID filtering — Received Payments became $0.00.
	const useNamed = looksLikeHeader && namedAmount >= 0;

	const dateIdx = useNamed ? namedDate : 0;
	const contractIdx = useNamed ? namedContract : 1;
	const amountIdx = useNamed ? namedAmount : 2;
	const penaltyIdx = useNamed ? namedPenalty : 3;
	const daysLateIdx = useNamed ? namedDaysLate : 4;
	const descriptionIdx = namedDescription >= 0 ? namedDescription : 5;

	const dataRows = looksLikeHeader ? rows.slice(1) : rows;
	if (dataRows.length === 0) {
		return { records: [], validRowCount: 0, skippedRowCount: 0 };
	}

	const records: PaymentRecord[] = [];
	let skippedRowCount = 0;

	for (const columns of dataRows) {
		// `contractId` is stored exactly as `parseCsvRows` tokenized it -
		// only whitespace-trimmed, with hyphens, underscores, and case left
		// completely untouched - so `filterPaymentsByContractId` can
		// exact-match it against the ID extracted from the contract text.
		// Empty when the CSV has no contract_id column (common for simple Amount ledgers).
		const date = dateIdx >= 0 ? (columns[dateIdx] ?? "").trim() : "";
		const contractId = contractIdx >= 0 ? (columns[contractIdx] ?? "").trim() : "";
		const amountRaw = amountIdx >= 0 ? columns[amountIdx] ?? "" : "";
		const penaltyRaw = penaltyIdx >= 0 ? columns[penaltyIdx] ?? "" : "";
		const daysLateRaw = daysLateIdx >= 0 ? columns[daysLateIdx] ?? "" : "";
		const description = descriptionIdx >= 0 ? (columns[descriptionIdx] ?? "").trim() : "";

		const amount = parseCsvAmount(amountRaw, numberFormat);
		const penaltyCharged =
			penaltyRaw.trim() === "" ? 0 : parseCsvAmount(penaltyRaw, numberFormat);
		const daysLate = daysLateRaw.trim() === "" ? 0 : Number.parseInt(daysLateRaw, 10);

		if (Number.isNaN(amount) || Number.isNaN(penaltyCharged) || Number.isNaN(daysLate)) {
			skippedRowCount++;
			continue;
		}

		records.push({ date, contractId, amount, penaltyCharged, daysLate, description });
	}

	return { records, validRowCount: records.length, skippedRowCount };
}

function filterPaymentsByContractId(
	records: PaymentRecord[],
	contractId: string | null
): { records: PaymentRecord[]; ignoredCount: number } {
	if (!contractId) {
		return { records, ignoredCount: 0 };
	}

	// Simple ledgers (Date, Description, Amount) have no contract_id
	// column. Filtering those against an extracted ID would zero out
	// Received Payments even though the Amount column parsed correctly.
	const labeledCount = records.filter((record) => record.contractId.length > 0).length;
	if (labeledCount === 0) {
		return { records, ignoredCount: 0 };
	}

	const matched: PaymentRecord[] = [];
	let ignoredCount = 0;
	for (const record of records) {
		if (!record.contractId || contractIdsMatch(record.contractId, contractId)) {
			matched.push(record);
		} else {
			ignoredCount++;
		}
	}
	return { records: matched, ignoredCount };
}

function describePayment(record: PaymentRecord): string {
	const explicit = record.description.trim();
	if (explicit) {
		return explicit;
	}
	if (record.daysLate > 0 && record.penaltyCharged > 0) {
		return `Payment (${record.daysLate} day${record.daysLate === 1 ? "" : "s"} late, penalty charged)`;
	}
	if (record.daysLate > 0) {
		return `Payment (${record.daysLate} day${record.daysLate === 1 ? "" : "s"} late)`;
	}
	if (record.penaltyCharged > 0) {
		return "Payment (penalty charged)";
	}
	return "Payment";
}

type ReconciliationStatus = "paid_in_full" | "underpaid" | "overpaid";

interface ReconciliationResult {
	expectedContractValue: number;
	receivedPayments: number;
	/** Total Contract Value minus the sum of matched CSV payment amounts. */
	discrepancy: number;
	/** Same as `discrepancy`; negative when the CSV overpays the contract. */
	outstandingBalance: number;
	status: ReconciliationStatus;
	underpaidAmount: number;
	overpaidAmount: number;
	records: PaymentRecord[];
}

/**
 * Compares Total Contract Value against the sum of CSV payment amounts
 * already filtered to the active `contract_id`. Amounts are rounded to
 * cents so floating-point noise cannot flip an exact match into a false
 * under/overpayment.
 */
class ReconciliationEngine {
	reconcile(totalContractValue: number, records: PaymentRecord[]): ReconciliationResult {
		const expectedContractValue = roundCurrency(totalContractValue);
		const receivedPayments = roundCurrency(
			records.reduce((sum, record) => sum + record.amount, 0)
		);
		const discrepancy = roundCurrency(expectedContractValue - receivedPayments);

		let status: ReconciliationStatus = "paid_in_full";
		if (discrepancy > 0) {
			status = "underpaid";
		} else if (discrepancy < 0) {
			status = "overpaid";
		}

		return {
			expectedContractValue,
			receivedPayments,
			discrepancy,
			outstandingBalance: discrepancy,
			status,
			underpaidAmount: Math.max(discrepancy, 0),
			overpaidAmount: Math.max(-discrepancy, 0),
			records,
		};
	}
}

/**
 * Parses a number according to a locale convention, since "1,234.56" (US),
 * "1.234,56" (EU), and "1,00,000.00" (Indian/Asian digit grouping) all use
 * the exact same two characters (`,` and `.`) for different purposes - a
 * naive `parseFloat` after stripping commas silently mangles EU-formatted
 * values (e.g. "10.000,00" -> stripping nothing meaningful -> `10` instead
 * of `10000`).
 *
 * `val` may already be a `number` (e.g. a value that came from JSON rather
 * than free text) - it's returned as-is in that case, no parsing needed.
 *
 * - "us": comma is a thousands separator, dot is the decimal point.
 * - "eu": dot is a thousands separator, comma is the decimal point.
 * - "asia": Indian/Asian digit grouping (e.g. "1,00,000.00" = one hundred
 *   thousand) groups irregularly (a group of 3, then groups of 2) but
 *   still uses comma purely as a grouping separator and dot as the decimal
 *   point - quantitatively identical to "us" once every comma is stripped,
 *   regardless of where they fall.
 * - "auto": best-effort heuristic. When both separators appear, whichever
 *   one appears LAST is treated as the decimal point (matches "US
 *   1,234.56", "EU 1.234,56", and "Asia 1,00,000.00" alike). When only ONE
 *   separator type appears, the trailing digit count decides:
 *     - 1 or 2 trailing digits after a COMMA reads as a decimal point
 *       ("5,5" -> 5.5, "10,50" -> 10.5) - a real thousands/grouping comma
 *       is never followed by just 1 digit (groups are always 2 or 3
 *       digits), so a single trailing digit is unambiguous.
 *     - Anything else after a comma (most commonly exactly 3 trailing
 *       digits) reads as a thousands separator ("10,500" -> 10500).
 *     - A lone DOT is the mirror image: exactly 3 trailing digits reads
 *       as a thousands separator on a whole number ("10.500" -> 10500,
 *       "2.500" -> 2500), since currency amounts are essentially never
 *       expressed to 3+ decimal places; any other count (1 or 2 trailing
 *       digits) is a genuine decimal point ("10.50" -> 10.5, "10.5" ->
 *       10.5).
 *   No separator at all is already valid JS float syntax.
 */
function parseNumberByLocale(val: string | number, locale: NumberFormat): number {
	if (typeof val === "number") {
		return val;
	}

	// Strip grouping spaces (NBSP / thin / figure / ASCII) used in
	// Russian-style "10 000" and some PDF/OCR extractions so locale
	// separator detection sees a contiguous digit/separator string.
	const trimmed = val.trim().replace(/[\u00A0\u2007\u2009\u202F ]/g, "");

	if (locale === "eu") {
		return Number.parseFloat(trimmed.replace(/\./g, "").replace(",", "."));
	}
	if (locale === "us" || locale === "asia") {
		return Number.parseFloat(trimmed.replace(/,/g, ""));
	}

	const hasComma = trimmed.includes(",");
	const hasDot = trimmed.includes(".");

	if (hasComma && hasDot) {
		const decimalIsComma = trimmed.lastIndexOf(",") > trimmed.lastIndexOf(".");
		return decimalIsComma
			? Number.parseFloat(trimmed.replace(/\./g, "").replace(",", "."))
			: Number.parseFloat(trimmed.replace(/,/g, ""));
	}

	if (hasComma) {
		const trailingDigits = trimmed.length - trimmed.lastIndexOf(",") - 1;
		return trailingDigits <= 2
			? Number.parseFloat(trimmed.replace(",", "."))
			: Number.parseFloat(trimmed.replace(/,/g, ""));
	}

	if (hasDot) {
		// Symmetric with the comma-only case above - without this, a lone
		// EU-style thousands separator like "2.500" (two thousand five
		// hundred) was silently misread as the US decimal "2.5" dollars,
		// since a single dot is already valid JS float syntax and looked
		// like it needed no special handling.
		const trailingDigits = trimmed.length - trimmed.lastIndexOf(".") - 1;
		return trailingDigits === 3 ? Number.parseFloat(trimmed.replace(/\./g, "")) : Number.parseFloat(trimmed);
	}

	return Number.parseFloat(trimmed);
}

// --- Dynamic financial parameter extraction ----------------------------
// Pulls the base price, annual indexation rate, and daily penalty rate out
// of the contract's own text via regex, instead of hardcoding PoC values.
// Any parameter not found in the text falls back to 0 and is reported as
// "Not specified" in the audit output.

interface ParameterOccurrence {
	/** Already converted to the same units as ExtractedFinancialParameter.value (e.g. a rate as a 0-1 fraction, not a raw percent). */
	value: number;
	lineNumber: number;
	context: string;
}

interface ExtractedFinancialParameter {
	/** The occurrence used for calculations - the first one found, in document order. */
	value: number;
	found: boolean;
	/** Every occurrence detected anywhere in the text, in document order, so the report can show all of them rather than silently trusting only one. */
	occurrences: ParameterOccurrence[];
}

/**
 * Scans every line of `text` against every pattern in `patterns` and
 * collects ALL matches (not just the first), in document order. `transform`
 * converts the raw captured number into calculation-ready units (e.g.
 * dividing a percent literal by 100). Duplicate matches on the same line
 * with the same resulting value (common when multiple patterns match the
 * same phrase) are collapsed into a single occurrence.
 */
function findAllRegexMatches(
	text: string,
	patterns: RegExp[],
	numberFormat: NumberFormat,
	transform: (raw: number) => number = (raw) => raw
): ParameterOccurrence[] {
	const lines = text.split(/\r?\n/);
	const occurrences: ParameterOccurrence[] = [];
	const seen = new Set<string>();

	lines.forEach((lineText, index) => {
		const lineNumber = index + 1;

		for (const pattern of patterns) {
			// Use a fresh global-flagged copy so exec() can walk every match on
			// the line without mutating the shared pattern's lastIndex.
			const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
			const globalPattern = new RegExp(pattern.source, flags);

			let match: RegExpExecArray | null;
			while ((match = globalPattern.exec(lineText)) !== null) {
				if (match[0].length === 0) {
					globalPattern.lastIndex++;
					continue;
				}
				if (!match[1]) {
					continue;
				}

				const raw = parseNumberByLocale(match[1], numberFormat);
				if (Number.isNaN(raw)) {
					continue;
				}

				const value = transform(raw);
				const key = `${lineNumber}::${value}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);

				occurrences.push({ value, lineNumber, context: lineText.trim() });
			}
		}
	});

	return occurrences;
}

function buildExtractedParameter(occurrences: ParameterOccurrence[]): ExtractedFinancialParameter {
	return {
		value: occurrences.length > 0 ? occurrences[0].value : 0,
		found: occurrences.length > 0,
		occurrences,
	};
}

// Matches one full formatted numeric value made of digits and any mix of
// `.`/`,` separators and grouping spaces - WITHOUT swallowing trailing
// punctuation that isn't actually part of the number. A flat `[\d.,]+`
// would happily consume a sentence-ending period right after the number
// (e.g. "...$10.000,50."), producing a mangled multi-dot string that then
// confuses `parseNumberByLocale`'s separator-role detection. Requiring the
// match to both START and END on an actual digit fixes that: the engine
// backtracks off any trailing separator that isn't itself followed by
// another digit. Grouping spaces cover Russian-style "10 000" and OCR
// NBSPs; they are stripped again inside `parseNumberByLocale`.
const NUMBER_GROUPING_SPACE = "\u00A0\u2007\u2009\u202F ";
const LOCALE_NUMBER = String.raw`\d(?:[\d.,${NUMBER_GROUPING_SPACE}]*\d)?`;

interface FinancialKeywordGroups {
	basePrice: string[];
	indexation: string[];
	penalty: string[];
}

/**
 * Language-specific keywords used to locate base price, indexation, and
 * penalty/fine clauses in contract text. `resolveFinancialPatterns`
 * selects English, Russian, or both depending on the Contract Language
 * setting (`auto` concatenates the two groups).
 */
const FINANCIAL_PATTERNS: Record<"en" | "ru", FinancialKeywordGroups> = {
	en: {
		basePrice: ["base price", "total fee", "fixed sum"],
		indexation: ["indexation", "annual increase", "price adjustment"],
		penalty: ["penalty", "late payment", "fine"],
	},
	ru: {
		basePrice: ["базовая цена", "стоимость услуг", "цена составляет", "сумма договора"],
		indexation: ["индексация", "ежегодное повышение"],
		penalty: ["пени", "штраф", "просрочка"],
	},
};

function resolveFinancialPatterns(language: ContractLanguage): FinancialKeywordGroups {
	if (language === "en") {
		return FINANCIAL_PATTERNS.en;
	}
	if (language === "ru") {
		return FINANCIAL_PATTERNS.ru;
	}
	return {
		basePrice: [...FINANCIAL_PATTERNS.en.basePrice, ...FINANCIAL_PATTERNS.ru.basePrice],
		indexation: [...FINANCIAL_PATTERNS.en.indexation, ...FINANCIAL_PATTERNS.ru.indexation],
		penalty: [...FINANCIAL_PATTERNS.en.penalty, ...FINANCIAL_PATTERNS.ru.penalty],
	};
}

function includesEnglishPatterns(language: ContractLanguage): boolean {
	return language === "auto" || language === "en";
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileKeywordAlternation(keywords: string[]): string {
	return keywords
		.map((keyword) => keyword.trim())
		.filter((keyword) => keyword.length > 0)
		.sort((a, b) => b.length - a.length)
		.map((keyword) => flexCyrillicKeyword(keyword))
		.join("|");
}

/**
 * Keeps English phrases exact. For Russian, allows typical case endings on
 * the last word so "просрочка" also matches "просрочку"/"просрочки" without
 * listing every inflection in FINANCIAL_PATTERNS.
 */
function flexCyrillicKeyword(keyword: string): string {
	const originalParts = keyword.split(/\s+/);
	const escapedParts = originalParts.map((part) => escapeRegExpLiteral(part));
	if (!/[\u0400-\u04FF]/.test(keyword)) {
		return escapedParts.join(String.raw`\s+`);
	}

	const lastOrig = originalParts[originalParts.length - 1];
	let last = escapedParts[escapedParts.length - 1];
	if (lastOrig.length <= 4) {
		last = `${last}\\p{L}{0,2}`;
	} else if (/[аеёиоуыэюяьй]$/i.test(lastOrig)) {
		last = `${last.slice(0, -1)}\\p{L}{1,3}`;
	} else {
		last = `${last}\\p{L}{0,3}`;
	}
	escapedParts[escapedParts.length - 1] = last;
	return escapedParts.join(String.raw`\s+`);
}

/** Unicode-aware whole-phrase bound: `\b` is ASCII-only and would miss Cyrillic. */
function boundKeywordAlts(alts: string): string {
	return String.raw`(?<![\p{L}\p{N}_])(?:${alts})(?![\p{L}\p{N}_])`;
}

const CURRENCY_PREFIX = String.raw`(?:(?:\$|€|£|₽)\s*|(?:USD|EUR|GBP|RUB|RUR)\s+)`;
const CURRENCY_SUFFIX = String.raw`(?:\s*(?:USD|EUR|GBP|RUB|RUR|руб(?:лей|ля|ль|\.)?|dollars?|euros?|rubles?))`;
const OPTIONAL_MD_MARK = String.raw`\*{0,2}`;
// Filler tokens between a keyword and its number (e.g. "rate of", "составляет")
// that must not themselves look like the start of an amount.
const NON_AMOUNT_FILLER = String.raw`(?:(?![\$€£₽\d+\-])\S+\s+){0,2}`;

function buildAmountPatterns(keywords: string[]): RegExp[] {
	const alts = compileKeywordAlternation(keywords);
	if (!alts) {
		return [];
	}
	const bounded = boundKeywordAlts(alts);
	return [
		// "base price: $10,000", "базовая цена: 10 000 руб.", "fixed sum of $10.000,50"
		new RegExp(
			String.raw`${bounded}\s*${NON_AMOUNT_FILLER}[:\-–—]?\s*${CURRENCY_PREFIX}?${OPTIONAL_MD_MARK}(${LOCALE_NUMBER})${OPTIONAL_MD_MARK}(?:${CURRENCY_SUFFIX})?(?!\s*%)`,
			"iu"
		),
		// "$10,000 base price", "10 000 рублей - базовая цена"
		new RegExp(
			String.raw`${CURRENCY_PREFIX}?${OPTIONAL_MD_MARK}(${LOCALE_NUMBER})${OPTIONAL_MD_MARK}(?:${CURRENCY_SUFFIX})?\s*${NON_AMOUNT_FILLER}${bounded}`,
			"iu"
		),
	];
}

function buildRatePatterns(keywords: string[]): RegExp[] {
	const alts = compileKeywordAlternation(keywords);
	if (!alts) {
		return [];
	}
	const bounded = boundKeywordAlts(alts);
	return [
		// "indexation: 5%", "штраф: 1%", "penalty rate of **1.5%**"
		new RegExp(
			String.raw`${bounded}\s*${NON_AMOUNT_FILLER}[:\-–—]?\s*${OPTIONAL_MD_MARK}([+-]?${LOCALE_NUMBER})${OPTIONAL_MD_MARK}\s*%`,
			"iu"
		),
		// "5% annual indexation", "1% пени", "5% ежегодное повышение"
		new RegExp(
			String.raw`([+-]?${LOCALE_NUMBER})\s*%\s*${NON_AMOUNT_FILLER}${bounded}`,
			"iu"
		),
	];
}

function extractBasePrice(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage = "auto"
): ExtractedFinancialParameter {
	const keywords = resolveFinancialPatterns(language).basePrice;
	const patterns = [
		...buildAmountPatterns(keywords),
		// English-only fallbacks that aren't in FINANCIAL_PATTERNS but
		// cover existing vault wording ("contract price", generic "Price: $").
		...(includesEnglishPatterns(language)
			? [
					new RegExp(String.raw`contract\s*price\s*[:\-]?\s*\$\s?(${LOCALE_NUMBER})`, "i"),
					new RegExp(String.raw`\$\s?(${LOCALE_NUMBER})\s*(?:contract\s*price)`, "i"),
					new RegExp(String.raw`\bprice\s*[:\-]?\s*\$\s?(${LOCALE_NUMBER})`, "i"),
			  ]
			: []),
	];
	const occurrences = findAllRegexMatches(text, patterns, numberFormat);
	return buildExtractedParameter(occurrences);
}

interface ParsedFinancialEntity {
	/** Original match including the currency marker, e.g. `$10.000,50` or `EUR 2.500`. */
	displayValue: string;
	numericValue: number;
	lineNumber: number;
	lineText: string;
}

/**
 * Currency/price scanner used by the "Currency & Prices" findings table and
 * Total Contract Value. Unlike the generic keyword scan, this:
 *   1. Captures the FULL formatted numeric string (dots AND commas) via
 *      `LOCALE_NUMBER`, so `$10.000,50` is taken whole rather than cut off
 *      at `$10.000`.
 *   2. Hands that entire string to `parseNumberByLocale`.
 *   3. Emits a row only when the capture is a real number plus a currency
 *      marker - words like "penalty" / "Price" never become a Found Value.
 */
function parseFinancialEntities(text: string, numberFormat: NumberFormat): ParsedFinancialEntity[] {
	const patterns = [
		// $10.000,50  $1,000.00  $2.500
		new RegExp(String.raw`\$\s?(${LOCALE_NUMBER})`, "g"),
		// €10.000,50  £1,000.00
		new RegExp(String.raw`[€£]\s?(${LOCALE_NUMBER})`, "g"),
		// 10.000,50 EUR  1,000.00 dollars
		new RegExp(
			String.raw`(${LOCALE_NUMBER})\s?(?:USD|EUR|GBP|RUB|€|£|rubles?|dollars?|euros?)\b`,
			"gi"
		),
		// USD 10.000,50  EUR 2.500
		new RegExp(String.raw`\b(?:USD|EUR|GBP|RUB)\s?(${LOCALE_NUMBER})`, "gi"),
	];

	const lines = text.split(/\r?\n/);
	const entities: ParsedFinancialEntity[] = [];

	lines.forEach((lineText, index) => {
		const lineNumber = index + 1;
		if (isIgnorableSourceLine(lineText)) {
			return;
		}
		const candidates: Array<ParsedFinancialEntity & { start: number; end: number }> = [];

		for (const pattern of patterns) {
			const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
			const globalPattern = new RegExp(pattern.source, flags);

			let match: RegExpExecArray | null;
			while ((match = globalPattern.exec(lineText)) !== null) {
				if (match[0].length === 0) {
					globalPattern.lastIndex++;
					continue;
				}

				const numericRaw = match[1];
				if (!numericRaw) {
					continue;
				}

				const numericValue = parseNumberByLocale(numericRaw, numberFormat);
				if (Number.isNaN(numericValue)) {
					continue;
				}

				const displayValue = match[0].trim();
				if (!displayValue || !/\d/.test(displayValue)) {
					continue;
				}

				candidates.push({
					displayValue,
					numericValue,
					lineNumber,
					lineText,
					start: match.index,
					end: match.index + match[0].length,
				});
			}
		}

		// Prefer the leftmost, then longest match so `$10.000,50 EUR` does
		// not become two Found Values (and two additions to TCV).
		candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
		const kept: typeof candidates = [];
		for (const candidate of candidates) {
			const overlaps = kept.some((k) => candidate.start < k.end && candidate.end > k.start);
			if (overlaps) {
				continue;
			}
			kept.push(candidate);
		}

		for (const candidate of kept) {
			entities.push({
				displayValue: candidate.displayValue,
				numericValue: candidate.numericValue,
				lineNumber: candidate.lineNumber,
				lineText: candidate.lineText,
			});
		}
	});

	return entities;
}

function extractIndexationRate(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage = "auto"
): ExtractedFinancialParameter {
	const occurrences = findAllRegexMatches(
		text,
		buildRatePatterns(resolveFinancialPatterns(language).indexation),
		numberFormat,
		(raw) => raw / 100
	);
	return buildExtractedParameter(occurrences);
}

function extractPenaltyRate(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage = "auto"
): ExtractedFinancialParameter {
	const keywords = resolveFinancialPatterns(language).penalty;
	const patterns = [
		...buildRatePatterns(keywords),
		// English-only fallbacks for vault wording that uses "fee" / "per day"
		// without one of the FINANCIAL_PATTERNS penalty keywords.
		...(includesEnglishPatterns(language)
			? [
					new RegExp(
						String.raw`([+-]?${LOCALE_NUMBER})\s*%\s*(?:daily\s*)?(?:late\s*)?fee`,
						"i"
					),
					new RegExp(
						String.raw`(?:late\s*)?fee\s*(?:rate)?\s*[:\-]?\s*([+-]?${LOCALE_NUMBER})\s*%`,
						"i"
					),
					new RegExp(String.raw`([+-]?${LOCALE_NUMBER})\s*%\s*(?:per\s*day|daily)\b`, "i"),
			  ]
			: []),
	];
	const occurrences = findAllRegexMatches(text, patterns, numberFormat, (raw) => raw / 100);
	return buildExtractedParameter(occurrences);
}

interface ExtractedTextField {
	value: string;
	context: string;
	found: boolean;
	numericValue?: number;
	/** True when the value came from a loan/commitment clause, not a service-fee fallback. */
	isLoanCommitment?: boolean;
}

interface PenaltyTriggerField {
	trigger: string;
	consequence: string;
	found: boolean;
}

interface CoreFinancialTerms {
	commitment: ExtractedTextField;
	interest: ExtractedTextField;
	maturity: ExtractedTextField;
	latePayment: PenaltyTriggerField;
	eventOfDefault: PenaltyTriggerField;
}

const MISSING_FIELD = "N/A";
/** Optional straight/curly quote after a defined term: `"Applicable Margin"` */
const CLOSING_QUOTE = String.raw`['"‘’“”]?`;

function missingTextField(): ExtractedTextField {
	return { value: MISSING_FIELD, context: MISSING_FIELD, found: false };
}

function missingPenaltyField(): PenaltyTriggerField {
	return { trigger: MISSING_FIELD, consequence: MISSING_FIELD, found: false };
}

function collapseExtractableText(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !isIgnorableSourceLine(line))
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ")
		.replace(/\s+/g, " ");
}

function clipContext(text: string, maxLength = 140): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (!cleaned) {
		return MISSING_FIELD;
	}
	return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

function firstRegexMatch(haystack: string, patterns: RegExp[]): RegExpExecArray | null {
	for (const pattern of patterns) {
		const match = pattern.exec(haystack);
		if (match?.[0]) {
			return match;
		}
	}
	return null;
}

function extractLoanCommitment(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage,
	formatCurrency: (value: number) => string
): ExtractedTextField {
	const haystack = collapseExtractableText(text);
	const amount = String.raw`\$\s?(${LOCALE_NUMBER})`;
	const patterns = [
		new RegExp(
			String.raw`aggregate\s+revolving\s+loan\s+commitment${CLOSING_QUOTE}\s+means[\s\S]{0,280}?${amount}`,
			"i"
		),
		new RegExp(String.raw`shall\s+initially\s+be\s+in\s+the\s+amount\s+of\s+${amount}`, "i"),
		new RegExp(
			String.raw`(?:aggregate\s+)?(?:revolving\s+)?loan\s+commitments?\b[\s\S]{0,160}?${amount}`,
			"i"
		),
		new RegExp(
			String.raw`(?:total|maximum|aggregate)\s+(?:loan|commitment|facility)\s+(?:amount\s+)?(?:of\s+|is\s+|[:\-]\s*)?${amount}`,
			"i"
		),
		new RegExp(String.raw`(?:commitment|loan)\s+amount\s*(?:of\s+|is\s+|[:\-]\s*)?${amount}`, "i"),
	];

	const match = firstRegexMatch(haystack, patterns);
	if (match?.[1]) {
		const numericValue = parseNumberByLocale(match[1], numberFormat);
		if (!Number.isNaN(numericValue)) {
			return {
				value: formatCurrency(numericValue),
				context: clipContext(match[0]),
				found: true,
				numericValue,
				isLoanCommitment: true,
			};
		}
	}

	const base = extractBasePrice(text, numberFormat, language);
	if (base.found) {
		const occurrence = base.occurrences[0];
		return {
			value: formatCurrency(base.value),
			context: occurrence
				? clipContext(occurrence.context)
				: "Contract price (no loan commitment stated)",
			found: true,
			numericValue: base.value,
		};
	}

	return missingTextField();
}

function extractInterestRate(text: string): ExtractedTextField {
	const haystack = collapseExtractableText(text);
	const applicableMargin = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`applicable\s+margin${CLOSING_QUOTE}\s+means\s+([\s\S]{20,320}?)(?:\.(?=\s|$))`,
			"i"
		),
	]);
	if (applicableMargin?.[1]) {
		const definition = applicableMargin[1].replace(/\s+/g, " ").trim();
		return {
			value: `LIBOR or Base Rate + Applicable Margin (${definition})`,
			context: clipContext(applicableMargin[0]),
			found: true,
		};
	}

	const floating = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`each\s+loan\s+shall\s+bear\s+interest[\s\S]{0,240}?(?:libor|base\s+rate)[\s\S]{0,120}?applicable\s+margin`,
			"i"
		),
		new RegExp(
			String.raw`rate\s+per\s+annum\s+equal\s+to\s+([\s\S]{10,160}?applicable\s+margin)`,
			"i"
		),
		new RegExp(
			String.raw`shall\s+bear\s+interest[\s\S]{0,80}?(?:at\s+the\s+base\s+rate|at\s+libor)[\s\S]{0,80}?applicable\s+margin`,
			"i"
		),
	]);
	if (floating?.[0]) {
		return {
			value: clipContext(floating[1] || floating[0], 180),
			context: clipContext(floating[0]),
			found: true,
		};
	}

	const statedRate = firstRegexMatch(haystack, [
		new RegExp(String.raw`interest\s+rate\s*[:\-]\s*([+-]?${LOCALE_NUMBER}\s*%)`, "i"),
		new RegExp(
			String.raw`(?:annual|per\s+annum)\s+interest\s+(?:rate\s+)?(?:of\s+|is\s+|[:\-]\s*)?([+-]?${LOCALE_NUMBER}\s*%)`,
			"i"
		),
		new RegExp(
			String.raw`bear(?:s|ing)?\s+interest\s+(?:at\s+|of\s+)?([+-]?${LOCALE_NUMBER}\s*%(?:\s*per\s+annum)?)`,
			"i"
		),
	]);
	if (statedRate?.[1]) {
		return {
			value: statedRate[1].replace(/\s+/g, " ").trim(),
			context: clipContext(statedRate[0]),
			found: true,
		};
	}

	return missingTextField();
}

function extractPaymentSchedule(text: string): ExtractedTextField {
	const haystack = collapseExtractableText(text);
	const parts: string[] = [];
	const contexts: string[] = [];

	const termination = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`revolving\s+termination\s+date${CLOSING_QUOTE}\s+means\s+the\s+earlier\s+to\s+occur\s+of:\s*\(?a\)?\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})`,
			"i"
		),
		new RegExp(String.raw`maturity\s+date\s*[:\-]\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})`, "i"),
	]);
	if (termination?.[1]) {
		parts.push(`Maturity / termination: ${termination[1].replace(/\s+/g, " ").trim()}`);
		contexts.push(termination[0]);
	}

	const interestDate = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`interest\s+payment\s+date${CLOSING_QUOTE}\s+means\s+([\s\S]{20,280}?)(?:\.(?=\s|$))`,
			"i"
		),
		new RegExp(
			String.raw`interest\s+on\s+each\s+loan\s+shall\s+be\s+paid\s+in\s+arrears\s+on\s+each\s+interest\s+payment\s+date`,
			"i"
		),
	]);
	if (interestDate?.[0]) {
		parts.push(
			interestDate[1]
				? `Interest: ${interestDate[1].replace(/\s+/g, " ").trim()}`
				: "Interest paid in arrears on each Interest Payment Date"
		);
		contexts.push(interestDate[0]);
	}

	const dated = firstRegexMatch(haystack, [
		new RegExp(String.raw`dated\s+as\s+of\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})`, "i"),
		new RegExp(String.raw`effective\s+date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})`, "i"),
	]);
	if (dated?.[1]) {
		parts.push(`Dated / effective: ${dated[1].replace(/\s+/g, " ").trim()}`);
		contexts.push(dated[0]);
	}

	const payable = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`payable\s+on\s+the\s+(\d{1,2}(?:st|nd|rd|th)?\s+of\s+each\s+month|first\s+(?:day\s+)?of\s+each\s+month)`,
			"i"
		),
	]);
	if (payable?.[1]) {
		parts.push(`Payable on the ${payable[1].replace(/\s+/g, " ").trim()}`);
		contexts.push(payable[0]);
	}

	if (parts.length === 0) {
		return missingTextField();
	}

	return {
		value: parts.join("; "),
		context: clipContext(contexts[0] || parts[0]),
		found: true,
	};
}

function inferLateTrigger(context: string): string {
	if (/fails?\s+to\s+pay|non-payment|when\s+(?:and\s+as\s+)?(?:required\s+to\s+be\s+)?due/i.test(context)) {
		return "Failure to pay principal, interest, or other amounts when due";
	}
	if (/просроч/i.test(context)) {
		return "Просрочка оплаты";
	}
	if (/late\s+payment/i.test(context)) {
		return "Late payment";
	}
	if (/per\s+day|daily|в\s+день/i.test(context)) {
		return "Each day payment remains outstanding";
	}
	if (/per\s+month|в\s+месяц/i.test(context)) {
		return "Each month payment remains outstanding";
	}
	return "Late or missed payment";
}

function extractLatePaymentFee(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage,
	formatPercent: (value: number) => string
): PenaltyTriggerField {
	const haystack = collapseExtractableText(text);
	const defaultInterest = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`adding\s+two\s+percent\s+\(2\.0%\)\s+per\s+annum\s+to\s+the\s+applicable\s+margin`,
			"i"
		),
		new RegExp(
			String.raw`default\s+(?:rate|interest)[\s\S]{0,80}?([+-]?${LOCALE_NUMBER}\s*%(?:\s*per\s+annum)?)`,
			"i"
		),
	]);

	const simpleLate = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`late\s+(?:payments?|fees?|charges?)[\s\S]{0,80}?([+-]?${LOCALE_NUMBER}\s*%(?:\s*per\s+(?:day|month|annum))?)`,
			"i"
		),
		new RegExp(
			String.raw`([+-]?${LOCALE_NUMBER}\s*%)\s*(?:per\s+(?:day|month)|в\s+(?:день|месяц))\s*(?:late\s*)?(?:fee|penalty|штраф|пени)?`,
			"i"
		),
		new RegExp(
			String.raw`(?:штраф|пени)[\s\S]{0,40}?([+-]?${LOCALE_NUMBER}\s*%(?:\s*в\s+(?:день|месяц))?)`,
			"i"
		),
	]);

	const penalty = extractPenaltyRate(text, numberFormat, language);

	if (simpleLate?.[1]) {
		return {
			trigger: inferLateTrigger(simpleLate[0]),
			consequence: simpleLate[1].replace(/\s+/g, " ").trim(),
			found: true,
		};
	}

	if (defaultInterest?.[0]) {
		return {
			trigger:
				"Failure to pay principal, interest, or L/C reimbursement when due (other amounts: 3 Business Days)",
			consequence: defaultInterest[1]
				? `${defaultInterest[1].replace(/\s+/g, " ").trim()} default interest added to Applicable Margin`
				: "+2.00% per annum added to the Applicable Margin (default interest)",
			found: true,
		};
	}

	if (penalty.found) {
		const occurrence = penalty.occurrences[0];
		const context = occurrence?.context ?? "";
		return {
			trigger: inferLateTrigger(context),
			consequence: formatPercent(penalty.value),
			found: true,
		};
	}

	return missingPenaltyField();
}

function extractEventOfDefault(text: string): PenaltyTriggerField {
	const haystack = collapseExtractableText(text);
	const triggerMatch = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`non-payment\.\s+any\s+credit\s+party\s+fails[\s\S]{0,400}?three\s+\(3\)\s+business\s+days`,
			"i"
		),
		new RegExp(
			String.raw`any\s+of\s+the\s+following\s+shall\s+constitute\s+an\s+['"‘’“”]event\s+of\s+default['"‘’“”][:\s]*([\s\S]{20,280})`,
			"i"
		),
		new RegExp(String.raw`event\s+of\s+default[\s\S]{0,40}?(?:includes?|means)[\s\S]{0,200}`, "i"),
	]);

	const consequenceMatch = firstRegexMatch(haystack, [
		new RegExp(
			String.raw`declare\s+all\s+or\s+any\s+portion\s+of\s+the\s+unpaid\s+principal[\s\S]{0,200}?immediately\s+due\s+and\s+payable`,
			"i"
		),
		new RegExp(
			String.raw`shall\s+automatically\s+(?:terminate[\s\S]{0,160}?)?become\s+(?:due\s+and\s+)?payable`,
			"i"
		),
		new RegExp(
			String.raw`cash\s+equal\s+to\s+105%\s+of\s+the\s+amount\s+of\s+l\/c\s+reimbursement\s+obligations`,
			"i"
		),
	]);

	if (!triggerMatch && !consequenceMatch) {
		return missingPenaltyField();
	}

	const trigger = triggerMatch
		? clipContext(triggerMatch[1] || triggerMatch[0], 180)
		: MISSING_FIELD;
	let consequence = MISSING_FIELD;
	if (consequenceMatch?.[0]) {
		const extras: string[] = [
			clipContext(consequenceMatch[0], 160),
		];
		if (/105%/.test(haystack) && !/105%/.test(consequenceMatch[0])) {
			extras.push("105% cash collateral for L/C obligations");
		}
		if (/adding\s+two\s+percent\s+\(2\.0%\)/i.test(haystack)) {
			extras.push("+2.00% default interest");
		}
		consequence = extras.join("; ");
	}

	return {
		trigger,
		consequence,
		found: true,
	};
}

function extractCoreFinancialTerms(
	text: string,
	numberFormat: NumberFormat,
	language: ContractLanguage,
	formatCurrency: (value: number) => string,
	formatPercent: (value: number) => string
): CoreFinancialTerms {
	return {
		commitment: extractLoanCommitment(text, numberFormat, language, formatCurrency),
		interest: extractInterestRate(text),
		maturity: extractPaymentSchedule(text),
		latePayment: extractLatePaymentFee(text, numberFormat, language, formatPercent),
		eventOfDefault: extractEventOfDefault(text),
	};
}

// Contract identifiers explicitly labeled with a keyword, in priority order.
// Matches e.g. "Contract ID: 102-PRO", "Contract Number 45", "Contract #102",
// "Agreement No. 2024-01", "Договор № 102". Each English keyword token is
// followed by a negative lookahead for a lowercase letter so "id"/"no" only
// match as a whole keyword, not as a prefix fragment inside a longer word
// (without this, "contract identifier" would match "id" from "identifier"
// and then greedily capture the rest of that word - "entifier" - as a fake
// contract ID).
//
// When an ID is found, `filterPaymentsByContractId` keeps only CSV rows
// whose `contract_id` matches it; if extraction fails, every parsed row
// is included in reconciliation.
const CONTRACT_ID_CAPTURE = String.raw`([A-Za-z0-9][A-Za-z0-9\-\/]{1,19})`;
const CONTRACT_ID_PATTERNS: RegExp[] = [
	new RegExp(
		String.raw`\bcontract\s*(?:id(?![a-z])|number(?![a-z])|no\.?(?![a-z]))\s*[:#]?\s*${CONTRACT_ID_CAPTURE}`,
		"i"
	),
	new RegExp(String.raw`\bcontract\s*#\s*${CONTRACT_ID_CAPTURE}`, "i"),
	new RegExp(
		String.raw`\bagreement\s*(?:id(?![a-z])|number(?![a-z])|no\.?(?![a-z]))?\s*[:#]?\s*${CONTRACT_ID_CAPTURE}`,
		"i"
	),
	// "Договор № 102", "Договор No. 2024-01", "Договор номер 102-PRO"
	new RegExp(
		String.raw`договор(?:\s+\S+){0,8}?\s*(?:№|n[oо]\.?|номер|#)\s*${CONTRACT_ID_CAPTURE}`,
		"iu"
	),
];

// Fallback for a bare hash-prefixed token like "#102-PRO" with no "Contract"/
// "Agreement" keyword nearby. Requires a digit immediately after the "#" so
// it doesn't grab arbitrary words, and is only tried on lines that don't
// start with "#" so Markdown ATX headings (e.g. "# 2026 Overview") aren't
// mistaken for a contract ID.
const BARE_CONTRACT_ID_PATTERN = /#\s?(\d[A-Za-z0-9\-\/]{0,19})\b/;

/**
 * Detects a contract identifier anywhere in the text (e.g. "#102-PRO",
 * "Contract #102", "Agreement No. 2024-01", "Договор № 102"). Returns the
 * first one found - keyword-labeled forms are checked before the bare
 * "#id" fallback - or `null` if none is found.
 */
function extractContractID(text: string): string | null {
	for (const pattern of CONTRACT_ID_PATTERNS) {
		const match = text.match(pattern);
		if (match && match[1]) {
			return normalizeContractId(match[1]);
		}
	}

	for (const lineText of text.split(/\r?\n/)) {
		if (lineText.trimStart().startsWith("#")) {
			continue;
		}
		const match = lineText.match(BARE_CONTRACT_ID_PATTERN);
		if (match && match[1]) {
			return normalizeContractId(match[1]);
		}
	}

	return null;
}

function normalizeContractId(rawId: string): string {
	return rawId
		.trim()
		.replace(/^[#№]+\s*/, "")
		.replace(/[.,;:]+$/, "");
}

function contractIdsMatch(csvContractId: string, extractedId: string): boolean {
	return normalizeContractId(csvContractId).toLowerCase() === normalizeContractId(extractedId).toLowerCase();
}

/**
 * Interactive entry point for running an audit: lets the user explicitly
 * pick the contract file (Markdown, text, or PDF) and the payments CSV
 * from dropdowns populated with the vault's actual files, instead of the
 * plugin silently guessing from whatever the "active file" happens to be.
 * The payments CSV is optional - leaving it unselected skips financial
 * validation but still runs the rest of the audit (findings table, risk
 * badge, etc.) on the selected contract file.
 */
class AuditSelectionModal extends Modal {
	private selectedContractPath: string | null;
	private selectedCsvPath: string | null;

	constructor(
		app: App,
		private readonly contractFiles: TFile[],
		defaultContractPath: string | null,
		defaultCsvPath: string | null,
		private readonly onStart: (contractFile: TFile, csvFile: TFile | null) => void
	) {
		super(app);
		this.selectedContractPath = defaultContractPath;
		this.selectedCsvPath = defaultCsvPath;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Run Revenue Audit" });
		contentEl.createEl("p", {
			text: "Choose the contract file and the payments CSV to reconcile it against.",
		});

		new Setting(contentEl)
			.setName("Contract file")
			.setDesc("Markdown, text, or PDF file to audit.")
			.addDropdown((dropdown) => {
				if (this.contractFiles.length === 0) {
					dropdown.addOption("", "(no eligible files found in vault)");
					dropdown.setDisabled(true);
					return;
				}
				for (const file of this.contractFiles) {
					dropdown.addOption(file.path, file.path);
				}
				dropdown.setValue(this.selectedContractPath ?? this.contractFiles[0].path);
				dropdown.onChange((value) => {
					this.selectedContractPath = value;
				});
			});

		new Setting(contentEl)
			.setName("Payments CSV")
			.setDesc(
				"CSV of payment rows to validate against the contract's extracted terms. Optional - leave as \"none\" to skip financial validation."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "(none - skip financial validation)");
				const csvFiles = listVaultCsvFiles(this.app);
				for (const file of csvFiles) {
					dropdown.addOption(file.path, csvDropdownLabel(file));
				}
				const availablePaths = new Set(csvFiles.map((file) => file.path));
				const initial =
					this.selectedCsvPath && availablePaths.has(this.selectedCsvPath)
						? this.selectedCsvPath
						: "";
				dropdown.setValue(initial);
				this.selectedCsvPath = initial.length > 0 ? initial : null;
				dropdown.onChange((value) => {
					this.selectedCsvPath = value.length > 0 ? value : null;
				});
			});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Start Audit")
				.setCta()
				.onClick(() => {
					this.handleStart();
				});
		});
	}

	private handleStart(): void {
		if (!this.selectedContractPath) {
			new Notice("Select a contract file before starting the audit.");
			return;
		}

		const contractFile = this.app.vault.getAbstractFileByPath(this.selectedContractPath);
		if (!(contractFile instanceof TFile)) {
			new Notice(`Could not find "${this.selectedContractPath}" in the vault.`);
			return;
		}

		let csvFile: TFile | null = null;
		if (this.selectedCsvPath) {
			const candidate = this.app.vault.getAbstractFileByPath(this.selectedCsvPath);
			if (candidate instanceof TFile) {
				csvFile = candidate;
			}
		}

		this.close();
		this.onStart(contractFile, csvFile);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Lets the user pick a vault folder of contracts. The plugin then walks
 * that folder for `.md` / `.pdf` files and runs the regular audit
 * pipeline against each one, writing `03_Audit_Reports/Batch_Audit_Summary.md`
 * when the sweep finishes.
 */
class BatchAuditFolderModal extends Modal {
	private selectedFolderPath: string;
	private includeSubfolders = true;
	private statusEl: HTMLParagraphElement | null = null;

	constructor(
		app: App,
		private readonly folders: TFolder[],
		defaultFolderPath: string,
		private readonly onStart: (folder: TFolder, includeSubfolders: boolean) => void
	) {
		super(app);
		this.selectedFolderPath = defaultFolderPath;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Run Batch Audit on Folder" });
		contentEl.createEl("p", {
			text: "Select the folder that holds the contracts. Revenue Auditor will scan it for Markdown and PDF files and run the current audit pipeline on each one.",
		});

		new Setting(contentEl)
			.setName("Contracts folder")
			.setDesc("Vault directory to scan for .md / .pdf contracts.")
			.addDropdown((dropdown) => {
				if (this.folders.length === 0) {
					dropdown.addOption("", "(no folders found)");
					dropdown.setDisabled(true);
					return;
				}
				for (const folder of this.folders) {
					const value = folderDropdownValue(folder);
					dropdown.addOption(value, folder.isRoot() ? "(vault root)" : folder.path);
				}
				dropdown.setValue(this.selectedFolderPath);
				dropdown.onChange((value) => {
					this.selectedFolderPath = value;
					this.refreshStatus();
				});
			});

		new Setting(contentEl)
			.setName("Include subfolders")
			.setDesc("Also audit .md / .pdf files nested under the selected folder. The Analysis folder is skipped.")
			.addToggle((toggle) => {
				toggle.setValue(this.includeSubfolders).onChange((value) => {
					this.includeSubfolders = value;
					this.refreshStatus();
				});
			});

		this.statusEl = contentEl.createEl("p", { cls: "revenue-auditor-batch-status" });
		this.refreshStatus();

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Start Batch Audit")
				.setCta()
				.onClick(() => {
					this.handleStart();
				});
		});
	}

	private resolveSelectedFolder(): TFolder | null {
		if (this.selectedFolderPath === VAULT_ROOT_FOLDER_KEY || this.selectedFolderPath === "") {
			return this.app.vault.getRoot();
		}
		const found = this.app.vault.getAbstractFileByPath(this.selectedFolderPath);
		return found instanceof TFolder ? found : null;
	}

	private refreshStatus(): void {
		if (!this.statusEl) {
			return;
		}
		const folder = this.resolveSelectedFolder();
		if (!folder) {
			this.statusEl.setText("Select a folder to preview how many contracts will be audited.");
			return;
		}
		const count = collectBatchContractFiles(folder, this.includeSubfolders).length;
		this.statusEl.setText(
			`${count} contract file${count === 1 ? "" : "s"} (.md / .pdf) in scope.`
		);
	}

	private handleStart(): void {
		const folder = this.resolveSelectedFolder();
		if (!folder) {
			new Notice("Select a contracts folder before starting the batch audit.");
			return;
		}
		const files = collectBatchContractFiles(folder, this.includeSubfolders);
		if (files.length === 0) {
			new Notice("No .md or .pdf contract files found in that folder.");
			return;
		}
		this.close();
		this.onStart(folder, this.includeSubfolders);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class RevenueAuditorPlugin extends Plugin {
	settings: RevenueAuditorSettings;

	// Extractors are tried in this order for a file that supports more
	// than one adapter (currently just PDF): DoclingLocalExtractor first
	// (preferred - richer, layout-aware local conversion once a real
	// Docling install is present), falling back to the proven
	// PdfParseExtractor if Docling isn't installed or its CLI call fails.
	// MarkdownExtractor is the only adapter for .md/.markdown/.txt, so it
	// always "wins" for those without any fallback needed.
	private documentExtractors: DocumentExtractorRegistry;
	private statusBarEl: HTMLElement | null = null;
	private auditsInFlight = 0;
	private readonly logger = new PluginLogger();
	private statusPhase: AuditorStatusPhase = "ready";
	private statusDetail: string | undefined;
	private statusAnimationTimer: number | null = null;
	private lastAuditContext: {
		contractFile?: string;
		csvFile?: string;
		phase?: string;
		lastError?: string;
	} = {};

	async onload() {
		try {
			await this.loadSettings();
			this.addSettingTab(new RevenueAuditorSettingTab(this.app, this));

			this.documentExtractors = this.buildDocumentExtractors();

			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass("revenue-auditor-status");
			this.setAuditorStatus("ready");

			this.registerObsidianProtocolHandler(BUG_REPORT_PROTOCOL, (params) => {
				if (params.cmd === BUG_REPORT_CMD) {
					void this.copyBugReportToClipboard();
				}
			});
			this.registerMarkdownPostProcessor((el) => {
				this.enhanceBugReportLinks(el);
			});

			this.addRibbonIcon("dollar-sign", "Run revenue audit", () => {
				this.openAuditModal();
			});

			this.addCommand({
				id: "run-audit",
				name: "Run Audit",
				callback: () => {
					this.openAuditModal();
				},
			});

			this.addCommand({
				id: "run-revenue-audit-on-current-file",
				name: "Run Revenue Audit on Current File",
				callback: () => {
					this.runAuditOnCurrentFile();
				},
			});

			this.addCommand({
				id: "open-audit-dashboard",
				name: "Open Audit Dashboard",
				callback: () => {
					void this.openAuditDashboard().catch((error: unknown) => {
						this.logger.error("Failed to open audit dashboard.", error);
						new Notice(`Could not open audit dashboard: ${this.describeError(error)}`);
					});
				},
			});

			this.addCommand({
				id: "run-batch-audit-on-folder",
				name: "Run Batch Audit on Folder",
				callback: () => {
					this.openBatchAuditModal();
				},
			});

			this.addCommand({
				id: "copy-bug-report",
				name: "Copy Bug Report to Clipboard",
				callback: () => {
					void this.copyBugReportToClipboard();
				},
			});
		} catch (error: unknown) {
			// If setup itself fails, log it but let the plugin finish
			// loading rather than throwing out of onload().
			this.logger.error("Failed to initialize.", error);
			new Notice("Revenue Auditor failed to initialize. Check the developer console for details.");
		}
	}

	onunload(): void {
		this.stopStatusAnimation();
	}

	/**
	 * Builds a fresh `DocumentExtractorRegistry` from the current settings.
	 * Called once at load time and again every time settings are saved
	 * (see `saveSettings()`), so changes to the Docling binary/Python
	 * path, timeout, OCR toggle, or contract language take effect
	 * immediately without requiring a plugin reload.
	 */
	private buildDocumentExtractors(): DocumentExtractorRegistry {
		return new DocumentExtractorRegistry([
			new MarkdownExtractor(),
			new DoclingLocalExtractor({
				binaryPath: this.settings.doclingBinaryPath,
				pythonPath: this.settings.pythonPath,
				timeoutMs: this.settings.cliTimeoutMs,
				enableOcr: this.settings.enableOcr,
				ocrLanguage: CONTRACT_LANGUAGE_TO_OCR_LANG[this.settings.contractLanguage] ?? undefined,
			}),
			new PdfParseExtractor(),
		]);
	}

	/**
	 * Opens the interactive Audit Selection modal, letting the user pick
	 * exactly which contract file and payments CSV to reconcile, instead
	 * of guessing from whatever happens to be the active file/view.
	 */
	private openAuditModal(): void {
		const contractFiles = this.app.vault
			.getFiles()
			.filter(
				(file) =>
					CONTRACT_FILE_EXTENSIONS.has(file.extension.toLowerCase()) && !isAuditHistoryFile(file)
			)
			.sort((a, b) => a.path.localeCompare(b.path));

		const csvFiles = listVaultCsvFiles(this.app);

		// Pre-select the currently active file if it's a valid contract
		// type, and the conventional payments CSV path if it exists - the
		// user can freely change either before starting the audit.
		const activeFile = this.app.workspace.getActiveFile();
		const defaultContractPath =
			activeFile && CONTRACT_FILE_EXTENSIONS.has(activeFile.extension.toLowerCase())
				? activeFile.path
				: contractFiles[0]?.path ?? null;
		const configuredCsv = this.app.vault.getAbstractFileByPath(this.settings.defaultPaymentsCsvPath);
		const defaultCsvPath =
			configuredCsv instanceof TFile && isVaultCsvFile(configuredCsv)
				? configuredCsv.path
				: csvFiles[0]?.path ?? null;

		new AuditSelectionModal(
			this.app,
			contractFiles,
			defaultContractPath,
			defaultCsvPath,
			(contractFile, csvFile) => {
				this.startAudit(contractFile, csvFile);
			}
		).open();
	}

	/**
	 * Command Palette entry: audit whatever note (or PDF) is currently
	 * active, using `payments.csv` when it is present and non-empty.
	 * Missing/empty ledgers skip reconciliation instead of aborting.
	 */
	private runAuditOnCurrentFile(): void {
		const contractFile = this.app.workspace.getActiveFile();
		if (!contractFile) {
			new Notice("Revenue Auditor: no active file to audit.");
			return;
		}
		if (
			!CONTRACT_FILE_EXTENSIONS.has(contractFile.extension.toLowerCase()) ||
			isAuditHistoryFile(contractFile)
		) {
			new Notice(
				"Revenue Auditor: open a contract file (Markdown, text, or PDF) to run an audit."
			);
			return;
		}

		this.startAudit(contractFile, null);
	}

	/**
	 * Opens the folder picker, then sweeps every eligible `.md` / `.pdf`
	 * under the chosen directory through the regular audit pipeline.
	 */
	private openBatchAuditModal(): void {
		const folders = listVaultFolders(this.app.vault.getRoot());
		const activeFile = this.app.workspace.getActiveFile();
		const activeFolder = activeFile?.parent ?? null;
		const contractsFolder = this.app.vault.getAbstractFileByPath(VAULT_FOLDER_CONTRACTS);
		const defaultFolder =
			activeFolder ?? (contractsFolder instanceof TFolder ? contractsFolder : this.app.vault.getRoot());

		new BatchAuditFolderModal(this.app, folders, folderDropdownValue(defaultFolder), (folder, includeSubfolders) => {
			void this.runBatchAudit(folder, includeSubfolders).catch((error: unknown) => {
				this.lastAuditContext.lastError = this.describeError(error);
				this.logger.error("Batch audit failed.", error);
				new Notice(`Batch audit failed: ${this.describeError(error)}`);
			});
		}).open();
	}

	/**
	 * Runs extraction, keyword checks, and reconciliation for every
	 * contract in `folder`, then writes / overwrites `Batch_Audit_Summary.md`
	 * under `03_Audit_Reports/`. Individual report files are not created
	 * during a batch run - the portfolio table is the batch deliverable.
	 */
	private async runBatchAudit(folder: TFolder, includeSubfolders: boolean): Promise<void> {
		const files = collectBatchContractFiles(folder, includeSubfolders);
		if (files.length === 0) {
			new Notice("Revenue Auditor: no .md or .pdf contracts found in that folder.");
			return;
		}

		this.beginAuditWork("batch");
		this.lastAuditContext = {
			contractFile: folder.isRoot() ? "(vault root)" : folder.path,
			phase: "batch",
		};
		try {
			this.logger.info(
				`Batch audit started: ${files.length} file(s) in "${folder.isRoot() ? "(vault root)" : folder.path}".`
			);
			new Notice(`Revenue Auditor: batch audit started (${files.length} file${files.length === 1 ? "" : "s"}).`);
			await ensureVaultAnalysisFolder(this.app);
			await ensureVaultAuditReportsFolder(this.app);
			const loadedPayments = await this.loadPaymentsFromCsv(null, { quiet: true });
			const rows: BatchAuditRow[] = [];

			for (let index = 0; index < files.length; index++) {
				const contractFile = files[index];
				this.setAuditorStatus("batch", `${index + 1}/${files.length}`);
				this.logger.info(`Batch item ${index + 1}/${files.length}: ${contractFile.path}`);
				rows.push(await this.auditContractForBatch(contractFile, loadedPayments));
			}

			const summaryFile = await this.writeBatchAuditSummary(folder, includeSubfolders, loadedPayments, rows);
			const paymentsFile =
				loadedPayments.kind === "parsed"
					? this.app.vault.getAbstractFileByPath(loadedPayments.path)
					: null;
			const organized = await organizeAuditWorkspace(
				this.app,
				{
					paymentsFile: paymentsFile instanceof TFile ? paymentsFile : null,
					reportFile: summaryFile,
				},
				this.logger
			);
			await this.syncPaymentsCsvSetting(organized.paymentsFile);

			const reportToOpen = organized.reportFile ?? summaryFile;
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.openFile(reportToOpen);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			new Notice(`Batch audit complete: ${reportToOpen.path}`);
		} finally {
			this.endAuditWork();
		}
	}

	private async auditContractForBatch(
		contractFile: TFile,
		loadedPayments: PaymentsCsvLoadResult
	): Promise<BatchAuditRow> {
		try {
			const report = await this.auditContractFile(contractFile, loadedPayments, {
				includeAiAnalysis: false,
				quietExtraction: true,
			});
			const reconciliationStatus = mapBatchReconciliationStatus(
				report.csvLedgerSkipped,
				report.reconciliation.status
			);
			const legalRisk = classifyLegalRisk({
				riskKeywordCount: report.riskKeywordCount,
				penaltyFound: report.penaltyFound,
				reconciliationStatus,
				ledgerSkipped: report.csvLedgerSkipped,
				expectedValue: report.reconciliation.expectedContractValue,
				outstandingBalance: report.reconciliation.outstandingBalance,
			});
			return {
				filePath: contractFile.path,
				clientLabel: report.contractId
					? `${contractFile.basename} / ${report.contractId}`
					: contractFile.basename,
				detectedAmount: report.totalValue,
				reconciliationStatus,
				legalRisk,
				error: null,
			};
		} catch (error: unknown) {
			this.logger.warn(`Batch audit failed for "${contractFile.path}": ${this.describeError(error)}`);
			return {
				filePath: contractFile.path,
				clientLabel: contractFile.basename,
				detectedAmount: 0,
				reconciliationStatus: "Discrepancy",
				legalRisk: "High",
				error: this.describeError(error),
			};
		}
	}

	private async writeBatchAuditSummary(
		folder: TFolder,
		includeSubfolders: boolean,
		loadedPayments: PaymentsCsvLoadResult,
		rows: BatchAuditRow[]
	): Promise<TFile> {
		const stamp = formatAuditStamp(new Date());
		const scopeLabel = folder.isRoot() ? "(vault root)" : folder.path;
		const ledgerLabel = loadedPayments.kind === "parsed" ? `\`${loadedPayments.path}\`` : "_Unavailable_";
		const matched = rows.filter((row) => row.reconciliationStatus === "Matched").length;
		const discrepancy = rows.filter((row) => row.reconciliationStatus === "Discrepancy").length;
		const overpaid = rows.filter((row) => row.reconciliationStatus === "Overpaid").length;
		const highRisk = rows.filter((row) => row.legalRisk === "High").length;
		const failed = rows.filter((row) => row.error).length;

		const table = [
			"| File / Client | Detected Amount | Reconciliation Status | Legal Risk |",
			"| :--- | ---: | :---: | :---: |",
			...rows.map((row) => {
				const amount = row.error ? "—" : this.formatCurrency(row.detectedAmount);
				const status = row.error ? "Discrepancy" : row.reconciliationStatus;
				return `| ${this.escapeCell(row.clientLabel)} | ${this.escapeCell(amount)} | ${status} | ${row.legalRisk} |`;
			}),
		];

		const body = [
			"# Batch Audit Summary",
			"",
			"**Prepared by:** Revenue Auditor",
			"",
			`**Engagement date:** ${stamp.timestamp}`,
			"",
			`**Scope:** \`${scopeLabel}\` (${rows.length} file${rows.length === 1 ? "" : "s"}${
				includeSubfolders ? ", including subfolders" : ""
			})`,
			"",
			`**Payments ledger:** ${ledgerLabel}`,
			"",
			"---",
			"",
			"## 1. Portfolio snapshot",
			"",
			"| Metric | Count |",
			"| :--- | ---: |",
			`| Contracts reviewed | ${rows.length} |`,
			`| Matched | ${matched} |`,
			`| Discrepancy | ${discrepancy} |`,
			`| Overpaid | ${overpaid} |`,
			`| High legal risk | ${highRisk} |`,
			...(failed > 0 ? [`| Extraction / pipeline failures | ${failed} |`] : []),
			"",
			"---",
			"",
			"## 2. Engagement findings",
			"",
			...table,
			"",
			"---",
			"",
			"## 3. Methodology",
			"",
			"Each file was processed through the standard Revenue Auditor pipeline: document extraction, keyword risk flags, amount detection, and ledger reconciliation where a payments CSV is available. Legal risk is scored from risk-keyword density, penalty clauses, and material payment variance. AI analysis is omitted in batch mode.",
			"",
			...this.buildFeedbackSection(),
		].join("\n");

		const destPath = vaultJoin(AUDIT_REPORTS_FOLDER, BATCH_AUDIT_SUMMARY_FILENAME);
		const existing = this.app.vault.getAbstractFileByPath(destPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, body);
			return existing;
		}
		await ensureVaultAuditReportsFolder(this.app);
		return this.app.vault.create(destPath, body);
	}

	/**
	 * Opens `Analysis/Audit_Index.md` in the current leaf. Creates the
	 * folder and an empty table if none exist yet so the command is usable
	 * before the first audit has been run.
	 */
	private async openAuditDashboard(): Promise<void> {
		await this.appendAnalysisAuditIndexRow();
		const indexPath = vaultJoin(ANALYSIS_FOLDER, AUDIT_INDEX_FILENAME);
		let file = this.app.vault.getAbstractFileByPath(indexPath);
		if (!(file instanceof TFile)) {
			new Notice(`Revenue Auditor: could not open "${indexPath}".`);
			return;
		}

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/**
	 * Resolves the payments ledger from the file the user picked in the
	 * audit modal, then falls back to conventional vault paths.
	 */
	private getPaymentsCsvFile(preferred: TFile | null): TFile | null {
		const paths: string[] = [];
		if (preferred && isVaultCsvFile(preferred)) {
			paths.push(preferred.path);
		}
		const configured = (this.settings.defaultPaymentsCsvPath || DEFAULT_SETTINGS.defaultPaymentsCsvPath).trim();
		paths.push(
			`${VAULT_FOLDER_PAYMENTS}/payments.csv`,
			configured,
			"Payments/payments.csv",
			"payments.csv"
		);

		const seen = new Set<string>();
		for (const path of paths) {
			if (!path || seen.has(path)) {
				continue;
			}
			seen.add(path);
			try {
				const found = this.app.vault.getAbstractFileByPath(path);
				if (found instanceof TFile && isVaultCsvFile(found)) {
					return found;
				}
			} catch (error: unknown) {
				console.warn(`Revenue Auditor: vault lookup failed for "${path}".`, error);
			}
		}
		return null;
	}

	private startAudit(contractFile: TFile, csvFile: TFile | null): void {
		this.lastAuditContext = {
			contractFile: contractFile.path,
			csvFile: csvFile?.path,
			phase: "starting",
		};
		// Never let a rejection become an unhandled promise rejection -
		// report it to the user via a Notice instead.
		this.runAudit(contractFile, csvFile).catch((error: unknown) => {
			this.lastAuditContext.lastError = this.describeError(error);
			this.logger.error("Audit run failed.", error);
			if (error instanceof OperationTimeoutError) {
				// Call site already showed a specific Notice.
				return;
			}
			new Notice(`Audit failed: ${this.describeError(error)}`);
		});
	}

	private setAuditorStatus(phase: AuditorStatusPhase, detail?: string): void {
		this.statusPhase = phase;
		this.statusDetail = detail;
		this.lastAuditContext.phase = detail ? `${phase} ${detail}` : phase;
		this.redrawStatusBar(0);
		this.stopStatusAnimation();
		if (phase !== "ready") {
			let frame = 0;
			this.statusAnimationTimer = window.setInterval(() => {
				frame += 1;
				this.redrawStatusBar(frame);
			}, 400);
		}
	}

	private redrawStatusBar(frame: number): void {
		if (!this.statusBarEl) {
			return;
		}
		const busy = this.statusPhase !== "ready";
		this.statusBarEl.toggleClass("is-busy", busy);
		this.statusBarEl.empty();
		this.statusBarEl.createSpan({ cls: "revenue-auditor-spinner", attr: { "aria-hidden": "true" } });
		const dots = busy ? ".".repeat((frame % 3) + 1) : "";
		this.statusBarEl.createSpan({
			cls: "revenue-auditor-status-label",
			text: `${this.statusLabelFor(this.statusPhase, this.statusDetail)}${dots}`,
		});
	}

	private statusLabelFor(phase: AuditorStatusPhase, detail?: string): string {
		switch (phase) {
			case "parsing":
				return "🔍 Parsing document";
			case "analyzing":
				return "🧠 Analyzing risks";
			case "reconciling":
				return "📊 Reconciling";
			case "writing":
				return "✍️ Writing report";
			case "batch":
				return detail ? `📦 Batch ${detail}` : "📦 Batch audit";
			case "starting":
				return "Revenue Auditor: Starting";
			default:
				return "Revenue Auditor: Ready";
		}
	}

	private stopStatusAnimation(): void {
		if (this.statusAnimationTimer !== null) {
			window.clearInterval(this.statusAnimationTimer);
			this.statusAnimationTimer = null;
		}
	}

	private beginAuditWork(phase: AuditorStatusPhase = "starting"): void {
		this.auditsInFlight++;
		this.setAuditorStatus(phase);
	}

	private endAuditWork(): void {
		this.auditsInFlight = Math.max(0, this.auditsInFlight - 1);
		this.setAuditorStatus(this.auditsInFlight > 0 ? "starting" : "ready");
	}

	private getParseTimeoutMs(): number {
		const configured = this.settings.cliTimeoutMs;
		return Number.isFinite(configured) && configured > 0 ? configured : OPERATION_TIMEOUT_MS;
	}

	private getAiTimeoutMs(): number {
		return aiRequestTimeoutMs(this.settings);
	}

	private async auditContractFile(
		contractFile: TFile,
		loadedPayments: PaymentsCsvLoadResult,
		options?: { includeAiAnalysis?: boolean; quietExtraction?: boolean }
	): Promise<AuditReportBuildResult> {
		const source = await this.readContractSource(contractFile, { quiet: options?.quietExtraction === true });
		return this.buildAuditReport(source.text, contractFile.name, loadedPayments, {
			includeAiAnalysis: options?.includeAiAnalysis,
		});
	}

	private async runAudit(contractFile: TFile, csvFile: TFile | null): Promise<void> {
		this.beginAuditWork("starting");
		this.logger.info(`Audit started for "${contractFile.path}"${csvFile ? ` with ledger "${csvFile.path}"` : ""}.`);
		try {
			await ensureVaultAnalysisFolder(this.app);
			await ensureVaultAuditReportsFolder(this.app);
			// Resolve the ledger before any long PDF/Docling work so a
			// missing/renamed payments.csv surfaces immediately.
			// A null csvFile means the user chose "(none)" in the modal —
			// do not fall back to a default payments.csv.
			let loadedPayments: PaymentsCsvLoadResult;
			if (csvFile === null) {
				this.logger.info("Audit running without payment reconciliation (CSV skipped).");
				loadedPayments = { kind: "skipped" };
			} else {
				loadedPayments = await this.loadPaymentsFromCsv(csvFile);
			}
			const report = await this.auditContractFile(contractFile, loadedPayments);

			this.setAuditorStatus("writing");
			const reportFile = await this.saveAuditHistory(contractFile, report);
			const paymentsFile =
				loadedPayments.kind === "parsed"
					? this.app.vault.getAbstractFileByPath(loadedPayments.path)
					: csvFile;
			const organized = await organizeAuditWorkspace(
				this.app,
				{
					contractFile,
					paymentsFile: paymentsFile instanceof TFile ? paymentsFile : csvFile,
					reportFile,
				},
				this.logger
			);
			await this.syncPaymentsCsvSetting(organized.paymentsFile);
			const reportToOpen = organized.reportFile ?? reportFile;

			const leaf = this.app.workspace.getLeaf(true);
			await leaf.openFile(reportToOpen);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });

			this.logger.info(`Audit complete: ${reportToOpen.path}`);
			if (organized.movedCount > 0) {
				new Notice(
					`Revenue Auditor: moved ${organized.movedCount} leftover report file${
						organized.movedCount === 1 ? "" : "s"
					} into ${AUDIT_REPORTS_FOLDER}/.`
				);
			}
			if (report.csvLedgerSkipped) {
				new Notice('Revenue Auditor: CSV ledger not found, skipped reconciliation');
			} else {
				new Notice(`Audit complete: ${reportToOpen.path}`);
			}
		} finally {
			this.endAuditWork();
		}
	}

	/**
	 * Writes a unique timestamped Markdown report + JSON sidecar under
	 * `03_Audit_Reports/` only, then appends a row to `Analysis/Audit_Index.md`
	 * with a wikilink to that report. Never creates report files in `Analysis/`.
	 */
	private async saveAuditHistory(contractFile: TFile, report: AuditReportBuildResult): Promise<TFile> {
		const folder = await this.requireAuditReportsFolder();
		const { basename, stamp } = this.allocateAuditBasename(folder);

		const payload: AuditReportJson = {
			timestamp: stamp.timestamp,
			contract_file: contractFile.name,
			total_value: Math.round(report.reconciliation.expectedContractValue * 100) / 100,
			findings: report.findings,
		};

		const reportFile = await this.app.vault.create(
			vaultJoin(folder, `${basename}.md`),
			report.markdown
		);
		await this.app.vault.create(
			vaultJoin(folder, `${basename}.json`),
			JSON.stringify(payload, null, 2)
		);
		await this.appendAnalysisAuditIndexRow({ basename, payload });
		return reportFile;
	}

	private async requireAuditReportsFolder(): Promise<string> {
		await ensureVaultAuditReportsFolder(this.app);
		const existing = this.app.vault.getAbstractFileByPath(AUDIT_REPORTS_FOLDER);
		if (existing instanceof TFolder) {
			return AUDIT_REPORTS_FOLDER;
		}
		throw new Error(`Revenue Auditor: could not create or open the "${AUDIT_REPORTS_FOLDER}" folder.`);
	}

	private allocateAuditBasename(folder: string): { basename: string; stamp: AuditStamp } {
		let date = new Date();
		for (let i = 0; i < 60; i++) {
			const stamp = formatAuditStamp(date);
			const basename = `Audit_${stamp.fileStamp}`;
			if (!this.auditBasenameTaken(basename, folder)) {
				return { basename, stamp };
			}
			date = new Date(date.getTime() + 1000);
		}
		const stamp = formatAuditStamp(new Date());
		return { basename: `Audit_${stamp.fileStamp}_${Date.now()}`, stamp };
	}

	/** True when `Audit_*.md` / `Audit_*.json` already exist in reports or Analysis. */
	private auditBasenameTaken(basename: string, reportsFolder: string): boolean {
		const names = [`${basename}.md`, `${basename}.json`];
		for (const name of names) {
			if (this.app.vault.getAbstractFileByPath(vaultJoin(reportsFolder, name))) {
				return true;
			}
			if (this.app.vault.getAbstractFileByPath(vaultJoin(ANALYSIS_FOLDER, name))) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Locates `Analysis/Audit_Index.md` (creating the folder and a header-only
	 * table if needed), parses the markdown table, and inserts a new row for
	 * the report just written to `03_Audit_Reports/`. The Link cell is a
	 * wikilink such as `[[Audit_2026-09-08_142037]]`. Newest audits sit
	 * directly under the header. This method never writes report files into
	 * `Analysis/` and never writes `Audit_Index.md` at the vault root or in
	 * `03_Audit_Reports`.
	 */
	private async appendAnalysisAuditIndexRow(
		latest?: { basename: string; payload: AuditReportJson }
	): Promise<void> {
		const indexPath = vaultJoin(ANALYSIS_FOLDER, AUDIT_INDEX_FILENAME);
		const folder = this.app.vault.getAbstractFileByPath(ANALYSIS_FOLDER);
		if (!folder) {
			try {
				await this.app.vault.createFolder(ANALYSIS_FOLDER);
			} catch (error: unknown) {
				const raced = this.app.vault.getAbstractFileByPath(ANALYSIS_FOLDER);
				if (!(raced instanceof TFolder)) {
					console.warn(`Revenue Auditor: could not create "${ANALYSIS_FOLDER}".`, error);
					return;
				}
			}
		} else if (!(folder instanceof TFolder)) {
			console.warn(
				`Revenue Auditor: "${ANALYSIS_FOLDER}" exists but is not a folder; cannot update Audit_Index.md.`
			);
			return;
		}

		const emptyTable = ["# Audit Index", "", AUDIT_INDEX_TABLE_HEADER, AUDIT_INDEX_TABLE_SEPARATOR, ""].join(
			"\n"
		);
		const existing = this.app.vault.getAbstractFileByPath(indexPath);

		if (!latest) {
			if (existing instanceof TFile) {
				return;
			}
			await this.app.vault.create(indexPath, emptyTable);
			return;
		}

		const row = this.formatAuditIndexRow(latest.basename, latest.payload);
		if (!(existing instanceof TFile)) {
			await this.app.vault.create(
				indexPath,
				["# Audit Index", "", AUDIT_INDEX_TABLE_HEADER, AUDIT_INDEX_TABLE_SEPARATOR, row, ""].join("\n")
			);
			return;
		}

		const current = await this.app.vault.read(existing);
		if (current.includes(`[[${latest.basename}]]`)) {
			return;
		}
		await this.app.vault.modify(existing, insertAuditIndexTableRow(current, row));
	}

	private formatAuditIndexRow(basename: string, parsed: AuditReportJson): string {
		const displayDate =
			typeof parsed.timestamp === "string" && parsed.timestamp.length >= 16
				? parsed.timestamp.slice(0, 16)
				: basename.replace(/^Audit_/, "").replace(/_/g, " ");
		const contractName =
			typeof parsed.contract_file === "string" && parsed.contract_file
				? parsed.contract_file
				: "(unknown)";
		const totalValue =
			typeof parsed.total_value === "number" && !Number.isNaN(parsed.total_value)
				? this.formatCurrency(parsed.total_value)
				: "—";
		const findingsCount = Array.isArray(parsed.findings) ? parsed.findings.length : 0;

		return `| ${this.escapeCell(displayDate)} | ${this.escapeCell(contractName)} | ${this.escapeCell(
			totalValue
		)} | ${findingsCount} | [[${basename}]] |`;
	}

	private async syncPaymentsCsvSetting(paymentsFile: TFile | null): Promise<void> {
		if (!paymentsFile) {
			return;
		}
		const current = (this.settings.defaultPaymentsCsvPath || "").trim();
		if (current === paymentsFile.path) {
			return;
		}
		const configured = current ? this.app.vault.getAbstractFileByPath(current) : null;
		const stale =
			!current ||
			current === "Payments/payments.csv" ||
			current === "payments.csv" ||
			current === DEFAULT_SETTINGS.defaultPaymentsCsvPath ||
			!(configured instanceof TFile);
		if (!stale) {
			return;
		}
		this.settings.defaultPaymentsCsvPath = paymentsFile.path;
		await this.saveSettings();
	}

	private describeError(error: unknown): string {
		return describeUnknownError(error);
	}

	private buildFeedbackSection(): string[] {
		return [
			"---",
			"",
			"## Feedback",
			"",
			"If this report looks wrong or the plugin hung, use **Report a Bug** to copy a pre-filled issue template (settings snapshot + recent logs) to the clipboard.",
			"",
			`[Report a Bug](${BUG_REPORT_URI})`,
			"",
		];
	}

	private enhanceBugReportLinks(el: HTMLElement): void {
		const anchors = el.querySelectorAll(`a[href="${BUG_REPORT_URI}"]`);
		anchors.forEach((anchor) => {
			const button = createEl("button", {
				cls: "revenue-auditor-report-bug-button",
				text: "Report a Bug",
			});
			button.type = "button";
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.copyBugReportToClipboard();
			});
			anchor.replaceWith(button);
		});
	}

	private async copyBugReportToClipboard(): Promise<void> {
		const report = this.buildBugReportTemplate();
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(report);
			} else {
				this.copyTextFallback(report);
			}
			this.logger.info("Bug report copied to clipboard.");
			new Notice("Revenue Auditor: bug report copied to the clipboard. Paste it into a GitHub issue.");
		} catch (error: unknown) {
			this.logger.error("Failed to copy bug report.", error);
			new Notice(`Could not copy bug report: ${this.describeError(error)}`);
		}
	}

	private copyTextFallback(text: string): void {
		const textarea = document.body.createEl("textarea", {
			attr: { readonly: "true" },
		});
		textarea.value = text;
		textarea.setCssStyles({
			position: "fixed",
			opacity: "0",
		});
		textarea.select();
		const copied = document.execCommand("copy");
		textarea.remove();
		if (!copied) {
			throw new Error("Clipboard is not available in this environment.");
		}
	}

	private buildBugReportTemplate(): string {
		const redactedSettings = {
			...this.settings,
			apiKey: this.settings.apiKey.trim() ? "[redacted]" : "(empty)",
		};
		const platform = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "unknown";
		return [
			"## Bug report",
			"",
			"**Plugin:** Revenue Auditor",
			`**Plugin version:** ${this.manifest.version}`,
			`**Obsidian API:** ${apiVersion}`,
			`**Platform:** ${platform}`,
			`**Vault:** ${this.app.vault.getName()}`,
			"",
			"### Last audit context",
			"",
			`- Contract: ${this.lastAuditContext.contractFile ?? "(none)"}`,
			`- Payments CSV: ${this.lastAuditContext.csvFile ?? "(none)"}`,
			`- Last phase: ${this.lastAuditContext.phase ?? "(none)"}`,
			`- Last error: ${this.lastAuditContext.lastError ?? "(none)"}`,
			"",
			"### Settings (API key redacted)",
			"",
			"```json",
			JSON.stringify(redactedSettings, null, 2),
			"```",
			"",
			"### Recent plugin logs",
			"",
			"```",
			this.logger.formatForBugReport(),
			"```",
			"",
			"### What happened",
			"",
			"1. ",
			"2. ",
			"",
			"### Expected behavior",
			"",
			"",
		].join("\n");
	}

	/**
	 * Reads the Number Format setting with a defensive fallback to "auto" -
	 * guards against an older/corrupted `data.json` that predates this
	 * setting (or somehow has it unset) rather than passing `undefined`
	 * through to `parseNumberByLocale` and friends.
	 */
	private getNumberFormat(): NumberFormat {
		return this.settings.numberFormat ?? "auto";
	}

	private getContractLanguage(): ContractLanguage {
		return this.settings.contractLanguage ?? "auto";
	}

	/**
	 * Reads the text to audit from the user's explicitly selected contract
	 * file via the `DocumentExtractorRegistry` (see documentExtractors.ts):
	 * resolves the file's absolute filesystem path, then lets the registry
	 * pick and, if needed, fall back between adapters based on the file's
	 * extension - Markdown/text is read directly, PDFs are tried against
	 * the local Docling CLI first and the proven pdf-parse pipeline second.
	 */
	private async readContractSource(
		file: TFile,
		options?: { quiet?: boolean }
	): Promise<{ text: string; label: string }> {
		const absolutePath = this.resolveAbsolutePath(file);
		if (!absolutePath) {
			// No filesystem adapter (e.g. an unusual vault backend) - fall
			// back to the Vault API directly for plain text files rather
			// than failing outright. PDFs still need a real path, since
			// both the Docling CLI and pdf-parse extractors operate on
			// disk.
			if (file.extension.toLowerCase() !== "pdf") {
				const text = sanitizeExtractedText(await this.app.vault.read(file));
				return { text, label: `Markdown/text file (${file.name}, read via Vault API)` };
			}
			return {
				text: "",
				label: `PDF "${file.name}" - could not resolve an absolute filesystem path for extraction.`,
			};
		}

		this.setAuditorStatus("parsing");
		if (file.extension.toLowerCase() === "pdf" && !options?.quiet) {
			new Notice(`Parsing PDF "${file.name}"…`);
		}

		const parseTimeoutMs = this.getParseTimeoutMs();
		this.logger.info(`Parsing "${file.path}" (timeout ${Math.round(parseTimeoutMs / 1000)}s).`);
		let result: ExtractedDocument;
		try {
			result = await withTimeout(
				this.documentExtractors.extract(absolutePath),
				parseTimeoutMs,
				"Document parsing (Docling)"
			);
		} catch (error: unknown) {
			if (error instanceof OperationTimeoutError) {
				this.logger.error(error.message);
				if (!options?.quiet) {
					new Notice(
						`Revenue Auditor: ${error.message} Parsing was stopped so Obsidian would not hang. Try a smaller PDF, adjust the CLI timeout, or check the Docling path.`
					);
				}
			} else {
				this.logger.error(`Document parsing failed for "${file.path}".`, error);
			}
			throw error;
		}
		this.logger.info(`Parsed "${file.path}" via ${result.label} (${result.text.length} chars).`);
		if (result.requiresOcr) {
			// Deliberately a Notice, not just a console.warn: this is an
			// actionable condition the user needs to see and fix (flip the
			// OCR toggle in settings), not a background diagnostic.
			new Notice(
				result.error ??
					"This PDF appears to be a scanned document. Please enable OCR in Revenue Auditor settings to process it."
			);
		} else if (result.error) {
			this.logger.warn(`Extraction issue for "${file.path}": ${result.error}`);
		}
		return { text: sanitizeExtractedText(result.text), label: result.label };
	}

	/**
	 * Resolves a vault-relative `TFile` to an absolute filesystem path,
	 * which the extractor adapters operate on (deliberately decoupled from
	 * Obsidian's Vault API - see documentExtractors.ts). Returns `null` if
	 * the current vault adapter isn't filesystem-backed (e.g. some sync
	 * providers) - callers should fall back to `app.vault.read()` in that
	 * case.
	 */
	private resolveAbsolutePath(file: TFile): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getFullPath(file.path) : null;
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<RevenueAuditorSettings> | undefined;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Rebuild immediately so a changed Docling path/timeout/OCR toggle
		// takes effect on the very next audit, without requiring the user
		// to reload the plugin.
		this.documentExtractors = this.buildDocumentExtractors();
	}

	private buildEntityCategories(): EntityCategory[] {
		const financialKeywords = this.parseKeywordList(this.settings.financialKeywords);
		const riskKeywords = this.parseKeywordList(this.settings.riskKeywords);

		return [
			{
				// Populated by parseFinancialEntities (not these patterns):
				// that scanner captures the full locale-formatted amount and
				// drops any non-numeric keyword hits so Found Value stays
				// "parsed number + currency marker" only.
				entityType: "Currency & Prices",
				patterns: [],
				emptyMessage: "No prices or currency amounts detected.",
			},
			{
				entityType: "Dates & Deadlines",
				patterns: [
					// 2026-09-01
					/\b\d{4}-\d{2}-\d{2}\b/g,
					// 09/01/2026 or 1-9-2026
					/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
					// Jan 1st, January 1st, 2026, Sep 1
					/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\b/gi,
					// within 30 days, within 2 weeks, within 6 months
					/\bwithin\s+\d+\s+(?:day|days|week|weeks|month|months)\b/gi,
				],
				emptyMessage: "No dates or deadlines detected.",
			},
			{
				// Kept separate from "Currency & Prices" on purpose: these
				// are plain keyword matches (e.g. "price", "total"), not
				// parsed numeric amounts, so mixing them into the currency
				// table would put text like "penalty" in a column that's
				// supposed to contain only currency-tagged numbers - and
				// would silently pollute calculateTotalContractValue's sum
				// if any keyword ever happened to look numeric.
				entityType: "Financial Keywords",
				patterns: this.buildKeywordPatterns(financialKeywords),
				emptyMessage: "No financial keywords detected.",
			},
			{
				entityType: "Risk Keywords",
				patterns: this.buildKeywordPatterns(riskKeywords),
				emptyMessage: "No risk keywords detected.",
			},
		];
	}

	private parseKeywordList(raw: string): string[] {
		return raw
			.split(",")
			.map((keyword) => keyword.trim())
			.filter((keyword) => keyword.length > 0);
	}

	private buildKeywordPatterns(keywords: string[]): RegExp[] {
		if (keywords.length === 0) {
			return [];
		}
		const escaped = keywords.map((keyword) => this.escapeRegExp(keyword));
		return [new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi")];
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private async buildAuditReport(
		contractText: string,
		contractFileName: string,
		loadedPayments: PaymentsCsvLoadResult,
		options?: { includeAiAnalysis?: boolean }
	): Promise<AuditReportBuildResult> {
		contractText = sanitizeExtractedText(contractText);
		const lines = contractText.split(/\r?\n/);
		const numberFormat = this.getNumberFormat();
		const contractLanguage = this.getContractLanguage();
		const categorizedMatches = this.buildEntityCategories().map((category) => {
			if (category.entityType === "Currency & Prices") {
				const entities = parseFinancialEntities(contractText, numberFormat);
				return {
					category,
					matches: entities.map(
						(entity): EntityMatch => ({
							entityType: category.entityType,
							value: entity.displayValue,
							lineNumber: entity.lineNumber,
							lineText: entity.lineText,
							numericValue: entity.numericValue,
						})
					),
				};
			}
			return { category, matches: this.findMatches(lines, category) };
		});

		const currencyMatches =
			categorizedMatches.find((c) => c.category.entityType === "Currency & Prices")
				?.matches ?? [];

		const formatPercent = (value: number) => this.formatPercent(value);
		const coreTerms = extractCoreFinancialTerms(
			contractText,
			numberFormat,
			contractLanguage,
			(value) => this.formatCurrency(value),
			formatPercent
		);
		const summedCurrency = this.calculateTotalContractValue(currencyMatches);
		const totalContractValue =
			coreTerms.commitment.isLoanCommitment && typeof coreTerms.commitment.numericValue === "number"
				? coreTerms.commitment.numericValue
				: summedCurrency.total;

		this.setAuditorStatus("reconciling");
		this.logger.info("Reconciling payments against extracted contract value.");
		const skipFinancialReconciliation = loadedPayments.kind !== "parsed";
		const contractId = extractContractID(contractText);
		const ledgerRecords =
			loadedPayments.kind === "parsed"
				? filterPaymentsByContractId(loadedPayments.records, contractId).records
				: [];
		const reconciliation = new ReconciliationEngine().reconcile(totalContractValue, ledgerRecords);
		const findings: string[] = [];
		const expected = reconciliation.expectedContractValue;
		const actual = reconciliation.receivedPayments;
		if (expected !== actual) {
			findings.push("DISCREPANCY");
		}
		const auditStamp = formatAuditStamp(new Date());
		const engagementStatus = this.formatEngagementStatus(
			reconciliation,
			skipFinancialReconciliation
		);

		const structuredFindings: FindingTableRow[] = [];
		if (contractId) {
			structuredFindings.push({
				classification: "Contract Identifier",
				value: contractId,
				context: "—",
			});
		}
		this.pushExtractedParameterRow(
			structuredFindings,
			"Base Price",
			extractBasePrice(contractText, numberFormat, contractLanguage),
			(value) => this.formatCurrency(value)
		);
		this.pushExtractedParameterRow(
			structuredFindings,
			"Annual Indexation Rate",
			extractIndexationRate(contractText, numberFormat, contractLanguage),
			(value) => this.formatPercent(value)
		);
		const penaltyParameter = extractPenaltyRate(contractText, numberFormat, contractLanguage);
		this.pushExtractedParameterRow(
			structuredFindings,
			"Daily Penalty Rate",
			penaltyParameter,
			(value) => this.formatPercent(value)
		);
		if (findings.includes("DISCREPANCY")) {
			structuredFindings.push({
				classification: "DISCREPANCY",
				value: `${this.formatCurrency(expected)} !== ${this.formatCurrency(actual)}`,
				context: "Expected contract value does not match received payments.",
			});
		}

		const riskKeywordCount =
			categorizedMatches.find((c) => c.category.entityType === "Risk Keywords")?.matches.length ?? 0;
		const includeAiAnalysis = options?.includeAiAnalysis !== false;
		const aiPrep = prepareContractTextForAi(contractText);
		const aiRiskAnalysis = includeAiAnalysis ? await this.runAiRiskAnalysis(aiPrep) : "";

		return {
			markdown: [
				"# Executive Audit Memorandum",
				"",
				`**Document:** ${contractFileName}`,
				"",
				`**Audit Date:** ${auditStamp.timestamp}`,
				"",
				`**Reconciliation Status:** ${engagementStatus}`,
				"",
				"---",
				"",
				"## 1. Executive Summary",
				"",
				`- **Expected Contract Value:** ${this.formatCurrency(reconciliation.expectedContractValue)}`,
				`- **Received Payments:** ${this.formatCurrency(reconciliation.receivedPayments)}`,
				`- **Variance / Outstanding Balance:** ${this.formatCurrency(
					reconciliation.outstandingBalance
				)}`,
				"",
				...(includeAiAnalysis ? [...formatAiRiskAnalysisCallout(aiRiskAnalysis), ""] : []),
				"---",
				"",
				"## 2. Transaction Reconciliation Matrix",
				"",
				...this.buildReconciliationPaymentsTable(ledgerRecords),
				"",
				"---",
				"",
				"## 3. Contract Findings & Risk Analysis",
				"",
				...this.buildCoreFinancialTables(coreTerms),
				"",
				...this.buildFindingsTable(categorizedMatches, structuredFindings),
				"",
				"---",
				"",
				"## 4. Source Reference",
				"",
				...this.formatSourceSnapshot(aiPrep),
				"",
				...this.buildFeedbackSection(),
			].join("\n"),
			totalValue: totalContractValue,
			findings: [
				...currencyMatches.map((match) => ({
					entityType: match.entityType,
					value: match.value,
					lineNumber: match.lineNumber,
					context: this.formatContext(match.lineText),
				})),
				...findings.map((finding) => ({
					entityType: finding,
					value: finding,
					lineNumber: 0,
					context: "Expected contract value does not match received payments.",
				})),
			],
			csvLedgerSkipped: skipFinancialReconciliation,
			contractId,
			reconciliation,
			riskKeywordCount,
			penaltyFound: penaltyParameter.found,
		};
	}

	/**
	 * Asks the configured LLM for a hidden-risk Markdown table. A failed
	 * or unconfigured provider still returns a one-line explanation so
	 * the report section is never empty.
	 */
	private async runAiRiskAnalysis(prepared: PreparedAiText): Promise<string> {
		const timeoutMs = this.getAiTimeoutMs();
		this.setAuditorStatus("analyzing");
		this.logger.info(
			`AI payload ${prepared.payloadChars} chars (from ${prepared.originalChars}, removed ${prepared.removedChars}, ~${prepared.chunkCount} chunks) via ${this.settings.aiProvider} (timeout ${Math.round(timeoutMs / 1000)}s).`
		);
		if (prepared.retainedKeywords.length > 0) {
			this.logger.info(`Financial keywords kept: ${prepared.retainedKeywords.slice(0, 12).join(", ")}.`);
		}
		try {
			const analysis = await withTimeout(
				runAiAudit(prepared.payload, this.settings),
				timeoutMs,
				"AI risk analysis"
			);
			this.logger.info("AI risk analysis finished.");
			return analysis;
		} catch (error: unknown) {
			if (error instanceof OperationTimeoutError) {
				this.logger.warn(error.message);
				new Notice(
					`Revenue Auditor: ${error.message} The report will continue without AI findings.`
				);
				return `- AI risk analysis timed out after ${Math.round(timeoutMs / 1000)}s.`;
			}
			this.logger.warn(`AI risk analysis failed: ${this.describeError(error)}`);
			return `- AI risk analysis failed: ${this.describeError(error)}`;
		}
	}

	/**
	 * Reads the payments CSV the user selected in the modal via
	 * `app.vault.read()`. Falls back to the conventional ledger path only
	 * when nothing was selected. Missing, renamed, deleted, or empty
	 * ledgers skip reconciliation instead of aborting the rest of the audit.
	 */
	private async loadPaymentsFromCsv(
		csvFile: TFile | null,
		options?: { quiet?: boolean }
	): Promise<PaymentsCsvLoadResult> {
		const notifySkipped = () => {
			if (!options?.quiet) {
				new Notice("Revenue Auditor: CSV ledger not found, skipped reconciliation");
			}
		};
		try {
			const selected =
				csvFile instanceof TFile ? this.app.vault.getAbstractFileByPath(csvFile.path) : null;
			const file = selected instanceof TFile ? selected : this.getPaymentsCsvFile(null);
			const liveFile = file ? this.app.vault.getAbstractFileByPath(file.path) : null;
			if (!(liveFile instanceof TFile)) {
				notifySkipped();
				return { kind: "skipped" };
			}

			const raw = await this.app.vault.read(liveFile);
			const parsed = parsePaymentsCsv(raw, this.getNumberFormat());
			if (!raw.trim() || (parsed.validRowCount === 0 && parsed.skippedRowCount === 0)) {
				notifySkipped();
				return { kind: "skipped" };
			}

			return {
				kind: "parsed",
				path: liveFile.path,
				records: parsed.records,
				validRowCount: parsed.validRowCount,
				skippedRowCount: parsed.skippedRowCount,
			};
		} catch (error: unknown) {
			console.warn("Revenue Auditor: failed to read payments.csv; skipping reconciliation.", error);
			notifySkipped();
			return { kind: "skipped" };
		}
	}

	private formatEngagementStatus(
		result: ReconciliationResult,
		ledgerSkipped: boolean
	): string {
		if (ledgerSkipped) {
			return "LEDGER UNAVAILABLE";
		}
		if (result.status === "paid_in_full") {
			return "PAID IN FULL";
		}
		if (result.status === "underpaid") {
			return "UNDERPAID";
		}
		return "OVERPAID";
	}

	private buildCoreFinancialTables(terms: CoreFinancialTerms): string[] {
		return [
			"### 📊 Financial Terms (Data Grid)",
			"| Parameter | Extracted Value | Source Context |",
			"| :--- | :--- | :--- |",
			`| Total Loan / Commitment Amount | ${this.escapeCell(terms.commitment.value)} | ${this.escapeCell(
				terms.commitment.context
			)} |`,
			`| Interest Rate | ${this.escapeCell(terms.interest.value)} | ${this.escapeCell(terms.interest.context)} |`,
			`| Payment Schedule / Maturity | ${this.escapeCell(terms.maturity.value)} | ${this.escapeCell(
				terms.maturity.context
			)} |`,
			"",
			"### 🚨 Penalties & Default Triggers",
			"| Risk Category | Trigger Condition | Financial Penalty / Consequence |",
			"| :--- | :--- | :--- |",
			`| Late Payment Fee | ${this.escapeCell(terms.latePayment.trigger)} | ${this.escapeCell(
				terms.latePayment.consequence
			)} |`,
			`| Event of Default | ${this.escapeCell(terms.eventOfDefault.trigger)} | ${this.escapeCell(
				terms.eventOfDefault.consequence
			)} |`,
		];
	}

	private buildReconciliationPaymentsTable(records: PaymentRecord[]): string[] {
		const rows = [
			"| Date | Amount | Description |",
			"| :--- | ---: | :--- |",
		];
		for (const record of records) {
			rows.push(
				`| ${this.escapeCell(record.date)} | ${this.formatCurrency(record.amount)} | ${this.escapeCell(
					describePayment(record)
				)} |`
			);
		}
		const total = roundCurrency(records.reduce((sum, record) => sum + record.amount, 0));
		rows.push(`| **Total** | **${this.formatCurrency(total)}** | |`);
		return rows;
	}

	private pushExtractedParameterRow(
		rows: FindingTableRow[],
		classification: string,
		parameter: ExtractedFinancialParameter,
		formatter: (value: number) => string
	): void {
		if (!parameter.found) {
			return;
		}
		const occurrence = parameter.occurrences[0];
		if (!occurrence) {
			return;
		}
		rows.push({
			classification,
			value: formatter(parameter.value),
			context: this.formatContext(occurrence.context),
		});
	}

	private formatPercent(value: number): string {
		const rounded = Math.round(value * 10000) / 100;
		return `${rounded}%`;
	}

	private buildFindingsTable(
		categorizedMatches: { category: EntityCategory; matches: EntityMatch[] }[],
		structuredRows: FindingTableRow[]
	): string[] {
		const structured: string[] = [];
		if (structuredRows.length > 0) {
			structured.push(
				"| Classification | Extracted Value | Source Context |",
				"| :--- | :--- | :--- |",
				...structuredRows.map(
					(row) =>
						`| ${this.escapeCell(row.classification)} | ${this.escapeCell(row.value)} | ${this.escapeCell(
							row.context
						)} |`
				),
				""
			);
		}

		const detailRows: string[] = [];
		for (const { matches } of categorizedMatches) {
			for (const match of matches) {
				detailRows.push(
					`| ${this.escapeCell(match.entityType)} | ${this.escapeCell(match.value)} | ${this.escapeCell(
						this.formatContext(match.lineText)
					)} |`
				);
			}
		}

		if (detailRows.length === 0) {
			return structured.length > 0 ? structured : ["No additional entity matches."];
		}

		return [
			...structured,
			`> [!note]- Detailed entity scan (${detailRows.length} rows)`,
			"> | Classification | Extracted Value | Source Context |",
			"> | :--- | :--- | :--- |",
			...detailRows.map((row) => `> ${row}`),
		];
	}

	private formatSourceSnapshot(prepared: PreparedAiText): string[] {
		const preview = prepared.payload
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/<[^>]+>/g, "")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		const previewLines = preview
			? preview.split(/\r?\n/).slice(0, 40)
			: ["No extractable source text."];
		const truncated = preview.split(/\r?\n/).length > 40;

		return [
			`> [!info]- Filtered source sent to AI (${prepared.payloadChars} of ${prepared.originalChars} chars)`,
			`> **Removed:** ${prepared.removedChars} chars of TOC / signatures / non-financial text`,
			`> **Chunks packed:** ${prepared.chunkCount}`,
			`> **Keywords:** ${
				prepared.retainedKeywords.length > 0 ? prepared.retainedKeywords.slice(0, 16).join(", ") : "N/A"
			}`,
			">",
			...previewLines.map((line) => (line.length > 0 ? `> ${line}` : ">")),
			...(truncated ? ["> …"] : []),
		];
	}

	private calculateTotalContractValue(matches: EntityMatch[]): {
		total: number;
		count: number;
	} {
		let total = 0;
		let count = 0;
		for (const match of matches) {
			const numeric =
				typeof match.numericValue === "number"
					? match.numericValue
					: this.extractNumericValue(match.value);
			if (numeric === null || Number.isNaN(numeric)) {
				continue;
			}
			total += numeric;
			count++;
		}
		return { total, count };
	}

	private extractNumericValue(value: string): number | null {
		// Strip currency symbols and unit words (e.g. "$10.000,50" ->
		// "10.000,50", "500 EUR" -> "500") but deliberately KEEP both `.`
		// and `,` - unlike a plain `parseFloat`, `parseNumberByLocale`
		// needs both separators present to correctly tell a EU-style
		// "10.000,50" (ten thousand and a half) apart from a US-style
		// "10,000.50" (same value, different punctuation), per the
		// configured Number Format setting.
		const cleaned = value.replace(/[^0-9.,]/g, "");
		if (!cleaned) {
			return null;
		}
		const numeric = parseNumberByLocale(cleaned, this.getNumberFormat());
		return Number.isNaN(numeric) ? null : numeric;
	}

	private formatCurrency(total: number): string {
		const sign = total < 0 ? "-" : "";
		const abs = Math.abs(total);
		const format = this.getNumberFormat();
		const localeTag =
			format === "eu" ? "de-DE" : format === "us" || format === "asia" ? "en-US" : undefined;
		return `${sign}$${abs.toLocaleString(localeTag, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}

	private findMatches(lines: string[], category: EntityCategory): EntityMatch[] {
		const found: EntityMatch[] = [];
		const seen = new Set<string>();

		lines.forEach((lineText, index) => {
			const lineNumber = index + 1;
			if (isIgnorableSourceLine(lineText)) {
				return;
			}

			for (const pattern of category.patterns) {
				const matches = lineText.match(pattern);
				if (!matches) {
					continue;
				}

				for (const rawValue of matches) {
					const value = rawValue.trim();
					if (!value) {
						continue;
					}
					const key = `${category.entityType}::${value.toLowerCase()}`;
					if (seen.has(key)) {
						continue;
					}
					seen.add(key);
					found.push({
						entityType: category.entityType,
						value,
						lineNumber,
						lineText,
					});
				}
			}
		});

		return found;
	}

	private formatContext(lineText: string, maxLength = 90): string {
		const trimmed = lineText.trim();
		if (!trimmed) {
			return "—";
		}
		return trimmed.length <= maxLength
			? trimmed
			: `${trimmed.slice(0, maxLength).trimEnd()}…`;
	}

	private escapeCell(value: string): string {
		return value.replace(/\|/g, "\\|");
	}
}

class RevenueAuditorSettingTab extends PluginSettingTab {
	plugin: RevenueAuditorPlugin;

	constructor(app: App, plugin: RevenueAuditorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setHeading().setName("Revenue Auditor Settings");

		new Setting(containerEl).setHeading().setName("AI & API");

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Secret key for the selected AI provider. Characters are hidden.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.setAttribute("autocomplete", "off");
				text.inputEl.setAttribute("spellcheck", "false");
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("revenue-auditor-settings-wide-text");
			});

		new Setting(containerEl)
			.setName("AI provider")
			.setDesc("Which AI backend to use for audit assistance.")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(AI_PROVIDER_LABELS)
					.setValue(this.plugin.settings.aiProvider)
					.onChange(async (value) => {
						this.plugin.settings.aiProvider = value as AiProvider;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.aiProvider === "Ollama (Local)") {
			new Setting(containerEl)
				.setName("Ollama endpoint")
				.setDesc("Base URL of the local Ollama server (no trailing path).")
				.addText((text) => {
					text
						.setPlaceholder(DEFAULT_SETTINGS.ollamaEndpoint)
						.setValue(this.plugin.settings.ollamaEndpoint)
						.onChange(async (value) => {
							const trimmed = value.trim();
							this.plugin.settings.ollamaEndpoint =
								trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.ollamaEndpoint;
							await this.plugin.saveSettings();
						});
					text.inputEl.addClass("revenue-auditor-settings-wide-text");
				});

			new Setting(containerEl)
				.setName("Ollama model")
				.setDesc("Local model tag to request from Ollama. Pull it first with `ollama pull <name>`.")
				.addDropdown((dropdown) => {
					dropdown
						.addOptions(OLLAMA_MODEL_LABELS)
						.setValue(this.plugin.settings.ollamaModel)
						.onChange(async (value) => {
							this.plugin.settings.ollamaModel = value as OllamaModel;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Default currency")
			.setDesc("Base currency code used when amounts do not specify one (e.g. USD, EUR, RUB).")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.defaultCurrency)
					.setValue(this.plugin.settings.defaultCurrency)
					.onChange(async (value) => {
						this.plugin.settings.defaultCurrency = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setHeading().setName("Audit keywords");

		new Setting(containerEl)
			.setName("Risk keywords")
			.setDesc("Comma-separated words/phrases flagged as risks, e.g. penalty, late fee, termination")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("penalty, late fee, termination, indexation")
					.setValue(this.plugin.settings.riskKeywords)
					.onChange(async (value) => {
						this.plugin.settings.riskKeywords = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 3;
				textArea.inputEl.addClass("revenue-auditor-settings-textarea");
			});

		new Setting(containerEl)
			.setName("Financial keywords")
			.setDesc("Comma-separated words/phrases flagged as financial terms, e.g. price, total")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("price, total")
					.setValue(this.plugin.settings.financialKeywords)
					.onChange(async (value) => {
						this.plugin.settings.financialKeywords = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 3;
				textArea.inputEl.addClass("revenue-auditor-settings-textarea");
			});

		new Setting(containerEl).setHeading().setName("Document extraction (Docling)");

		new Setting(containerEl)
			.setName("Docling binary path")
			.setDesc("Custom path to Docling CLI executable.")
			.addText((text) => {
				text
					.setPlaceholder("Auto-detect (e.g. /usr/local/bin/docling)")
					.setValue(this.plugin.settings.doclingBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.doclingBinaryPath = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("revenue-auditor-settings-wide-text");
			})
			.addButton((button) => {
				button.setButtonText("Test Docling Executable").onClick(async () => {
					button.setDisabled(true);
					const originalLabel = "Test Docling Executable";
					button.setButtonText("Testing…");
					try {
						const result = await testDoclingExecutable(
							this.plugin.settings.doclingBinaryPath,
							this.plugin.settings.pythonPath
						);
						if (result.success) {
							new Notice(`✅ Docling OK (${result.resolvedPath}): ${result.message}`);
						} else {
							new Notice(`❌ Docling test failed (${result.resolvedPath}): ${result.message}`);
						}
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						new Notice(`❌ Docling test failed: ${message}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText(originalLabel);
					}
				});
			});

		new Setting(containerEl)
			.setName("Python path")
			.setDesc(
				"Optional Python interpreter path. When set (and no Docling binary path is given above), Docling is looked for alongside this interpreter before falling back to well-known install locations."
			)
			.addText((text) => {
				text
					.setPlaceholder("Auto-detect (e.g. /usr/bin/python3)")
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async (value) => {
						this.plugin.settings.pythonPath = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("revenue-auditor-settings-wide-text");
			});

		new Setting(containerEl)
			.setName("Default payments CSV path")
			.setDesc("Vault-relative path pre-selected in the Audit modal's CSV dropdown.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.defaultPaymentsCsvPath)
					.setValue(this.plugin.settings.defaultPaymentsCsvPath)
					.onChange(async (value) => {
						this.plugin.settings.defaultPaymentsCsvPath =
							value.trim().length > 0 ? value.trim() : DEFAULT_SETTINGS.defaultPaymentsCsvPath;
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("revenue-auditor-settings-wide-text");
			});

		new Setting(containerEl)
			.setName("CLI execution timeout (ms)")
			.setDesc(
				"Max time to let the Docling CLI run before giving up and falling back to pdf-parse. Also used as the UI hang-protection timeout for document parsing (a Notice is shown if parsing exceeds this). Docling's model-based layout analysis can be slow on a CPU-only machine."
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1000";
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.cliTimeoutMs))
					.setValue(String(this.plugin.settings.cliTimeoutMs))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.cliTimeoutMs =
							Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.cliTimeoutMs;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Enable OCR for scanned PDFs")
			.setDesc(
				"Passes --ocr --force-ocr to Docling so scanned pages and images-with-text are recognized as plain text across the full page, instead of being re-embedded as pictures. OCR meaningfully slows down conversion, so it's off by default."
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.enableOcr).onChange(async (value) => {
					this.plugin.settings.enableOcr = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Contract language")
			.setDesc(
				"Selects English and/or Russian financial keywords (base price, indexation, penalties) when extracting contract terms. Also passed to Docling as --ocr-lang when OCR is enabled. \"Auto\" searches both languages."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(CONTRACT_LANGUAGE_LABELS)
					.setValue(this.plugin.settings.contractLanguage)
					.onChange(async (value) => {
						this.plugin.settings.contractLanguage = value as ContractLanguage;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Number format")
			.setDesc(
				"How to interpret thousands/decimal separators when parsing amounts from payments.csv and the contract text. \"Auto\" guesses per value; pick US or EU explicitly if your data is consistently one or the other."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(NUMBER_FORMAT_LABELS)
					.setValue(this.plugin.settings.numberFormat)
					.onChange(async (value) => {
						this.plugin.settings.numberFormat = value as NumberFormat;
						await this.plugin.saveSettings();
					});
			});
	}
}
