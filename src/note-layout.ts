import { App, Modal, Setting, setIcon } from "obsidian";

/*
 * Note layouts shared by PDF Annotator and ePub Reader.
 *
 * This file is kept identical in both plugins so a book's note looks the same
 * whichever plugin wrote it. Change it in one plugin, then copy it to the other.
 */

/** How highlights are laid out in a book's note, chosen per book. */
export type NoteLayout = "by-color" | "callout";

export function isNoteLayout(value: unknown): value is NoteLayout {
  return value === "by-color" || value === "callout";
}

/** The callout that holds highlights in the "callout" layout. */
export const CALLOUT_HEADER = "> > > [!quotenew] Quotes & References";
/** Every highlight in the callout layout is one list item starting with this. */
export const CALLOUT_ITEM_PREFIX = "> > - ";
/** Highlighted passages carry this tag in the callout layout. */
export const QUOTE_TAG = "#quote";

/** One highlight, already turned into Markdown by the plugin that owns it. */
export interface LayoutEntry {
  /** The passage (escaped as the plugin needs), an image embed, or a label such as "Page note". */
  text: string;
  /** Obsidian tags, with their `#`. */
  tags: string[];
  /** The note on one line, or "". */
  note: string;
  /** The highlight color, as a CSS color. */
  color: string;
  /** Page labels; several when the highlight spans pages. */
  pages: string[];
  /** The chapter, for books that have them. */
  chapter?: string;
  /** Link back to the highlight in the book or PDF. */
  link: string;
  /**
   * A saved word lookup or a page note: in the callout layout it is written
   * without `#quote`, with its note inline (`word *-- note (p. 4)*`).
   */
  plain?: boolean;
  /** Listed under "Page notes" instead of its color in the by-color layout. */
  pageNote?: boolean;
}

function location(entry: LayoutEntry, single: string, several: string): string {
  const pages = entry.pages.filter(Boolean);
  const label = pages.length > 1 ? `${several} ${pages.join(", ")}` : pages.length ? `${single} ${pages[0]}` : "Open in book";
  return [entry.chapter?.trim() ?? "", `[${label}](${entry.link})`].filter(Boolean).join(", ");
}

function tagsWithout(tags: string[], omit: string): string[] {
  return Array.from(new Set(tags.filter(tag => tag && tag !== omit)));
}

/**
 * One highlight in the callout layout:
 * `> > - passage #quote #tags *-- note* *(Chapter, [p. 14](link))*`,
 * or for a lookup or page note `> > - word *-- note (Chapter, [p. 14](link))*`.
 */
export function calloutLine(entry: LayoutEntry): string {
  const where = location(entry, "p.", "pp.");
  if (entry.plain) return `${CALLOUT_ITEM_PREFIX}${entry.text} *${entry.note ? `-- ${entry.note} ` : ""}(${where})*`;
  return [
    `${CALLOUT_ITEM_PREFIX}${entry.text}`,
    QUOTE_TAG,
    ...tagsWithout(entry.tags, QUOTE_TAG),
    entry.note ? `*-- ${entry.note}*` : "",
    `*(${where})*`,
  ].filter(Boolean).join(" ");
}

/**
 * One highlight in the by-color layout, with its note as a nested item:
 *
 *     - passage #tags *(Chapter, [pg. 14](link))*
 *     	- ["] *note*
 */
export function byColorItem(entry: LayoutEntry): string[] {
  const main = [entry.text || "Page note", ...tagsWithout(entry.tags, ""), `*(${location(entry, "pg.", "pgs.")})*`].join(" ");
  const lines = [`- ${main}`];
  if (entry.note) lines.push(`\t- ["] *${entry.note}*`);
  return lines;
}

/** A CSS color safe to put in a style attribute, or null. */
export function safeCssColor(color: string): string | null {
  const value = color.trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]+$/i.test(value) || /^(rgb|hsl)a?\([\d.,%\s]+\)$/i.test(value) ? value : null;
}

/** A color heading, shown in the color itself. `label` must already be safe Markdown. */
export function colorHeading(color: string, label: string): string {
  const css = safeCssColor(color);
  return css ? `# <span style="color: ${css}">${label}</span>` : `# ${label}`;
}

/**
 * The by-color layout: a heading per color in `colors` order (colors without
 * highlights are skipped), each highlight under its color in the order given,
 * then page notes under "Page notes".
 */
