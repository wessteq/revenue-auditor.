/**
 * Strips TOC / signature / patent noise and keeps financially relevant
 * passages so a 150-page credit agreement is not dumped into Ollama.
 *
 * Full extracted text still goes to the regex extractors. Only the AI
 * payload and the collapsed source snapshot use this filtered view.
 */

import { chunkText, packChunks } from "./textChunker";

export const DEFAULT_AI_PAYLOAD_CHARS = 12_000;

export interface SanitizedContractText {
	cleanText: string;
	originalChars: number;
	sanitizedChars: number;
	removedChars: number;
	retainedKeywords: string[];
	unitCount: number;
}

export interface PreparedAiText {
	payload: string;
	originalChars: number;
	sanitizedChars: number;
	payloadChars: number;
	removedChars: number;
	chunkCount: number;
	retainedKeywords: string[];
}

interface ScoredUnit {
	text: string;
	index: number;
	score: number;
	keywords: string[];
}

const HIGH_VALUE_KEYWORDS = [
	"aggregate revolving",
	"applicable margin",
	"commitment",
	"event of default",
	"interest rate",
	"late fee",
	"late payment",
	"libor",
	"maturity",
	"penalty",
	"principal",
	"revolving termination",
	"termination date",
	"unused commitment",
	"базовая цена",
	"индексация",
	"пени",
	"просрочка",
	"стоимость услуг",
	"штраф",
];

const MEDIUM_KEYWORDS = [
	"base rate",
	"borrow",
	"cash collateral",
	"default",
	"due and payable",
	"due date",
	"fee",
	"force majeure",
	"indemnif",
	"indexation",
	"interest",
	"liability",
	"loan",
	"overadvance",
	"payment",
	"prepay",
	"rate",
	"renewal",
	"termination",
	"платеж",
	"повышение",
	"ставка",
	"стоимость",
	"цена",
];

const LOW_KEYWORDS = ["adjustment", "breach", "cost", "covenant", "damage", "price", "term"];

/**
 * Drops TOC rows, dotted leaders, lone page numbers, and signature
 * openers so extractors do not treat index noise as financial terms.
 */
export function isIgnorableSourceLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) {
		return false;
	}
	if (/^\s*(table\s+of\s+contents|contents)\s*$/i.test(trimmed)) {
		return true;
	}
	if (/(?:\.\s*){4,}\s*\d+\s*$/.test(trimmed) || /\.{5,}\s*\d+\s*$/.test(trimmed)) {
		return true;
	}
	if (/^\s*\|.+\|\s*\d{1,3}\s*\|?\s*$/.test(trimmed) && /(?:\.\s*){3,}|\.{3,}/.test(trimmed)) {
		return true;
	}
	if (/^\s*-{0,3}\s*\d{1,3}\s*$/.test(trimmed)) {
		return true;
	}
	if (/^\[\s*page\s+\d+[^\]]*\s*\]$/i.test(trimmed)) {
		return true;
	}
	if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(trimmed)) {
		return true;
	}
	if (/^\s*(in witness whereof|witness the following|signed\s+as\s+of|signed and executed)\b/i.test(trimmed)) {
		return true;
	}
	return false;
}

export function sanitizeContractText(rawText: string, maxChars = DEFAULT_AI_PAYLOAD_CHARS): SanitizedContractText {
	const originalChars = rawText.length;
	const stripped = stripJunk(rawText);
	const units = splitIntoUnits(stripped);
	const scored = units
		.map((text, index) => scoreUnit(text, index))
		.filter((unit) => unit.score > 0);

	const selected = selectUnits(scored, maxChars);
	const cleanText = selected.map((unit) => unit.text).join("\n\n");
	const retainedKeywords = uniqueKeywords(selected);

	return {
		cleanText,
		originalChars,
		sanitizedChars: cleanText.length,
		removedChars: Math.max(0, originalChars - cleanText.length),
		retainedKeywords,
		unitCount: selected.length,
	};
}

