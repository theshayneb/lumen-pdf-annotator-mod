import { App, Modal, Notice, Setting } from "obsidian";

/*
 * Highlight colors shared by PDF Annotator and ePub Reader.
 *
 * This file is kept identical in both plugins so the same palette, color
 * names and "Highlight colors" window are used for PDFs and books. Change it
 * in one plugin, then copy it to the other.
 */

/** The built-in palette, in its default order. Highlights store these values. */
export const MARK_COLORS = ["#ffd12d", "#83cb67", "#6f9fe8", "#aa78df", "#e463a1"] as const;

const MARK_COLOR_NAMES: Record<string, string> = {
  "#ffd12d": "Yellow",
  "#83cb67": "Green",
  "#6f9fe8": "Blue",
  "#aa78df": "Purple",
  "#e463a1": "Pink",
};

/** Color words that older data stored instead of a value. */
const COLOR_WORDS: Record<string, string> = {
  yellow: "#ffd12d",
  green: "#83cb67",
  blue: "#6f9fe8",
  purple: "#aa78df",
  pink: "#e463a1",
};

/** Per-book names for highlight colors, keyed by lower-case color value. */
export type ColorNames = Record<string, string>;

/** Suggested extra highlight colors that read well on light pages. */
export const PRESET_EXTRA_COLORS = ["#ffa94d", "#ff8787", "#63e6be", "#66d9e8", "#c0eb75", "#b197fc", "#d4a373", "#ced4da"] as const;
export const MAX_EXTRA_COLORS = 12;

/** The color name that always sorts first, in panels and notes. */
const PRIORITY_COLOR_NAME = "important";

/** A `#rrggbb` color in lower case, or null for anything else. */
export function normalizeHexColor(value: string): string | null {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value.trim().toLowerCase())?.[1];
  if (!hex) return null;
  return `#${hex.length === 3 ? hex.split("").map(char => char + char).join("") : hex}`;
}

/** A stored highlight color as a palette value: hex values as they are, older color words mapped, anything else `fallback`. */
export function toHighlightColor(value: unknown, fallback: string = MARK_COLORS[0]): string {
  if (typeof value !== "string") return fallback;
  return COLOR_WORDS[value.trim().toLowerCase()] ?? normalizeHexColor(value) ?? fallback;
}

function customColorName(color: string, names?: ColorNames): string {
  return names?.[color.toLowerCase()]?.trim() ?? "";
}

/** A readable name for a color: the book's own name for it, else the palette name, else its value. */
export function colorName(color: string, names?: ColorNames): string {
  return customColorName(color, names) || (MARK_COLOR_NAMES[color.toLowerCase()] ?? color);
}

export function hasCustomColorName(color: string, names?: ColorNames): boolean {
  return !!customColorName(color, names);
}

/**
 * A color named "important" first, then other named colors (alphabetically),
 * then palette order, then any other colors.
 */
export function compareColors(a: string, b: string, names?: ColorNames): number {
  const customA = customColorName(a, names);
  const customB = customColorName(b, names);
  const priorityA = customA.toLowerCase() === PRIORITY_COLOR_NAME;
  const priorityB = customB.toLowerCase() === PRIORITY_COLOR_NAME;
  if (priorityA !== priorityB) return priorityA ? -1 : 1;
  if (customA || customB) {
    if (!customA) return 1;
    if (!customB) return -1;
    const byName = customA.localeCompare(customB, undefined, { sensitivity: "base" });
    if (byName) return byName;
  }
  const rank = (color: string) => {
    const index = (MARK_COLORS as readonly string[]).indexOf(color.toLowerCase());
    return index === -1 ? MARK_COLORS.length : index;
  };
  return rank(a) - rank(b) || a.toLowerCase().localeCompare(b.toLowerCase());
}