export function byColorLines(entries: LayoutEntry[], colors: string[], label: (color: string) => string): string[] {
  const groups = new Map<string, LayoutEntry[]>();
  const notes: LayoutEntry[] = [];
  for (const entry of entries) {
    if (entry.pageNote) {
      notes.push(entry);
      continue;
    }
    const key = entry.color.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const ordered = [...colors.map(color => color.toLowerCase()), ...groups.keys()];
  const lines: string[] = [];
  for (const key of new Set(ordered)) {
    const group = groups.get(key);
    const first = group?.[0];
    if (!group || !first) continue;
    lines.push(colorHeading(first.color, label(first.color)), "");
    for (const entry of group) lines.push(...byColorItem(entry));
    lines.push("");
  }
  if (notes.length) {
    lines.push("# Page notes", "");
    for (const entry of notes) lines.push(...byColorItem(entry));
    lines.push("");
  }
  return lines;
}

/** The callout layout: the callout header, then one line per highlight in the order given. */
export function calloutLines(entries: LayoutEntry[]): string[] {
  return [CALLOUT_HEADER, ...entries.map(calloutLine)];
}

const LAYOUT_CHOICES: Array<{ layout: NoteLayout; name: string; description: string; preview: string }> = [
  {
    layout: "by-color",
    name: "Headings by color",
    description: "A heading for each highlight color, in an order you choose. Notes go on their own line under each highlight.",
    preview: "# Important\n\n- the highlighted passage #tag (pg. 14)\n\t- [\"] your note",
  },
  {
    layout: "callout",
    name: "Quotes callout",
    description: "Every highlight on one line in reading order, inside a \"Quotes & References\" callout.",
    preview: "> > > [!quotenew] Quotes & References\n> > - the highlighted passage #quote #tag -- your note (p. 14)",
  },
];

class NoteLayoutModal extends Modal {
  private chosen: NoteLayout | null = null;

  constructor(
    app: App,
    private readonly subject: string,
    private readonly current: NoteLayout | null,
    private readonly done: (layout: NoteLayout | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("note-layout-modal");
    this.setTitle(`Note layout for ${this.subject}`);
    this.contentEl.createEl("p", {
      cls: "note-layout-help",
      text: "Choose how this note lays out your highlights. The choice is remembered, and you can change it later from the command palette.",
    });
    const options = this.contentEl.createDiv({ cls: "note-layout-options" });
    for (const choice of LAYOUT_CHOICES) {
      const button = options.createEl("button", { cls: "note-layout-option", attr: { type: "button" } });
      if (choice.layout === this.current) button.addClass("is-current");
      const heading = button.createDiv({ cls: "note-layout-option-name" });
      setIcon(heading.createSpan({ cls: "note-layout-option-icon" }), choice.layout === "by-color" ? "palette" : "quote");
      heading.createSpan({ text: choice.name + (choice.layout === this.current ? " (current)" : "") });
      button.createDiv({ cls: "note-layout-option-description", text: choice.description });
      button.createEl("pre", { cls: "note-layout-option-preview", text: choice.preview });
      button.addEventListener("click", () => {
        this.chosen = choice.layout;
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.chosen);
  }
}

/** Asks which layout to use. Resolves null when the window is closed without a choice. */
export function chooseNoteLayout(app: App, subject: string, current: NoteLayout | null = null): Promise<NoteLayout | null> {
  return new Promise(resolve => new NoteLayoutModal(app, subject, current, resolve).open());
}

/** A color row in the heading-order window. */
export interface ColorOrderRow {
  color: string;
  /** Plain-text name shown for the color. */
  label: string;
  count: number;
}

class ColorOrderModal extends Modal {
  private order: ColorOrderRow[];
  private listEl!: HTMLElement;
  private chosen: string[] | null = null;

  constructor(
    app: App,
    rows: ColorOrderRow[],
    private readonly subject: string,
    private readonly defaultOrder: string[],
    private readonly confirmText: string,
    private readonly done: (order: string[] | null) => void,
  ) {
    super(app);
    this.order = rows.slice();
  }

  onOpen(): void {
    this.modalEl.addClass("note-layout-order-modal");
    this.setTitle("Order color headings");
    this.contentEl.createEl("p", {
      cls: "note-layout-help",
      text: `Move headings up or down. This order is saved for ${this.subject} and used for automatic updates too.`,
    });
    this.listEl = this.contentEl.createDiv({ cls: "note-layout-order-list" });
    this.renderList();
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("Default order").onClick(() => {
        const rank = new Map(this.defaultOrder.map((color, index) => [color.toLowerCase(), index]));
        const position = (row: ColorOrderRow) => rank.get(row.color.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        this.order.sort((a, b) => position(a) - position(b));
        this.renderList();
      }))
      .addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(button => button.setButtonText(this.confirmText).setCta().onClick(() => {
        this.chosen = this.order.map(row => row.color);
        this.close();
      }));
  }

  private move(index: number, delta: number): void {
    const target = index + delta;
    const row = this.order[index];
    const other = this.order[target];
    if (!row || !other) return;
    this.order[index] = other;
    this.order[target] = row;
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    this.order.forEach((row, index) => {
      const item = this.listEl.createDiv({ cls: "note-layout-order-row" });
      item.createSpan({ cls: "note-layout-swatch" }).style.setProperty("--note-layout-color", row.color);
      item.createSpan({ cls: "note-layout-order-name", text: row.label });
      item.createSpan({ cls: "note-layout-order-count", text: String(row.count) });
      for (const [icon, delta, label, disabled] of [
        ["arrow-up", -1, `Move ${row.label} up`, index === 0],
        ["arrow-down", 1, `Move ${row.label} down`, index === this.order.length - 1],
      ] as const) {
        const button = item.createEl("button", { cls: "clickable-icon note-layout-order-move", attr: { type: "button", "aria-label": label } });
        setIcon(button, icon);
        button.disabled = disabled;
        button.addEventListener("click", () => this.move(index, delta));
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.chosen);
  }
}

/** Asks for the order of color headings. Resolves null when cancelled. */
export function chooseColorOrder(
  app: App,
  rows: ColorOrderRow[],
  options: { subject: string; defaultOrder: string[]; confirmText: string },
): Promise<string[] | null> {
  return new Promise(resolve => new ColorOrderModal(app, rows, options.subject, options.defaultOrder, options.confirmText, resolve).open());
}
