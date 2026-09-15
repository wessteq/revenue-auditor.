import { App, TFile, TFolder, normalizePath } from "obsidian";

/** Folder that holds only the master `Audit_Index.md`. */
export const VAULT_FOLDER_ANALYSIS = "Analysis";

/** Legacy numbered folders — skipped during batch walks. */
export const VAULT_FOLDER_CONTRACTS = "01_Contracts";
export const VAULT_FOLDER_PAYMENTS = "02_Payments";

/** Sole folder for generated audit reports (`Audit_*.md` / `Audit_*.json`). */
export const VAULT_FOLDER_AUDIT_REPORTS = "03_Audit_Reports";

const AUDIT_INDEX_FILENAME = "Audit_Index.md";
const AUDIT_ARTIFACT_FILENAME = /^Audit_\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?\.(md|json)$/i;
const SINGLETON_AUDIT_REPORTS = new Set(["Audit_Report.md", "Batch_Audit_Summary.md"]);

export interface VaultRouterLogger {
	info(message: string): void;
	warn(message: string): void;
}

export interface OrganizeAuditFilesInput {
	contractFile?: TFile | null;
	paymentsFile?: TFile | null;
	reportFile?: TFile | null;
}

export interface OrganizedAuditFiles {
	contractFile: TFile | null;
	paymentsFile: TFile | null;
	reportFile: TFile | null;
	movedCount: number;
}

/** Creates `Analysis/` when it is missing so `Audit_Index.md` has a home. */
export async function ensureAnalysisFolder(app: App): Promise<string> {
	await ensureFolder(app, VAULT_FOLDER_ANALYSIS);
	return VAULT_FOLDER_ANALYSIS;
}

/** Creates `03_Audit_Reports/` when it is missing so generated reports have a home. */
export async function ensureAuditReportsFolder(app: App): Promise<string> {
	await ensureFolder(app, VAULT_FOLDER_AUDIT_REPORTS);
	return VAULT_FOLDER_AUDIT_REPORTS;
}

/** @deprecated Use `ensureAnalysisFolder` / `ensureAuditReportsFolder`. */
export async function ensureStandardVaultFolders(app: App): Promise<void> {
	await ensureAnalysisFolder(app);
	await ensureAuditReportsFolder(app);
}

/**
 * Files generated reports into `03_Audit_Reports/` (including leftovers in
 * the vault root or `Analysis/`). `Audit_Index.md` stays in `Analysis/`.
 * Contract PDFs and payment CSVs are left where they are.
 */
export async function organizeAuditWorkspace(
	app: App,
	files: OrganizeAuditFilesInput,
	logger?: VaultRouterLogger
): Promise<OrganizedAuditFiles> {
	await ensureAnalysisFolder(app);
	await ensureAuditReportsFolder(app);

	let movedCount = 0;
	const track = (from: string, to: string) => {
		if (from !== to) {
			movedCount += 1;
			logger?.info(`Moved "${from}" → "${to}".`);
		}
	};

	const contractFile = files.contractFile ?? null;
	const paymentsFile = files.paymentsFile ?? null;
	let reportFile = files.reportFile
		? await routeVaultFile(app, files.reportFile, logger, track)
		: null;

	if (reportFile) {
		const sidecar = siblingAuditSidecar(app, reportFile);
		if (sidecar) {
			await routeVaultFile(app, sidecar, logger, track);
		}
	}

	movedCount += await sweepMisplacedAuditReports(app, logger);
	await collectAuditIndexToAnalysis(app, logger);

	if (reportFile) {
		const live = app.vault.getAbstractFileByPath(reportFile.path);
		reportFile = live instanceof TFile ? live : reportFile;
	}

	return { contractFile, paymentsFile, reportFile, movedCount };
}

/**
 * Moves a generated audit report into `03_Audit_Reports/`, or
 * `Audit_Index.md` into `Analysis/`. Other file types are left untouched.
 */
export async function routeVaultFile(
	app: App,
	file: TFile,
	logger?: VaultRouterLogger,
	onMoved?: (from: string, to: string) => void
): Promise<TFile> {
	const destination = destinationFolderFor(file, app);
	if (!destination) {
		return file;
	}
	return relocateOrDedupe(app, file, destination, logger, onMoved);
}

export async function moveFileToFolder(
	app: App,
	file: TFile,
	destFolder: string,
	logger?: VaultRouterLogger,
	onMoved?: (from: string, to: string) => void
): Promise<TFile> {
	return relocateOrDedupe(app, file, destFolder, logger, onMoved);
}

export function destinationFolderFor(file: TFile, app: App): string | null {
	const configDir = app.vault.configDir;
	if (file.path.startsWith(`${configDir}/`) || file.path.includes(`/${configDir}/`)) {
		return null;
	}
	if (isAuditIndexFile(file)) {
		return VAULT_FOLDER_ANALYSIS;
	}
	if (isGeneratedAuditReport(file)) {
		return VAULT_FOLDER_AUDIT_REPORTS;
	}
	return null;
}

export function isAuditIndexFile(file: TFile): boolean {
	return file.name === AUDIT_INDEX_FILENAME;
}

export function isGeneratedAuditReport(file: TFile): boolean {
	return SINGLETON_AUDIT_REPORTS.has(file.name) || AUDIT_ARTIFACT_FILENAME.test(file.name);
}

