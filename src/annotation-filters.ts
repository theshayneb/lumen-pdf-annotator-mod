import { setIcon } from "obsidian";

/*
 * The highlights panel's filter bar, shared by PDF Annotator and ePub Reader.
 *
 * This file is kept identical in both plugins so their highlight lists filter
 * and sort the same way and look alike. Change it in one plugin, then copy it
 * to the other, together with the `af-*` CSS block.
 */

export type NoteFilter = "all" | "with-note" | "without-note" | "page-notes";
export type DateFilter = "all" | "today" | "7d" | "30d";
/** "reading" is the order of the book or PDF. */
export type SortOrder = "reading" | "newest" | "oldest" | "color";

export interface AnnotationFilters {
  query: string;
  /** A color value, or "" for every color. */
  color: string;
  /** A tag, or "" for every tag. */
  tag: string;
  /** A chapter or section, or "" for all. */
  section: string;
  note: NoteFilter;
  date: DateFilter;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: AnnotationFilters = {
  query: "",
  color: "",
  tag: "",
  section: "",
  note: "all",
  date: "all",
  sort: "reading",
};

/** True when nothing narrows the list (sorting aside). */
export function isUnfiltered(filters: AnnotationFilters): boolean {
  return !filters.query.trim() && !filters.color && !filters.tag && !filters.section && filters.note === "all" && filters.date === "all";
}

/** Whether something made at `createdAt` passes the date filter. */
export function matchesDate(createdAt: number, date: DateFilter, now = Date.now()): boolean {
  if (date === "all") return true;
  if (date === "today") return createdAt >= new Date(now).setHours(0, 0, 0, 0);
  return createdAt >= now - (date === "7d" ? 7 : 30) * 86_400_000;
}

/** A color chip: the color, its name for this book, and how many highlights use it. */
export interface FilterColor {
  value: string;
  label: string;
  count: number;
  /** The book gave this color its own name, which is then shown on the chip. */
  named: boolean;
}

export interface FilterBarContent {
  filters: AnnotationFilters;
  colors: FilterColor[];
  tags: string[];
  /** Chapters (books) or outline sections (PDFs) that have highlights; the filter is hidden when empty. */
  sections: string[];
  /** "chapters" or "sections", used in "All chapters". */
  sectionWord: string;
  /** Offer "Page notes" in the notes filter (PDFs). */
  pageNotes: boolean;
  /** "12/40" style count of shown and total highlights. */
  shown: number;
  total: number;
}

export interface FilterBarOptions {
  /** What the search box searches, e.g. "Search highlights". */
  searchPlaceholder: string;
  onChange(filters: AnnotationFilters): void;
  /** Opens the "Highlight colors" window. */
  onEditColors(): void;
}

const NOTE_LABELS: Array<[NoteFilter, string]> = [
  ["all", "With or without notes"],
  ["with-note", "With notes"],
  ["without-note", "Without notes"],
  ["page-notes", "Page notes"],
];
const DATE_LABELS: Array<[DateFilter, string]> = [["all", "Any time"], ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]];
const SORT_LABELS: Array<[SortOrder, string]> = [["reading", "Reading order"], ["newest", "Newest first"], ["oldest", "Oldest first"], ["color", "By color"]];

/**
 * The filter bar: a search box, color chips (with "All" and a button for the
 * "Highlight colors" window), then tag, chapter or section, notes, date and
 * sort menus. Built once; `update` refreshes it without losing the search
 * box's focus.
 */
export class FilterBar {
  readonly el: HTMLElement;
  readonly searchInput: HTMLInputElement;
  private readonly colorsEl: HTMLElement;
  private readonly tagSelect: HTMLSelectElement;
  private readonly sectionSelect: HTMLSelectElement;
  private readonly noteSelect: HTMLSelectElement;
  private readonly dateSelect: HTMLSelectElement;
  private readonly sortSelect: HTMLSelectElement;
  private readonly countEl: HTMLElement;
  private filters: AnnotationFilters = { ...DEFAULT_FILTERS };
  private searchTimer = 0;

