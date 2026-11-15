import { setIcon } from "obsidian";
import { languageName, lookupSummary, type LookupResult } from "./word-lookup";

/*
 * The define-or-translate result panel, shared by ePub Reader and PDF Annotator.
 *
 * This file is kept identical in both plugins so the result looks the same and
 * sits in the same place (top centre of the reader, never over the selection).
 * Change it in one plugin, then copy it to the other, together with the `lu-*`
 * CSS block. Each plugin sets `--lu-top` so the panel clears its own toolbar.
 */

export interface LookupPanelOptions {
  /** The selected text; the title until the result names the word. */
  text: string;
  /** Copies `text` ("word: result") to the clipboard. */
  onCopy(text: string): Promise<void>;
  /** Highlights the selection with the result as its note. The panel closes once it resolves. */
  onSave(result: LookupResult): Promise<void>;
  /** Called when the panel is closed with its close button (not when the owner removes it). */
  onClose(): void;
}

/** Fills `container` with a lookup result: a definition for English, otherwise a translation. */
export function renderLookupResult(container: HTMLElement, result: LookupResult): void {
  if (result.kind === "definition") {
    if (result.phonetic) container.createDiv({ cls: "lu-phonetic", text: result.phonetic });
    for (const meaning of result.meanings) {
      if (meaning.partOfSpeech) container.createEl("h4", { cls: "lu-pos", text: meaning.partOfSpeech });
      const list = container.createEl("ol", { cls: "lu-senses" });
      for (const sense of meaning.senses) {
        const item = list.createEl("li", { text: sense.definition });
        if (sense.example) item.createDiv({ cls: "lu-example", text: `“${sense.example}”` });
      }
    }
  } else if (result.kind === "translation") {
    container.createDiv({ cls: "lu-translation", text: result.translation });
    container.createDiv({ cls: "lu-source", text: `Translated from ${languageName(result.sourceLanguage)}` });
  } else {
    container.createDiv({ cls: "lu-status", text: "No definition found." });
  }
}

/**
 * The result panel: the word and a close button, then "Looking up…", the
 * result or what went wrong, and Copy and "Save as highlight" kept visible at
 * the bottom while a long result scrolls.
 */
export class LookupPanel {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly actionsEl: HTMLElement;

  constructor(parent: HTMLElement, private readonly options: LookupPanelOptions) {
    this.el = parent.createDiv({ cls: "lu-panel", attr: { role: "dialog", "aria-label": "Define or translate" } });
    const header = this.el.createDiv({ cls: "lu-header" });
    this.titleEl = header.createDiv({ cls: "lu-title", text: options.text.replace(/\s+/g, " ").trim().slice(0, 120) });
    const close = header.createEl("button", { cls: "clickable-icon lu-close", attr: { type: "button", "aria-label": "Close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      this.remove();
      options.onClose();
    });
    this.bodyEl = this.el.createDiv({ cls: "lu-body" });
    this.actionsEl = this.el.createDiv({ cls: "lu-actions" });
    this.showLoading();
  }

  get isOpen(): boolean {
    return this.el.isConnected;
  }

  showLoading(): void {
    this.bodyEl.empty();
    this.actionsEl.empty();
    this.actionsEl.hide();
    this.bodyEl.createDiv({ cls: "lu-status", text: "Looking up…" });
  }

  showError(error: unknown): void {
    this.bodyEl.empty();
    this.actionsEl.empty();
    this.actionsEl.hide();
    const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
    this.bodyEl.createDiv({ cls: "lu-status", text: `Could not look this up${reason}. Check your internet connection and try again.` });
  }

  showResult(result: LookupResult): void {
    if (result.text) this.titleEl.setText(result.text);
    this.bodyEl.empty();
    renderLookupResult(this.bodyEl, result);
    this.actionsEl.empty();
    if (result.kind === "not-found") {
      this.actionsEl.hide();
      return;
    }
    this.actionsEl.show();
    const copy = this.actionsEl.createEl("button", { text: "Copy", attr: { type: "button" } });
    const save = this.actionsEl.createEl("button", { cls: "mod-cta", text: "Save as highlight", attr: { type: "button" } });
    copy.addEventListener("click", () => {
      void this.options.onCopy(`${result.text}: ${lookupSummary(result)}`).then(
        () => copy.setText("Copied"),
        () => copy.setText("Could not copy"),
      );
    });
    save.addEventListener("click", () => {
      save.disabled = true;
      void this.options.onSave(result).then(() => this.remove(), (error: unknown) => {
        console.error("Could not save the lookup", error);
        save.disabled = false;
        save.setText("Save as highlight");
        this.bodyEl.createDiv({ cls: "lu-status lu-error", text: error instanceof Error && error.message ? error.message : "Could not save the lookup." });
      });
    });
  }

  remove(): void {
    this.el.remove();
  }
}
