// PDF text extraction backed by the "pdf-parse" package's classic (v1.x)
// bundled PDF.js engine.
//
// Deliberately requires the engine at a *fixed* internal path instead of
// calling pdf-parse's own default export:
//   - pdf-parse's default export does
//     `require(`./pdf.js/${options.version}/build/pdf.js`)`, a *dynamic*
//     require. esbuild can't statically resolve which version string will
//     be used at runtime, so it conservatively bundles every PDF.js build
//     pdf-parse ships (4 of them) - inflating main.js from ~2.8MB to over
//     10MB for no benefit, since we only ever use one fixed version.
//   - pdf-parse@2.x (and pdfjs-dist directly) depend on a canvas
//     implementation (`@napi-rs/canvas` / `canvas`) for rendering, which is
//     exactly what previously crashed this plugin on Obsidian startup.
//     Plain text extraction never needs a canvas, and this classic v1.x
//     engine has no such dependency at all.
//
const PDFJS: PdfJsModule = require("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js");
// Bundle the matching worker as a module. PDF.js would otherwise inject a
// <script> tag to load it, which Obsidian's community review forbids.
require("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.worker.js");

// Never spin up a worker thread/process for parsing - keeps everything
// synchronous-ish and avoids needing to ship/locate a separate worker file.
PDFJS.disableWorker = true;

interface PdfTextItem {
	str: string;
	transform: number[];
}

interface PdfTextContent {
	items: PdfTextItem[];
}

interface PdfPageProxy {
	getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<PdfTextContent>;
}

interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	destroy(): void;
}

interface PdfJsModule {
	disableWorker: boolean;
	getDocument(data: Buffer): Promise<PdfDocumentProxy>;
}

export interface PdfExtractionResult {
	text: string;
	numPages: number;
	error: string | null;
}

/**
 * Extracts human-readable text from PDF binary data. Renders each page's
 * text items via PDF.js's own layout engine (proper glyph decoding, font
 * encoding, ToUnicode maps, etc. - not a byte-level guess), joining items
 * into lines based on their vertical text-matrix position.
 *
 * Accepts the raw ArrayBuffer straight from `app.vault.readBinary()` (or an
 * already-wrapped typed array). It's explicitly converted to a real Node
 * `Buffer` - constructed here, inside the plugin's own required code - via
 * `Buffer.from()` before being handed to PDF.js. This matters in Obsidian's
 * Electron environment: a `Uint8Array` view created from an ArrayBuffer
 * that originated in a different JS realm/context can fail PDF.js's
 * internal type checks (or otherwise be mishandled) even though it looks
 * identical, silently yielding zero pages/empty text instead of an error.
 */
export async function extractTextFromPdf(data: ArrayBuffer | Uint8Array): Promise<PdfExtractionResult> {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

	let doc: PdfDocumentProxy | null = null;
	try {
		doc = await PDFJS.getDocument(buffer);
		const numPages = doc.numPages;
		const pageTexts: string[] = [];

		for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
			const page = await doc.getPage(pageNumber);
			const content = await page.getTextContent({
				normalizeWhitespace: false,
				disableCombineTextItems: false,
			});
			pageTexts.push(renderPageText(content));
		}

		const text = pageTexts.join("\n\n");

		return { text, numPages, error: null };
	} catch (error) {
		console.error("Revenue Auditor: PDF extraction failed.", error);
		return { text: "", numPages: 0, error: describeError(error) };
	} finally {
		doc?.destroy();
	}
}

function renderPageText(content: PdfTextContent): string {
	let text = "";
	let lastY: number | undefined;

	for (const item of content.items) {
		const y = item.transform[5];
		if (lastY === undefined || y === lastY) {
			text += item.str;
		} else {
			text += "\n" + item.str;
		}
		lastY = y;
	}

	return text;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
