import type { AnnotationMutation, PdfAnnotation } from "./model";

/*
 * Merging what several devices wrote, by the time each edit was made.
 *
 * Obsidian Sync keeps only the most recently modified copy of a non-Markdown
 * file. So every device writes only its own files (`journal.<device>.jsonl`,
 * `palette.<device>.json`), and everything is merged when read: for each
 * highlight, color name or choice, the latest edit wins, whichever device made
 * it and whenever its file arrived. A stale copy from a device that was
 * offline for days can never undo newer edits it never saw. Deletions are kept
 * as tombstones (id → time) so an old copy can't bring a highlight back.
 *
 * Kept free of Obsidian imports so it can be tested on its own.
 */

/** A journal line. */
export type JournalEntry = AnnotationMutation;

/** Deterministic text for a value, to break ties the same way on every device. */
function stableText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

/** When `mutation` was made. */
export function mutationTime(mutation: AnnotationMutation): number {
  return mutation.op === "put" ? mutation.annotation.updatedAt : mutation.at;
}

/** Highlights and tombstones merged from any number of sources, in any order. */
export class AnnotationMerge {
  readonly annotations = new Map<string, PdfAnnotation>();
  readonly tombstones = new Map<string, number>();

  /** Applies one change if it is newer than what is known. True when something changed. */
  apply(mutation: AnnotationMutation): boolean {
    if (mutation.op === "put") {
      const incoming = mutation.annotation;
      const deletedAt = this.tombstones.get(incoming.id);
      // A deletion made at the same moment or later wins.
      if (deletedAt !== undefined && deletedAt >= incoming.updatedAt) return false;
      const current = this.annotations.get(incoming.id);
      if (current) {
        if (current.updatedAt > incoming.updatedAt) return false;
        if (current.updatedAt === incoming.updatedAt) {
          const a = stableText(current);
          const b = stableText(incoming);
          if (a >= b) return false;
        }
      }
      this.annotations.set(incoming.id, incoming);
      return true;
    }
    const known = this.tombstones.get(mutation.id);
    const tombstoneChanged = known === undefined || mutation.at > known;
    if (tombstoneChanged) this.tombstones.set(mutation.id, mutation.at);
    const current = this.annotations.get(mutation.id);
    // An edit made after the deletion (on a device that hadn't seen it) is kept.
    if (current && current.updatedAt <= mutation.at) {
      this.annotations.delete(mutation.id);
      return true;
    }
    return tombstoneChanged;
  }

