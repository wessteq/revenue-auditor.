# Revenue Auditor — Obsidian Plugin for SEC Credit Agreement Audits

**Revenue Auditor** is a professional-grade Obsidian plugin designed to automate financial contract audits, risk analysis, and payment reconciliation for SEC credit agreements and complex financial contracts. 

It leverages local AI models (via Ollama) and advanced PDF extraction (Docling) to ensure **100% data privacy and compliance** with strict financial confidentiality requirements.

---

## ✨ Key Features

* **📄 Automated Contract Term Extraction**: Automatically parses PDF credit agreements to extract expected values, default interest rates, payment schedules, and covenant terms.
* **📊 Payment Reconciliation Engine**: Cross-references contract commitment figures against actual payment records (`.csv` format) to instantly highlight underpayments, discrepancies, and variances.
* **⚠️ AI Risk & Penalty Analysis**: Generates structured Markdown tables detailing default triggers, late fees, and concealed penalty clauses.
* **📁 Standardized Vault File Routing**: Automatically maintains a clean workspace structure:
  * `01_Contracts/` — Input PDF contracts
  * `02_Payments/` — Input CSV payment ledgers
  * `Analysis/` — Output audit reports and the master `Audit_Index.md`
* **🔒 100% Local & Private**: No contract text or financial data ever leaves your machine. Local processing guarantees zero data leakage.

---

## 📂 Vault Structure Standard

To ensure smooth automated processing, structure your Obsidian vault as follows:

```text
Your_Obsidian_Vault/
├── 01_Contracts/       # Store your credit agreement PDF files here
├── 02_Payments/        # Store your payment ledger CSV files here
└── Analysis/           # Generated reports and master audit index
    ├── Audit_Index.md  # Real-time index of all completed audits
    └── Audit_*.md      # Individual detailed audit reports
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
* **Obsidian** (v1.4.0 or newer)
* **Ollama** running locally (e.g., `ollama run llama3` or `deepseek-r1`)

### 2. Installation
#### Manual Installation
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder named `revenue-auditor` inside your vault's `.obsidian/plugins/` directory:
   ```bash
   mkdir -p .obsidian/plugins/revenue-auditor
   ```
3. Copy the release files into `.obsidian/plugins/revenue-auditor/`.
4. Reload Obsidian and enable **Revenue Auditor** in `Settings -> Community Plugins`.

---

## 💡 How to Run an Audit

1. Place your target contract PDF inside `01_Contracts/` and payment ledgers inside `02_Payments/`.
2. Open the Command Palette in Obsidian (`Ctrl+P` or `Cmd+P`).
3. Search for **`Revenue Auditor: Run Revenue Audit`**.
4. In the modal:
   * **Contract file**: Select the PDF from `01_Contracts/`.
   * **Payments CSV**: Select the corresponding CSV file from `02_Payments/` (or choose `(none - skip financial validation)` to skip payment reconciliation).
5. Click **Start Audit**.
6. View the generated report in `Analysis/` and check the updated summary table in `Analysis/Audit_Index.md`.

---

## ⚙️ Settings & Configuration

In `Settings -> Revenue Auditor`:
* **Ollama Endpoint**: Set your local Ollama server address (default: `http://localhost:11434`).
* **LLM Model**: Select your preferred extraction model (e.g., `llama3.2`, `deepseek-r1`, `mistral`).
* **Extraction Timeout**: Customize the timeout duration for long SEC filings.

---

## 🛡️ Privacy & Security

Revenue Auditor is designed with a **Privacy-First Architecture**:
* Zero external API calls for PDF text processing or LLM inference when using Ollama.
* PDF contents are processed locally in memory.
* No telemetry, analytics, or logging of sensitive financial data.

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for more information.