export function prepareContractTextForAi(
	rawText: string,
	maxChars = DEFAULT_AI_PAYLOAD_CHARS
): PreparedAiText {
	const sanitized = sanitizeContractText(rawText, maxChars);
	const chunks = chunkText(sanitized.cleanText);
	const payload = packChunks(chunks, maxChars);

	return {
		payload,
		originalChars: sanitized.originalChars,
		sanitizedChars: sanitized.sanitizedChars,
		payloadChars: payload.length,
		removedChars: sanitized.removedChars,
		chunkCount: Math.max(chunks.length, payload ? 1 : 0),
		retainedKeywords: sanitized.retainedKeywords,
	};
}

function stripJunk(text: string): string {
	const withoutSignatures = text.replace(
		/\n\s*(in witness whereof|signed and executed|signature page follows)[\s\S]*$/i,
		"\n"
	);

	return withoutSignatures
		.split(/\r?\n/)
		.filter((line) => !isIgnorableSourceLine(line) && !isTrademarkOrPatentRow(line))
		.join("\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ ]{2,}/g, " ")
		.trim();
}

function isTrademarkOrPatentRow(line: string): boolean {
	if (!/\b(trademark|patent|registered mark)\b/i.test(line) && !/\bTMA\d+\b/.test(line)) {
		return false;
	}
	return !hasKeyword(line, HIGH_VALUE_KEYWORDS) && !hasKeyword(line, MEDIUM_KEYWORDS);
}

function splitIntoUnits(text: string): string[] {
	const blocks = text.split(/\n{2,}/);
	const units: string[] = [];

	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) {
			continue;
		}
		if (trimmed.length <= 1500) {
			units.push(trimmed);
			continue;
		}

		const pieces = trimmed.split(/(?<=[.!?])\s+|\n+/);
		let current = "";
		for (const piece of pieces) {
			const next = current ? `${current} ${piece}` : piece;
			if (next.length > 900 && current) {
				units.push(current.trim());
				current = piece;
			} else {
				current = next;
			}
		}
		if (current.trim()) {
			units.push(current.trim());
		}
	}

	return units;
}

function scoreUnit(text: string, index: number): ScoredUnit {
	const keywords = [
		...matchedKeywords(text, HIGH_VALUE_KEYWORDS),
		...matchedKeywords(text, MEDIUM_KEYWORDS),
		...matchedKeywords(text, LOW_KEYWORDS),
	];
	const high = matchedKeywords(text, HIGH_VALUE_KEYWORDS).length;
	const medium = matchedKeywords(text, MEDIUM_KEYWORDS).length;
	const low = matchedKeywords(text, LOW_KEYWORDS).length;
	const moneyBonus = /\$|€|£|₽|\b(?:usd|eur|gbp|rub)\b/i.test(text) ? 1 : 0;
	const percentBonus = /\d+(?:[.,]\d+)?\s*%/.test(text) ? 1 : 0;
	const score = high * 4 + medium * 2 + low + moneyBonus + percentBonus;

	return { text, index, score, keywords };
}

function selectUnits(units: ScoredUnit[], maxChars: number): ScoredUnit[] {
	if (units.length === 0) {
		return [];
	}

	const ranked = [...units].sort((a, b) => b.score - a.score || a.index - b.index);
	const kept = new Set<number>();
	let used = 0;

	for (const unit of ranked) {
		const extra = kept.size === 0 ? unit.text.length : unit.text.length + 2;
		if (used + extra > maxChars && kept.size > 0) {
			continue;
		}
		kept.add(unit.index);
		used += extra;
		if (used >= maxChars) {
			break;
		}
	}

	return units.filter((unit) => kept.has(unit.index));
}

function matchedKeywords(text: string, keywords: string[]): string[] {
	const lower = text.toLowerCase();
	return keywords.filter((keyword) => lower.includes(keyword));
}

function hasKeyword(text: string, keywords: string[]): boolean {
	return matchedKeywords(text, keywords).length > 0;
}

function uniqueKeywords(units: ScoredUnit[]): string[] {
	const seen = new Set<string>();
	for (const unit of units) {
		for (const keyword of unit.keywords) {
			seen.add(keyword);
		}
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