  /** Every highlight, oldest edit first (the order the annotation index expects). */
  sorted(): PdfAnnotation[] {
    return Array.from(this.annotations.values()).sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
}

/** The compacted snapshot that only the background device writes. */
export interface SnapshotV2 {
  version: 2;
  annotations: PdfAnnotation[];
  tombstones: Record<string, number>;
}

/** The snapshot as text: the same merge always gives the same text, so unchanged data is never rewritten. */
export function serializeSnapshot(merge: AnnotationMerge): string {
  const tombstones = Object.fromEntries(Array.from(merge.tombstones.entries()).sort(([a], [b]) => a.localeCompare(b)));
  const lines = merge.sorted().map(annotation => JSON.stringify(annotation));
  return `{"version":2,"tombstones":${JSON.stringify(tombstones)},"annotations":[${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

/** Journal lines stay in their device's journal for at least this long, even once compacted. */
export const JOURNAL_KEEP_MS = 7 * 86_400_000;

/** Whether `snapshot` already holds `entry`'s change, or a later one. */
export function snapshotHolds(snapshot: AnnotationMerge, entry: JournalEntry): boolean {
  const time = mutationTime(entry);
  const id = entry.op === "put" ? entry.annotation.id : entry.id;
  const deletedAt = snapshot.tombstones.get(id);
  if (deletedAt !== undefined && deletedAt >= time) return true;
  if (entry.op === "remove") return false;
  const held = snapshot.annotations.get(id);
  return !!held && held.updatedAt >= time;
}

/**
 * Which of a device's own journal entries it may drop: those the background
 * device's snapshot already holds (checked entry by entry, not trusted from a
 * counter), and made over a week ago.
 */
export function trimmableEntries(entries: JournalEntry[], snapshot: AnnotationMerge, now: number, keepMs = JOURNAL_KEEP_MS): Set<JournalEntry> {
  const result = new Set<JournalEntry>();
  for (const entry of entries) {
    if (now - mutationTime(entry) > keepMs && snapshotHolds(snapshot, entry)) result.add(entry);
  }
  return result;
}

/** A value and when it was set. */
export interface Stamped<T> {
  value: T;
  at: number;
}

/** An added color: whether it is in the palette, when that was decided, and when it was first added (its place). */
export interface ExtraColorEntry {
  on: boolean;
  at: number;
  added: number;
}

/**
 * One device's palette edits for a PDF, or the merge of every device's.
 * A cleared color name is kept as an empty name, so the clearing syncs too.
 */
export interface PaletteFile {
  names: Record<string, Stamped<string>>;
  extras: Record<string, ExtraColorEntry>;
  order?: Stamped<string[]>;
  layout?: Stamped<string>;
}

export function emptyPalette(): PaletteFile {
  return { names: {}, extras: {} };
}

function newerStamp<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return stableText(a) >= stableText(b) ? a : b;
}

/** Reads a palette file written by any version, dropping anything malformed. */
export function readPaletteFile(value: unknown, normalizeColor: (color: string) => string | null): PaletteFile {
  const palette = emptyPalette();
  if (!value || typeof value !== "object" || Array.isArray(value)) return palette;
  const source = value as Record<string, unknown>;
  const finite = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  if (source.names && typeof source.names === "object") {
    for (const [key, entry] of Object.entries(source.names as Record<string, unknown>)) {
      const color = normalizeColor(key);
      const item = entry as Partial<Stamped<unknown>> | null;
      if (color && item && typeof item.value === "string" && finite(item.at)) palette.names[color] = { value: item.value.trim().slice(0, 80), at: item.at as number };
    }
  }
  if (source.extras && typeof source.extras === "object") {
    for (const [key, entry] of Object.entries(source.extras as Record<string, unknown>)) {
      const color = normalizeColor(key);
      const item = entry as Partial<ExtraColorEntry> | null;
      if (color && item && typeof item.on === "boolean" && finite(item.at)) palette.extras[color] = { on: item.on, at: item.at as number, added: finite(item.added) ? item.added as number : item.at as number };
    }
  }
  const order = source.order as Partial<Stamped<unknown>> | undefined;
  if (order && Array.isArray(order.value) && finite(order.at)) {
    palette.order = { value: order.value.filter((item): item is string => typeof item === "string"), at: order.at as number };
  }
  const layout = source.layout as Partial<Stamped<unknown>> | undefined;
  if (layout && typeof layout.value === "string" && finite(layout.at)) palette.layout = { value: layout.value, at: layout.at as number };
  return palette;
}

/** The latest edit of every color name, added color, order and layout across `files`. */
export function mergePalettes(files: PaletteFile[]): PaletteFile {
  const merged = emptyPalette();
  for (const file of files) {
    for (const [color, entry] of Object.entries(file.names)) merged.names[color] = newerStamp(merged.names[color], entry)!;
    for (const [color, entry] of Object.entries(file.extras)) merged.extras[color] = newerStamp(merged.extras[color], entry)!;
    merged.order = newerStamp(merged.order, file.order);
    merged.layout = newerStamp(merged.layout, file.layout);
  }
  return merged;
}

/** What the reader uses: names, added colors in the order they were added, heading order and layout. */
export interface PaletteView {
  names: Record<string, string>;
  extras: string[];
  order: string[];
  layout: string | null;
}

export function paletteView(merged: PaletteFile, maxExtras: number): PaletteView {
  const names: Record<string, string> = {};
  for (const [color, entry] of Object.entries(merged.names)) if (entry.value) names[color] = entry.value;
  const extras = Object.entries(merged.extras)
    .filter(([, entry]) => entry.on)
    .sort(([a, x], [b, y]) => x.added - y.added || a.localeCompare(b))
    .map(([color]) => color)
    .slice(0, maxExtras);
  return { names, extras, order: merged.order?.value ?? [], layout: merged.layout?.value ?? null };
}

/**
 * Records in `own` (this device's palette file) whatever `next` changes
 * compared with the merged palette, stamped `now`. Returns whether anything
 * was recorded; nothing is when `next` matches what is already merged.
 */
export function recordPaletteEdit(own: PaletteFile, merged: PaletteFile, maxExtras: number, next: Partial<PaletteView>, now: number): boolean {
  const current = paletteView(merged, maxExtras);
  let changed = false;
  if (next.names) {
    for (const color of new Set([...Object.keys(current.names), ...Object.keys(next.names)])) {
      const value = next.names[color] ?? "";
      if (value === (current.names[color] ?? "")) continue;
      own.names[color] = { value, at: now };
      changed = true;
    }
  }
  if (next.extras) {
    const wanted = next.extras;
    wanted.forEach((color, index) => {
      if (current.extras.includes(color)) return;
      own.extras[color] = { on: true, at: now, added: merged.extras[color]?.on ? merged.extras[color].added : now + index };
      changed = true;
    });
    for (const color of current.extras) {
      if (wanted.includes(color)) continue;
      own.extras[color] = { on: false, at: now, added: merged.extras[color]?.added ?? now };
      changed = true;
    }
  }
  if (next.order && stableText(next.order) !== stableText(current.order)) {
    own.order = { value: next.order.slice(), at: now };
    changed = true;
  }
  if (next.layout !== undefined && next.layout !== null && next.layout !== current.layout) {
    own.layout = { value: next.layout, at: now };
    changed = true;
  }
  return changed;
}

/** A palette file as text, with keys sorted so the same content is always the same text. */
export function serializePalette(palette: PaletteFile): string {
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ version: 1, names: sorted(palette.names), extras: sorted(palette.extras), order: palette.order, layout: palette.layout }, null, 2)}\n`;
}

/**
 * Settings saved in data.json, merged per key by when each was changed.
 * `times` holds, per key, when it was last changed on any device.
 */
export function mergeSettings<T extends Record<string, unknown>>(
  memory: T,
  memoryTimes: Record<string, number>,
  disk: T,
  diskTimes: Record<string, number>,
): { values: T; times: Record<string, number> } {
  const values = { ...memory };
  const times = { ...memoryTimes };
  for (const key of Object.keys(disk) as Array<keyof T & string>) {
    const mine = memoryTimes[key] ?? 0;
    const theirs = diskTimes[key] ?? 0;
    // Equal times with different values: with no time on either side, an older
    // version changed it, so take it; with a time, an older version wrote back a
    // stale copy without touching the time, so keep this device's.
    if (theirs > mine || (theirs === 0 && mine === 0 && stableText(disk[key]) !== stableText(memory[key]))) {
      values[key] = disk[key];
      times[key] = theirs;
    }
  }
  return { values, times };
}