async function ensureFolder(app: App, path: string): Promise<TFolder | null> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) {
		return existing;
	}
	if (existing) {
		console.warn(`Revenue Auditor: "${path}" exists but is not a folder.`);
		return null;
	}
	try {
		return await app.vault.createFolder(path);
	} catch (error: unknown) {
		const raced = app.vault.getAbstractFileByPath(path);
		if (raced instanceof TFolder) {
			return raced;
		}
		console.warn(`Revenue Auditor: could not create folder "${path}".`, error);
		return null;
	}
}

/**
 * Moves leftover `Audit_*` / batch-summary files out of the vault root and
 * `Analysis/` into `03_Audit_Reports/`. Never relocates `Audit_Index.md`.
 */
async function sweepMisplacedAuditReports(app: App, logger?: VaultRouterLogger): Promise<number> {
	const candidates: TFile[] = [];
	const root = app.vault.getRoot();
	for (const child of [...root.children]) {
		if (child instanceof TFile && isGeneratedAuditReport(child) && !isAuditIndexFile(child)) {
			candidates.push(child);
		}
	}

	const analysis = app.vault.getAbstractFileByPath(VAULT_FOLDER_ANALYSIS);
	if (analysis instanceof TFolder) {
		for (const child of [...analysis.children]) {
			if (child instanceof TFile && isGeneratedAuditReport(child) && !isAuditIndexFile(child)) {
				candidates.push(child);
			}
		}
	}

	let moved = 0;
	for (const file of candidates) {
		if (isInFolder(file, VAULT_FOLDER_AUDIT_REPORTS)) {
			continue;
		}
		const from = file.path;
		const relocated = await relocateOrDedupe(app, file, VAULT_FOLDER_AUDIT_REPORTS, logger);
		if (relocated.path !== from) {
			moved += 1;
			logger?.info(`Moved "${from}" → "${relocated.path}".`);
		} else if (!app.vault.getAbstractFileByPath(from)) {
			moved += 1;
		}
	}
	return moved;
}

/**
 * Ensures the master `Audit_Index.md` lives in `Analysis/`. Duplicates at
 * the vault root or in `03_Audit_Reports/` are trashed once the master exists.
 */
async function collectAuditIndexToAnalysis(app: App, logger?: VaultRouterLogger): Promise<void> {
	const analysisIndex = app.vault.getAbstractFileByPath(
		`${VAULT_FOLDER_ANALYSIS}/${AUDIT_INDEX_FILENAME}`
	);
	const strayPaths = ["Audit_Index.md", `${VAULT_FOLDER_AUDIT_REPORTS}/${AUDIT_INDEX_FILENAME}`];

	for (const path of strayPaths) {
		const stray = app.vault.getAbstractFileByPath(path);
		if (!(stray instanceof TFile) || stray === analysisIndex) {
			continue;
		}
		if (analysisIndex instanceof TFile) {
			try {
				await app.fileManager.trashFile(stray);
				logger?.info(
					`Removed duplicate "${stray.path}" (master index is ${analysisIndex.path}).`
				);
			} catch (error: unknown) {
				logger?.warn(
					`Could not remove duplicate "${path}": ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
			continue;
		}
		await relocateOrDedupe(app, stray, VAULT_FOLDER_ANALYSIS, logger);
	}
}

/**
 * Moves `file` into `destFolder`. If a same-named file already lives there,
 * keeps that copy and trashes the source so `Analysis/` never holds a
 * duplicate report next to `Audit_Index.md`.
 */
async function relocateOrDedupe(
	app: App,
	file: TFile,
	destFolder: string,
	logger?: VaultRouterLogger,
	onMoved?: (from: string, to: string) => void
): Promise<TFile> {
	if (isInFolder(file, destFolder)) {
		return file;
	}

	const from = file.path;
	const destPath = normalizePath(destFolder ? `${destFolder}/${file.name}` : file.name);
	if (normalizePath(from) === destPath) {
		return file;
	}

	const occupant = app.vault.getAbstractFileByPath(destPath);
	if (occupant && occupant !== file) {
		if (occupant instanceof TFile) {
			try {
				await app.fileManager.trashFile(file);
				logger?.info(`Removed duplicate "${from}" (kept "${destPath}").`);
			} catch (error: unknown) {
				logger?.warn(
					`Could not remove duplicate "${from}": ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
			return occupant;
		}
		logger?.warn(`Skipped moving "${from}": "${destPath}" already exists.`);
		return file;
	}

	try {
		await app.fileManager.renameFile(file, destPath);
		onMoved?.(from, file.path);
		return file;
	} catch (error: unknown) {
		logger?.warn(
			`Could not move "${from}" to "${destPath}": ${error instanceof Error ? error.message : String(error)}`
		);
		return file;
	}
}

function siblingAuditSidecar(app: App, reportFile: TFile): TFile | null {
	if (reportFile.extension.toLowerCase() !== "md") {
		return null;
	}
	const parentPath = reportFile.parent && !reportFile.parent.isRoot() ? reportFile.parent.path : "";
	const sidecarPath = parentPath ? `${parentPath}/${reportFile.basename}.json` : `${reportFile.basename}.json`;
	const sidecar = app.vault.getAbstractFileByPath(sidecarPath);
	return sidecar instanceof TFile ? sidecar : null;
}

function isInFolder(file: TFile, folderPath: string): boolean {
	if (!file.parent) {
		return false;
	}
	if (!folderPath) {
		return file.parent.isRoot();
	}
	return file.parent.path === folderPath;
}
