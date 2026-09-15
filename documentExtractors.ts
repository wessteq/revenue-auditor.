// Adapter Pattern for document text extraction.
//
// The audit pipeline needs to pull plain text out of very different kinds
// of files (Markdown/text notes today; PDFs via a local Docling CLI
// tomorrow, with the existing pdf-parse pipeline as a fallback). Rather
// than branching on file extension inline wherever extraction happens,
// every source type is wrapped behind the same `DocumentExtractor`
// interface, and a `DocumentExtractorRegistry` picks (and, if needed,
// falls back between) the right adapter for a given file - so adding a
// new backend (e.g. a real Docling integration, OCR, a different CLI
// tool) never requires touching the call sites in main.ts.
//
// Every extractor operates on a plain absolute filesystem path (not an
// Obsidian `TFile`/`Vault`), deliberately: this keeps the extractors
// reusable outside of Obsidian's API (e.g. testable in plain Node, or
// reused by a future CLI/service) and mirrors how an external tool like
// Docling actually consumes input - a path on disk, not a vault
// abstraction. main.ts is responsible for resolving a TFile to its
// absolute path before calling into this module.

import { exec } from "child_process";
import { constants as fsConstants } from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { extractTextFromPdf } from "./pdfTextExtractor";

interface ExecResult {
	stdout: string;
	stderr: string;
}

interface ExecIo {
	stdout?: string;
	stderr?: string;
}

const execAsync = promisify(exec) as (
	command: string,
	options?: { timeout?: number }
) => Promise<ExecResult>;

const LOG_PREFIX = "[Revenue Auditor] DoclingLocalExtractor:";

/** Standardized shape every extractor returns, regardless of source format. */
export interface ExtractedDocument {
	text: string;
	/** Human-readable description of what was extracted and how, shown in the Audit Report's "Source" line. */
	label: string;
	format: "markdown" | "text" | "pdf" | "unknown";
	/** Set when extraction failed or degraded (e.g. CLI not installed) - `text` may still be empty in this case. */
	error?: string;
	/**
	 * Set when extraction failed specifically because the source looks like
	 * a scanned document with no text layer and OCR is currently disabled.
	 * This is a deliberate stop signal, distinct from a generic `error`:
	 * `DocumentExtractorRegistry` does NOT fall through to the next
	 * extractor when this is set (see its `extract()`), since every other
	 * registered PDF extractor would hit the exact same "no text layer"
	 * wall and silently produce an equally empty result - the user needs
	 * to flip a setting, not have the plugin quietly try something else.
	 */
	requiresOcr?: boolean;
}

/** Unified interface every document source adapter implements. */
export interface DocumentExtractor {
	/** Short identifier used in logs/error messages (e.g. "DoclingLocalExtractor"). */
	readonly name: string;
	/** Whether this extractor is able to handle the file at `filePath`, based on its extension. */
	supports(filePath: string): boolean;
	/** Extracts standardized text/structured data from the file at `filePath` (an absolute filesystem path). */
	extract(filePath: string): Promise<ExtractedDocument>;
	// Full-document text is intentional here. Financial keyword filtering
	// and AI payload packing happen later in `prepareContractTextForAi`.
}

function getExtension(filePath: string): string {
	const base = path.basename(filePath);
	const dotIndex = base.lastIndexOf(".");
	return dotIndex === -1 ? "" : base.slice(dotIndex + 1).toLowerCase();
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Strips inline Base64 images from extracted document text so they cannot
 * leak into Source Snippet, regex matching, or the findings table.
 *
 * Docling's default Markdown export (`--image-export-mode embedded`) inlines
 * every figure as `![...](data:image/...;base64,...)`. Those payloads are
 * tens of kilobytes of alphabet soup: they inflate character counts (which
 * fools `detectIfScannedPdf`), and they pollute keyword/currency scans.
 */
export function sanitizeExtractedText(text: string): string {
	if (!text) {
		return text;
	}

	// Markdown image with a data:image/...;base64,... URL (the form Docling
	// emits, and the form the audit report was leaking into Source Snippet).
	let cleaned = text.replace(/!\[.*?\]\(data:image\/[a-zA-Z]+;base64,[^)]+\)/g, "");

	// HTML <img src="data:image..."> that some converters emit alongside Markdown.
	cleaned = cleaned.replace(/<img\b[^>]*\bsrc=["']data:image\/[^"']+["'][^>]*>/gi, "");

	// Bare data-URI payloads left after the passes above, including
	// `image/svg+xml` which the Markdown-image regex (limited to [a-zA-Z]+)
	// would miss.
	cleaned = cleaned.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/g, "");

	return cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Result of `detectIfScannedPdf`. */