/** Sorts colors by a chosen order (lower-case values); colors missing from it follow in `compareColors` order. */
export function orderColors(colors: string[], names?: ColorNames, order: string[] = []): string[] {
  const rank = new Map(order.map((color, index) => [color.toLowerCase(), index]));
  return colors.slice().sort((a, b) => {
    const rankA = rank.get(a.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    const rankB = rank.get(b.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA < rankB ? -1 : 1;
    return compareColors(a, b, names);
  });
}

export function normalizeColorOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => toHighlightColor(item, item.trim().toLowerCase()))));
}

/** A book's added colors: valid, unique, not already built in, at most MAX_EXTRA_COLORS. */
export function normalizeExtraColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const builtIn = new Set<string>(MARK_COLORS);
  const result: string[] = [];
  for (const item of value) {
    const color = typeof item === "string" ? normalizeHexColor(item) : null;
    if (color && !builtIn.has(color) && !result.includes(color)) result.push(color);
  }
  return result.slice(0, MAX_EXTRA_COLORS);
}

export function normalizeColorNames(value: unknown): ColorNames {
  const names: ColorNames = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return names;
  for (const [color, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === "string" && name.trim()) names[toHighlightColor(color, color.toLowerCase())] = name.trim().slice(0, 80);
  }
  return names;
}

/** The palette offered for a book: the built-in colors, then its added ones. */
export function paletteColors(extras: string[]): string[] {
  return [...MARK_COLORS, ...extras.filter(color => !(MARK_COLORS as readonly string[]).includes(color))];
}

interface PaletteEntry {
  /** The color as stored before this edit, or null for a newly added one. */
  original: string | null;
  color: string;
  added: boolean;
}

export interface HighlightColorsOptions {
  /** What the colors belong to, e.g. the PDF's or book's name. */
  subject: string;
  /** The book's added colors. */
  extras: string[];
  /**
   * Every color to list, in order: normally the palette plus colors that
   * highlights still use after they were removed from it. Defaults to the palette.
   */
  colors?: string[];
  /** Colors that highlights in this book use (lower case). */
  used: Set<string>;
  names: ColorNames;
  /**
   * Saves the names and added colors. `recolor` maps an added color that was
   * changed to its new value, so highlights in it can follow.
   */
  onSave(names: ColorNames, extras: string[], recolor: Map<string, string>): Promise<void>;
}

/** The "Highlight colors" window: name colors for one book, and add, change or remove extra colors. */
export class HighlightColorsModal extends Modal {
  private readonly draft: ColorNames;
  private entries: PaletteEntry[];
  private listEl!: HTMLElement;
  private addEl!: HTMLElement;

  constructor(app: App, private readonly options: HighlightColorsOptions) {
    super(app);
    this.draft = { ...options.names };
    const added = new Set(options.extras);
    this.entries = (options.colors ?? paletteColors(options.extras)).map(color => ({ original: color, color, added: added.has(color.toLowerCase()) }));
    for (const color of options.extras) {
      if (!this.hasColor(color)) this.entries.push({ original: color, color, added: true });
    }
  }

  onOpen(): void {
    this.modalEl.addClass("hl-colors-modal");
    this.setTitle("Highlight colors");
    this.contentEl.createEl("p", {
      cls: "hl-colors-help",
      text: `Colors and names apply only to ${this.options.subject} and its note. Leave a name empty to use the default.`,
    });
    this.listEl = this.contentEl.createDiv();
    this.addEl = this.contentEl.createDiv({ cls: "hl-colors-add" });
    this.render();
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(button => button.setButtonText("Save").setCta().onClick(() => void this.save()));
  }

  private addedCount(): number {
    return this.entries.filter(entry => entry.added).length;
  }

  private hasColor(color: string): boolean {
    return this.entries.some(entry => entry.color.toLowerCase() === color.toLowerCase());
  }