  constructor(parent: HTMLElement, private readonly options: FilterBarOptions) {
    this.el = parent.createDiv({ cls: "af-bar" });
    const search = this.el.createDiv({ cls: "af-search" });
    setIcon(search.createSpan({ cls: "af-search-icon" }), "search");
    this.searchInput = search.createEl("input", { attr: { type: "search", placeholder: options.searchPlaceholder, "aria-label": options.searchPlaceholder } });
    this.searchInput.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.emit({ query: this.searchInput.value }), 150);
    });
    const colorRow = this.el.createDiv({ cls: "af-color-row" });
    this.colorsEl = colorRow.createDiv({ cls: "af-colors", attr: { role: "group", "aria-label": "Filter by color" } });
    const edit = colorRow.createEl("button", { cls: "af-edit-colors", attr: { type: "button", "aria-label": "Name and add highlight colors" } });
    setIcon(edit.createSpan({ cls: "af-edit-colors-icon" }), "palette");
    edit.createSpan({ text: "Colors" });
    edit.addEventListener("click", () => options.onEditColors());
    const menus = this.el.createDiv({ cls: "af-menus" });
    const menu = (label: string, change: (value: string) => void): HTMLSelectElement => {
      const select = menus.createEl("select", { cls: "dropdown af-select", attr: { "aria-label": label } });
      select.addEventListener("change", () => change(select.value));
      return select;
    };
    this.tagSelect = menu("Filter by tag", value => this.emit({ tag: value }));
    this.sectionSelect = menu("Filter by chapter or section", value => this.emit({ section: value }));
    this.noteSelect = menu("Filter by note", value => this.emit({ note: value as NoteFilter }));
    this.dateSelect = menu("Filter by date", value => this.emit({ date: value as DateFilter }));
    for (const [value, text] of DATE_LABELS) this.dateSelect.createEl("option", { value, text });
    this.sortSelect = menu("Sort", value => this.emit({ sort: value as SortOrder }));
    for (const [value, text] of SORT_LABELS) this.sortSelect.createEl("option", { value, text });
    this.countEl = menus.createSpan({ cls: "af-count" });
  }

  private emit(patch: Partial<AnnotationFilters>): void {
    this.filters = { ...this.filters, ...patch };
    this.options.onChange({ ...this.filters });
  }

  update(content: FilterBarContent): void {
    this.filters = { ...content.filters };
    if (this.searchInput.value !== content.filters.query && this.searchInput.ownerDocument.activeElement !== this.searchInput) {
      this.searchInput.value = content.filters.query;
    }
    this.colorsEl.empty();
    const all = this.colorsEl.createEl("button", { cls: "af-chip af-chip-all", text: "All", attr: { type: "button", "aria-pressed": String(!content.filters.color) } });
    all.toggleClass("is-active", !content.filters.color);
    all.addEventListener("click", () => this.emit({ color: "" }));
    for (const color of content.colors) {
      const active = content.filters.color === color.value;
      const chip = this.colorsEl.createEl("button", {
        cls: "af-chip",
        attr: { type: "button", "aria-pressed": String(active), "aria-label": `Show ${color.label} (${color.count})`, title: `${color.label} · ${color.count}` },
      });
      chip.style.setProperty("--af-color", color.value);
      chip.toggleClass("is-active", active);
      chip.toggleClass("is-empty", color.count === 0);
      chip.createSpan({ cls: "af-swatch" });
      if (color.named) chip.createSpan({ cls: "af-chip-name", text: color.label });
      chip.createSpan({ cls: "af-chip-count", text: String(color.count) });
      chip.addEventListener("click", () => this.emit({ color: active ? "" : color.value }));
      chip.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.options.onEditColors();
      });
    }
    fill(this.tagSelect, [["", content.tags.length ? "All tags" : "No tags"], ...content.tags.map(tag => [tag, `#${tag}`] as [string, string])], content.filters.tag);
    this.tagSelect.disabled = !content.tags.length;
    fill(this.sectionSelect, [["", `All ${content.sectionWord}`], ...content.sections.map(section => [section, section] as [string, string])], content.filters.section);
    this.sectionSelect.toggleClass("af-hidden", !content.sections.length);
    fill(this.noteSelect, NOTE_LABELS.filter(([value]) => content.pageNotes || value !== "page-notes"), content.filters.note);
    this.dateSelect.value = content.filters.date;
    this.sortSelect.value = content.filters.sort;
    this.countEl.setText(content.shown === content.total ? String(content.total) : `${content.shown}/${content.total}`);
    this.countEl.setAttr("aria-label", `${content.shown} of ${content.total} shown`);
  }
}

function fill(select: HTMLSelectElement, options: Array<[string, string]>, value: string): void {
  select.empty();
  for (const [optionValue, text] of options) select.createEl("option", { value: optionValue, text });
  select.value = options.some(([optionValue]) => optionValue === value) ? value : options[0]?.[0] ?? "";
}