export interface ScannedPdfDetectionResult {
	/** True when the extracted text is sparse enough to suggest a missing text layer (i.e. a scanned image PDF with no OCR applied). */
	isScanned: boolean;
	/**
	 * How confident the heuristic is in its `isScanned` verdict, from `0`
	 * (right at the threshold, could go either way) to `1` (extremely
	 * confident - e.g. completely empty text, or text several times
	 * denser than the threshold). Not a statistical probability, just a
	 * distance-from-threshold signal for logging/diagnostics.
	 */
	confidence: number;
}

/** Below this many characters per page, extracted text is treated as too sparse to be a real text layer (rather than e.g. a short cover page). */
const SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD = 50;

/**
 * Heuristically detects whether a PDF was likely scanned (an image with no
 * embedded text layer) based on how little text a normally-thorough
 * extractor pulled out of it: real text layers produce at least a
 * paragraph's worth of characters per page, while a scanned page with no
 * OCR applied yields nothing (or only a handful of stray characters from
 * e.g. embedded metadata/annotations).
 *
 * `pageCount` is optional because not every extractor surfaces it (the
 * Docling CLI wrapper, in particular, doesn't currently parse a page count
 * out of its output) - when omitted, the whole document is treated as a
 * single "page" for the purposes of this check, i.e. the threshold applies
 * to the total extracted length rather than a true per-page average.
 */