  private render(): void {
    this.listEl.empty();
    for (const entry of this.entries) {
      const key = entry.color.toLowerCase();
      const setting = new Setting(this.listEl).setName(entry.added ? "Added color" : colorName(entry.color));
      const swatch = createSpan({ cls: "hl-colors-swatch" });
      swatch.style.setProperty("--hl-color", entry.color);
      setting.nameEl.prepend(swatch);
      if (entry.added) {
        const picker = createEl("input", { cls: "hl-colors-picker", attr: { type: "color", "aria-label": "Change this color" } });
        picker.value = entry.color;
        picker.addEventListener("change", () => {
          const next = normalizeHexColor(picker.value);
          if (!next || next === key || this.hasColor(next)) {
            picker.value = entry.color;
            return;
          }
          const name = this.draft[key];
          delete this.draft[key];
          if (name) this.draft[next] = name;
          entry.color = next;
          this.render();
        });
        setting.controlEl.append(picker);
      }
      setting.addText(text => text
        .setPlaceholder(entry.added ? "Name this color" : colorName(entry.color))
        .setValue(this.draft[key] ?? "")
        .onChange(value => {
          if (value.trim()) this.draft[key] = value.trim();
          else delete this.draft[key];
        }));
      if (entry.added) {
        const inUse = entry.original !== null && this.options.used.has(entry.original.toLowerCase());
        setting.addExtraButton(button => button
          .setIcon("trash-2")
          .setTooltip(inUse ? "Remove from the palette (existing highlights keep this color)" : "Remove this color")
          .onClick(() => {
            this.entries = this.entries.filter(item => item !== entry);
            delete this.draft[key];
            this.render();
          }));
      }
    }
    this.renderAdd();
  }

  private addColor(value: string): void {
    const color = normalizeHexColor(value);
    if (!color) {
      new Notice("Enter a color as a hex value, such as #ffa94d.");
      return;
    }
    if (this.hasColor(color)) {
      new Notice("That color is already in the palette.");
      return;
    }
    if (this.addedCount() >= MAX_EXTRA_COLORS) {
      new Notice(`You can add up to ${MAX_EXTRA_COLORS} colors.`);
      return;
    }
    this.entries.push({ original: null, color, added: true });
    this.render();
  }

  private renderAdd(): void {
    this.addEl.empty();
    if (this.addedCount() >= MAX_EXTRA_COLORS) return;
    this.addEl.createDiv({ cls: "setting-item-name", text: "Add a color" });
    const presets = this.addEl.createDiv({ cls: "hl-colors-presets" });
    for (const color of PRESET_EXTRA_COLORS) {
      if (this.hasColor(color)) continue;
      const chip = presets.createEl("button", { cls: "hl-colors-preset", attr: { type: "button", "aria-label": `Add ${color}`, title: color } });
      chip.style.setProperty("--hl-color", color);
      chip.addEventListener("click", () => this.addColor(color));
    }
    const custom = this.addEl.createDiv({ cls: "hl-colors-custom" });
    const picker = custom.createEl("input", { cls: "hl-colors-picker", attr: { type: "color", "aria-label": "Pick a color" } });
    picker.value = PRESET_EXTRA_COLORS[0];
    const hex = custom.createEl("input", { attr: { type: "text", placeholder: "Hex color", "aria-label": "Hex color" } });
    picker.addEventListener("input", () => { hex.value = picker.value; });
    hex.addEventListener("input", () => {
      const color = normalizeHexColor(hex.value);
      if (color) picker.value = color;
    });
    const add = custom.createEl("button", { text: "Add", attr: { type: "button" } });
    add.addEventListener("click", () => this.addColor(hex.value.trim() || picker.value));
  }

  private async save(): Promise<void> {
    const extras: string[] = [];
    const recolor = new Map<string, string>();
    const keep = new Set<string>();
    for (const entry of this.entries) {
      const color = entry.color.toLowerCase();
      keep.add(color);
      if (!entry.added) continue;
      extras.push(color);
      if (entry.original && entry.original.toLowerCase() !== color) recolor.set(entry.original.toLowerCase(), color);
    }
    // Names of colors that left the palette and no highlight uses are dropped.
    for (const key of Object.keys(this.draft)) {
      if (!keep.has(key) && !this.options.used.has(key)) delete this.draft[key];
    }
    try {
      await this.options.onSave(this.draft, extras, recolor);
      this.close();
    } catch (error) {
      console.error("Could not save the highlight colors", error);
      new Notice("Could not save the highlight colors.");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
