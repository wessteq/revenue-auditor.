/**
 * Packs sanitized contract text into AI-sized chunks without cutting
 * mid-sentence. Used after TextSanitizer so Ollama sees a few compact
 * financial passages instead of a 150-page dump.
 */

const DEFAULT_CHUNK_SIZE = 3_000;

export function chunkText(text: string, maxChunkSize = DEFAULT_CHUNK_SIZE): string[] {
	const units = text
		.split(/\n{2,}/)
		.map((unit) => unit.trim())
		.filter((unit) => unit.length > 0);

	const chunks: string[] = [];
	let current = "";

	const flush = () => {
		if (current) {
			chunks.push(current);
			current = "";
		}
	};

	for (const unit of units) {
		if (unit.length > maxChunkSize) {
			flush();
			chunks.push(...splitLongUnit(unit, maxChunkSize));
			continue;
		}
		const next = current ? `${current}\n\n${unit}` : unit;
		if (next.length > maxChunkSize && current) {
			flush();
			current = unit;
		} else {
			current = next;
		}
	}

	flush();
	return chunks;
}

/**
 * Packs as many chunks as fit in `maxChars`, in the given order.
 * Does not send only the first chunk — that would drop definitions
 * that often sit later in a credit agreement.
 */
export function packChunks(chunks: string[], maxChars: number): string {
	if (chunks.length === 0) {
		return "";
	}

	const packed: string[] = [];
	let used = 0;
	for (const chunk of chunks) {
		const extra = packed.length === 0 ? chunk.length : chunk.length + 2;
		if (used + extra > maxChars && packed.length > 0) {
			break;
		}
		packed.push(chunk);
		used += extra;
	}
	return packed.join("\n\n");
}

function splitLongUnit(text: string, maxChunkSize: number): string[] {
	const sentences = text.split(/(?<=[.!?])\s+/);
	const parts: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		const next = current ? `${current} ${sentence}` : sentence;
		if (next.length > maxChunkSize && current) {
			parts.push(current);
			current = sentence;
		} else {
			current = next;
		}
	}

	if (current) {
		parts.push(current);
	}
	return parts.length > 0 ? parts : [text.slice(0, maxChunkSize)];
}