export function detectIfScannedPdf(extractedText: string, pageCount?: number): ScannedPdfDetectionResult {
	const effectivePageCount = pageCount && pageCount > 0 ? pageCount : 1;
	const charsPerPage = extractedText.trim().length / effectivePageCount;
	const isScanned = charsPerPage < SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD;

	const confidence = isScanned
		? Math.min(1, 1 - charsPerPage / SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD)
		: Math.min(1, (charsPerPage - SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD) / SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD);

	return { isScanned, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Adapter for plain-text contract files: Markdown, `.markdown`, and `.txt`.
 * Reads the file directly off disk rather than through Obsidian's Vault
 * API, so it behaves identically whether called from the plugin or from a
 * plain Node script/test.
 */
export class MarkdownExtractor implements DocumentExtractor {
	readonly name = "MarkdownExtractor";
	private static readonly EXTENSIONS = new Set(["md", "markdown", "txt"]);

	supports(filePath: string): boolean {
		return MarkdownExtractor.EXTENSIONS.has(getExtension(filePath));
	}

	async extract(filePath: string): Promise<ExtractedDocument> {
		try {
			const text = sanitizeExtractedText(await fsPromises.readFile(filePath, "utf8"));
			const extension = getExtension(filePath);
			return {
				text,
				label: `${extension === "txt" ? "Text file" : "Markdown note"} (${path.basename(filePath)})`,
				format: extension === "txt" ? "text" : "markdown",
			};
		} catch (error: unknown) {
			return {
				text: "",
				label: `Markdown/text file (${path.basename(filePath)}) - failed to read`,
				format: "unknown",
				error: describeError(error),
			};
		}
	}
}

/**
 * Adapter wrapping the plugin's existing, proven PDF pipeline
 * (pdf-parse's bundled PDF.js engine - see pdfTextExtractor.ts). Kept as
 * its own adapter so it can serve as the fallback in the registry below
 * when a preferred extractor (e.g. Docling) isn't available.
 */
export class PdfParseExtractor implements DocumentExtractor {
	readonly name = "PdfParseExtractor";

	supports(filePath: string): boolean {
		return getExtension(filePath) === "pdf";
	}

	async extract(filePath: string): Promise<ExtractedDocument> {
		try {
			const buffer = await fsPromises.readFile(filePath);
			const result = await extractTextFromPdf(buffer);

			if (result.error) {
				return {
					text: "",
					label: `PDF (${path.basename(filePath)}) - pdf-parse extraction failed`,
					format: "pdf",
					error: result.error,
				};
			}

			const pageNote = `${result.numPages} page${result.numPages === 1 ? "" : "s"}`;
			return {
				text: sanitizeExtractedText(result.text),
				label: `PDF (${path.basename(filePath)}, ${pageNote}, via pdf-parse)`,
				format: "pdf",
			};
		} catch (error: unknown) {
			return {
				text: "",
				label: `PDF (${path.basename(filePath)}) - failed to read`,
				format: "unknown",
				error: describeError(error),
			};
		}
	}
}

/**
 * Well-known install locations for the `docling` CLI, checked in order
 * before falling back to relying on the inherited `PATH`. This matters
 * because Obsidian (an Electron app) is normally launched from Finder/the
 * Dock/Spotlight on macOS or a desktop launcher on Linux, NOT from a login
 * shell - so it inherits a minimal, stripped-down PATH that typically
 * does NOT include Homebrew's or Python's user-install directories, even
 * though those same binaries work fine from a Terminal. `exec()`'s default
 * shell (`/bin/sh`, non-login) doesn't source `.zshrc`/`.bash_profile`
 * either, so it can't pick these up on its own.
 */
function getDoclingBinaryCandidates(): string[] {
	const home = os.homedir();
	const pythonVersions = ["3.13", "3.12", "3.11", "3.10"];

	return [
		"/opt/homebrew/bin/docling", // Homebrew on Apple Silicon macOS
		"/usr/local/bin/docling", // Homebrew on Intel macOS, and common Linux/macOS install location
		"/usr/bin/docling", // System-level Linux package managers
		path.join(home, ".local", "bin", "docling"), // `pip install --user docling` on Linux/macOS
		...pythonVersions.map((version) =>
			// python.org's macOS installer package (Python.framework) - a
			// `pip install docling` with this Python puts console scripts
			// here, not under ~/Library or /usr/local.
			path.join("/Library", "Frameworks", "Python.framework", "Versions", version, "bin", "docling")
		),
		...pythonVersions.map((version) =>
			// macOS system/user-site installs under ~/Library/Python/<version>/bin.
			path.join(home, "Library", "Python", version, "bin", "docling")
		),
		path.join(home, ".pyenv", "shims", "docling"), // pyenv
	];
}

async function isExecutableFile(candidatePath: string): Promise<boolean> {
	try {
		await fsPromises.access(candidatePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves an absolute path to the `docling` binary, in priority order:
 *
 *   1. `explicitBinaryPath` (from the plugin's "Docling Binary Path"
 *      setting) - used verbatim, no probing, if provided.
 *   2. A `docling` executable sitting alongside `pythonPath` (from the
 *      "Python Path" setting) - `pip install`'d console scripts land in
 *      the same `bin/`/`Scripts` directory as the interpreter that
 *      installed them, so this is a reliable way to target a specific
 *      Python environment (e.g. a venv) without a separate Docling path.
 *   3. The well-known install locations in `getDoclingBinaryCandidates()`.
 *   4. The bare `"docling"` command, relying on whatever `PATH` the
 *      process inherited (will fail with a clear "command not found" if
 *      that doesn't resolve either).
 *
 * Failed resolution still warns in the Developer Console so the fallback
 * to PATH is visible.
 */
export async function resolveDoclingBinaryPath(
	explicitBinaryPath?: string,
	pythonPath?: string
): Promise<string> {
	const trimmedBinaryPath = explicitBinaryPath?.trim();
	if (trimmedBinaryPath) {
		return trimmedBinaryPath;
	}

	const trimmedPythonPath = pythonPath?.trim();
	if (trimmedPythonPath) {
		const pythonBinDir = path.dirname(trimmedPythonPath);
		const siblingCandidates = [path.join(pythonBinDir, "docling"), path.join(pythonBinDir, "docling.exe")];
		for (const candidate of siblingCandidates) {
			if (await isExecutableFile(candidate)) {
				return candidate;
			}
		}
		console.warn(
			`${LOG_PREFIX} configured Python path "${trimmedPythonPath}" has no sibling docling executable; falling back to auto-detection.`
		);
	}

	for (const candidate of getDoclingBinaryCandidates()) {
		if (await isExecutableFile(candidate)) {
			return candidate;
		}
	}

	console.warn(
		`${LOG_PREFIX} no docling binary found at any known install location; falling back to "docling" on PATH (this will likely fail if Obsidian wasn't launched from a shell with docling on PATH).`
	);
	return "docling";
}

/**
 * Runs `docling --version` against the resolved binary and reports whether
 * it succeeded - backs the Settings tab's "Test Docling Executable" button.
 * Resolves the same way `DoclingLocalExtractor` would (explicit path ->
 * Python-sibling -> well-known paths -> bare "docling"), so the test
 * reflects exactly what an actual audit run would use.
 */
export async function testDoclingExecutable(
	explicitBinaryPath?: string,
	pythonPath?: string
): Promise<{ success: boolean; message: string; resolvedPath: string }> {
	const resolvedPath = await resolveDoclingBinaryPath(explicitBinaryPath, pythonPath);
	try {
		const { stdout, stderr } = await execAsync(`${JSON.stringify(resolvedPath)} --version`, {
			timeout: 15_000,
		});
		const output = (stdout || stderr).trim();
		return {
			success: true,
			message: output.length > 0 ? output : "Docling responded but printed no version output.",
			resolvedPath,
		};
	} catch (error: unknown) {
		return { success: false, message: describeError(error), resolvedPath };
	}
}

/**
 * Adapter for local Docling integration. Shells out to the `docling`
 * CLI (https://docling-project.github.io/docling/) to convert a PDF to
 * Markdown entirely on the user's machine - no external server/API calls
 * - then reads the resulting Markdown file back in.
 *
 * Issues the real CLI invocation (`docling "<file>" --to md --output
 * "<tempDir>"` - see the `extract()` body for why there's deliberately no
 * "convert" subcommand) and parses its real output. Any failure - the
 * `docling` binary not being resolvable, a non-zero exit code, an
 * unexpected output layout, a version mismatch in CLI syntax - is caught,
 * logged on failure (stdout/stderr plus the error), and surfaced as an
 * `error` on the result rather than thrown, so
 * `DocumentExtractorRegistry` can cleanly fall back to `PdfParseExtractor`
 * whenever the local Docling install isn't cooperating.
 */
/** Configuration for `DoclingLocalExtractor`, sourced from the plugin's Settings tab. */
export interface DoclingExtractorOptions {
	/** Explicit override for the Docling executable. Empty/omitted = auto-resolve via `resolveDoclingBinaryPath()`. */
	binaryPath?: string;
	/** Explicit Python interpreter path, used to locate a sibling `docling` executable when `binaryPath` is empty. */
	pythonPath?: string;
	/** Max time (ms) to let the CLI run before giving up and falling back. Docling's model-based layout analysis can be slow on a CPU-only machine, so this is generous by default. */
	timeoutMs?: number;
	/** Passes `--ocr` (true) or `--no-ocr` (false, default) to Docling. When enabled, also requests full-page OCR (`--force-ocr`) so scans and embedded page images are recognized as text rather than re-embedded as pictures. OCR meaningfully slows down conversion, so it's opt-in. */
	enableOcr?: boolean;
	/** Passed to Docling as `--ocr-lang` when `enableOcr` is true. Omit/undefined lets Docling's OCR engine use its own default language set. */
	ocrLanguage?: string;
}

const DEFAULT_DOCLING_TIMEOUT_MS = 120_000;

function readExecIo(error: unknown): ExecIo {
	if (typeof error !== "object" || error === null) {
		return {};
	}
	const record = error as Record<string, unknown>;
	return {
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
	};
}

function isUnknownCliOptionError(error: unknown): boolean {
	const execError = readExecIo(error);
	const haystack = `${describeError(error)}\n${execError.stderr ?? ""}`.toLowerCase();
	return (
		haystack.includes("no such option") ||
		haystack.includes("unrecognized arguments") ||
		haystack.includes("unexpected extra argument") ||
		haystack.includes("invalid value for")
	);
}

export class DoclingLocalExtractor implements DocumentExtractor {
	readonly name = "DoclingLocalExtractor";

	// Resolved once per extractor instance and reused - the filesystem
	// probing in resolveDoclingBinaryPath() doesn't need to re-run on
	// every single file extracted.
	private resolvedCommandPromise: Promise<string> | null = null;

	constructor(private readonly options: DoclingExtractorOptions = {}) {}

	supports(filePath: string): boolean {
		return getExtension(filePath) === "pdf";
	}

	private resolveCommand(): Promise<string> {
		if (!this.resolvedCommandPromise) {
			this.resolvedCommandPromise = resolveDoclingBinaryPath(this.options.binaryPath, this.options.pythonPath);
		}
		return this.resolvedCommandPromise;
	}

	private buildDoclingCommand(
		resolvedCommand: string,
		filePath: string,
		outputDir: string,
		flags: { imageExportMode: boolean; forceOcr: boolean }
	): string {
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_DOCLING_TIMEOUT_MS;
		const commandParts = [
			JSON.stringify(resolvedCommand),
			JSON.stringify(filePath),
			"--to",
			"md",
			"--output",
			JSON.stringify(outputDir),
		];
		if (flags.imageExportMode) {
			commandParts.push("--image-export-mode", "placeholder");
		}
		commandParts.push(
			this.options.enableOcr ? "--ocr" : "--no-ocr",
			"--document-timeout",
			String(Math.max(1, Math.round(timeoutMs / 1000)))
		);
		if (this.options.enableOcr && flags.forceOcr) {
			commandParts.push("--force-ocr");
		}
		if (this.options.enableOcr && this.options.ocrLanguage) {
			commandParts.push("--ocr-lang", this.options.ocrLanguage);
		}
		return commandParts.join(" ");
	}

	/**
	 * Finds Docling's Markdown output by listing `outputDir` and matching
	 * on the `.md` extension, rather than assuming a specific filename
	 * (e.g. `<source-basename>.md`) - Docling's exact naming/casing
	 * conventions have shifted across versions and conversion modes, so
	 * guessing the path risks a false "file not found" failure even when
	 * conversion actually succeeded. If more than one `.md` file turns up
	 * (unexpected for a single-source conversion, but not impossible),
	 * the largest one is used, since a genuine conversion result is far
	 * more likely to dwarf any small companion/log file Docling might
	 * also drop in the output directory.
	 */
	private async findMarkdownOutput(outputDir: string): Promise<string | null> {
		const entries = await fsPromises.readdir(outputDir);
		const markdownFiles = entries.filter((entry) => entry.toLowerCase().endsWith(".md"));

		if (markdownFiles.length === 0) {
			return null;
		}
		if (markdownFiles.length === 1) {
			return path.join(outputDir, markdownFiles[0]);
		}

		let largestPath = path.join(outputDir, markdownFiles[0]);
		let largestSize = -1;
		for (const fileName of markdownFiles) {
			const candidatePath = path.join(outputDir, fileName);
			const { size } = await fsPromises.stat(candidatePath);
			if (size > largestSize) {
				largestSize = size;
				largestPath = candidatePath;
			}
		}
		return largestPath;
	}

	async extract(filePath: string): Promise<ExtractedDocument> {
		const resolvedCommand = await this.resolveCommand();
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_DOCLING_TIMEOUT_MS;
		let outputDir: string | null = null;

		try {
			outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "revenue-auditor-docling-"));

			// `<docling> "<source>" --to md --output "<dir>"` - deliberately
			// NOT `docling convert <source> ...`. Docling 2.90.x's CLI
			// takes the source file as its own top-level positional
			// argument (no "convert" subcommand); passing the word
			// "convert" as an argument gets interpreted as the source
			// path itself, failing with "The input file convert does not
			// exist". Newer Docling releases restructured the CLI around
			// a "convert" subcommand instead, so this only matters for
			// older installs - but there's no reliable way to detect the
			// installed CLI's shape ahead of time without running it, so
			// the flat (no-subcommand) form is used here since that's the
			// form known to fail hard (rather than just warn) when wrong.
			// The output format value is the short form `md`, not
			// `markdown` (Docling 2.x rejects the latter with
			// "Invalid value for '--to'"). Both the binary path and the
			// source path are JSON-quoted (equivalent to double-quoting
			// for typical paths) to safely handle spaces/special
			// characters while keeping this a single exec() call.
			//
			// `--image-export-mode placeholder` is the important one for
			// the audit pipeline: Docling's default is `embedded`, which
			// inlines every figure as a `data:image/...;base64,...`
			// Markdown image. Those payloads drown Source Snippet and
			// fool the scanned-PDF heuristic (huge character count, no
			// real text). `placeholder` keeps Markdown structure (tables,
			// headings) but only marks where an image sat. Combined with
			// `sanitizeExtractedText`, no Base64 reaches the report.
			//
			// `--ocr`/`--no-ocr`, `--force-ocr`, and `--document-timeout`
			// are real, verified flags on Docling's convert command.
			// OCR is opt-in (`--no-ocr` unless explicitly enabled) since
			// it meaningfully slows down conversion; when it IS enabled,
			// `--force-ocr` asks Docling to OCR the full page and return
			// recognized text rather than re-embedding the page image.
			// `--document-timeout` (seconds) is passed alongside exec()'s
			// own process-level `timeout` (ms) as a second line of
			// defense so Docling's own per-document watchdog also
			// respects the configured limit.
			const preferredCommand = this.buildDoclingCommand(resolvedCommand, filePath, outputDir, {
				imageExportMode: true,
				forceOcr: Boolean(this.options.enableOcr),
			});

			try {
				await execAsync(preferredCommand, { timeout: timeoutMs });
			} catch (error: unknown) {
				if (!isUnknownCliOptionError(error)) {
					throw error;
				}
				// Older Docling builds may not know `--image-export-mode` or
				// `--force-ocr`. Retry without those flags; sanitizeExtractedText
				// still strips any Base64 the compatibility run embeds.
				const compatibilityCommand = this.buildDoclingCommand(resolvedCommand, filePath, outputDir, {
					imageExportMode: false,
					forceOcr: false,
				});
				console.warn(
					`${LOG_PREFIX} Docling rejected image/OCR flags; retrying compatibility command: ${compatibilityCommand}`
				);
				await execAsync(compatibilityCommand, { timeout: timeoutMs });
			}

			const outputPath = await this.findMarkdownOutput(outputDir);
			if (!outputPath) {
				throw new Error(
					`Docling reported success but no .md file was found in the output directory "${outputDir}".`
				);
			}

			const extractedText = sanitizeExtractedText(await fsPromises.readFile(outputPath, "utf8"));

			// Docling's CLI wrapper doesn't currently parse a page count
			// out of its output, so this checks total characters against
			// the single-page threshold (see detectIfScannedPdf's doc
			// comment) - still a meaningful signal for "basically no text
			// came out of this conversion at all".
			const scanDetection = detectIfScannedPdf(extractedText);

			if (scanDetection.isScanned && !this.options.enableOcr) {
				// Deliberately NOT falling through to the generic
				// empty-output error below: this is a specific, actionable
				// condition (missing text layer + OCR disabled), not a
				// generic extraction failure, so it gets its own message
				// and its own `requiresOcr` flag that tells
				// DocumentExtractorRegistry to stop instead of silently
				// trying PdfParseExtractor next - which would hit the
				// exact same "no text layer" wall and produce an equally
				// empty, but far less explicable, result.
				const message =
					"This PDF appears to be a scanned document. Please enable OCR in Revenue Auditor settings to process it.";
				console.warn(
					`${LOG_PREFIX} ${message} (extracted ${extractedText.trim().length} character(s) from "${path.basename(filePath)}")`
				);
				return {
					text: "",
					label: `PDF (${path.basename(filePath)}) - looks like a scanned document (no text layer)`,
					format: "unknown",
					error: message,
					requiresOcr: true,
				};
			}

			if (extractedText.trim().length === 0) {
				throw new Error(`Docling's output file "${outputPath}" was empty.`);
			}

			return {
				text: extractedText,
				label: `PDF (${path.basename(filePath)}, via local Docling CLI)`,
				format: "pdf",
			};
		} catch (error: unknown) {
			// A rejected execAsync() promise carries stdout/stderr
			// captured up to the point of failure - log both, since the
			// CLI's own error message (e.g. a Python traceback) is
			// usually far more informative than the generic exit-code
			// error alone.
			const execError = readExecIo(error);
			if (execError.stdout) {
				console.error(`${LOG_PREFIX} stdout (on failure):\n${execError.stdout}`);
			}
			if (execError.stderr) {
				console.error(`${LOG_PREFIX} stderr (on failure):\n${execError.stderr}`);
			}
			console.error(`${LOG_PREFIX} extraction failed for "${filePath}":`, error);

			return {
				text: "",
				label: `PDF (${path.basename(filePath)}) - Docling CLI unavailable or failed`,
				format: "unknown",
				error: describeError(error),
			};
		} finally {
			if (outputDir) {
				await fsPromises.rm(outputDir, { recursive: true, force: true }).catch(() => {
					// Best-effort cleanup only - a leftover temp dir is harmless.
				});
			}
		}
	}
}

/**
 * Picks the right extractor(s) for a file's type and tries them in the
 * order registered, falling through to the next candidate if one fails or
 * returns empty text. This is the "seamless switch based on file type"
 * entry point the rest of the plugin calls into - callers never need to
 * know which concrete extractor ends up handling a given file.
 *
 * Exception: a result with `requiresOcr` set is returned immediately,
 * WITHOUT trying any remaining candidates - see `ExtractedDocument.requiresOcr`
 * for why (every other PDF extractor would hit the same missing-text-layer
 * wall, so falling through would just trade one empty result for another,
 * less explicable one).
 */
export class DocumentExtractorRegistry {
	constructor(private readonly extractors: DocumentExtractor[]) {}

	async extract(filePath: string): Promise<ExtractedDocument> {
		const candidates = this.extractors.filter((extractor) => extractor.supports(filePath));

		if (candidates.length === 0) {
			return {
				text: "",
				label: `Unsupported file type (${path.basename(filePath)})`,
				format: "unknown",
				error: "No registered extractor supports this file type.",
			};
		}

		let lastResult: ExtractedDocument | null = null;
		for (const extractor of candidates) {
			try {
				const result = await extractor.extract(filePath);
				if (result.requiresOcr) {
					return result;
				}
				if (!result.error && result.text.trim().length > 0) {
					return result;
				}
				lastResult = result;
			} catch (error: unknown) {
				lastResult = {
					text: "",
					label: `${extractor.name} threw unexpectedly`,
					format: "unknown",
					error: describeError(error),
				};
			}
		}

		// Every candidate either errored or produced empty text - return
		// the last attempt's result so the caller can still surface a
		// meaningful label/error instead of a generic failure.
		return (
			lastResult ?? {
				text: "",
				label: `Extraction failed (${path.basename(filePath)})`,
				format: "unknown",
				error: "All registered extractors failed.",
			}
		);
	}
}
