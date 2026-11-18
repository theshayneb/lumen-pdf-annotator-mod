import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import { isNoteLayout, NoteLayout } from "./note-layout";
import { AnnotationIndex, AnnotationMutation, ColorNames, MARK_COLORS, MAX_EXTRA_COLORS, MarkStyle, normalizeColorNames, normalizeColorOrder, normalizeExtraColors, PdfAnnotation } from "./model";
import { writeAnnotationExport } from "./annotation-export";
import { cachedFileHash, currentDeviceId, rememberFileHash, runsBackgroundTasks } from "./device";
import { AnnotationMerge, emptyPalette, JournalEntry, mergePalettes, PaletteFile, PaletteView, paletteView, readPaletteFile, recordPaletteEdit, serializePalette, serializeSnapshot, SnapshotV2, trimmableEntries } from "./sync-merge";

export const STORAGE_FOLDER = "Utilities/PDF Annotator";
// Used by 1.0.5–1.0.22. Its contents are moved into STORAGE_FOLDER on load.
const PREVIOUS_STORAGE_FOLDER = "Dashboard";
const ROOT = `${STORAGE_FOLDER}/bundles/sha256`;
/** Where each PDF's annotation folder lives, named by the PDF's SHA-256. */
export const BUNDLE_ROOT = ROOT;
const LEGACY_ROOT = ".pdf-annotator/bundles/sha256";
// Earlier storage locations, newest first: the previous folder (for anything
// the move could not handle), this fork's 1.0.0–1.0.4 folder, and the original
// Lumen plugin's folder. They are never written to; a PDF's annotations are
// copied across the first time it is opened here.
const PREVIOUS_ROOTS = [`${PREVIOUS_STORAGE_FOLDER}/bundles/sha256`, ".lumen-pdf-mod/bundles/sha256", ".lumen-pdf/bundles/sha256"];
// Previous roots that may still hold bundles nobody has reopened yet.
const UNMIGRATED_ROOTS = PREVIOUS_ROOTS.slice(0, 2);
/** Where 1.0.x kept each device's PDF hash cache, in the synced vault. Now kept on each device instead. */
export const FILE_INDEX_ROOT = `${STORAGE_FOLDER}/file-index`;
// Per-PDF colour names. They live in the PDF's bundle, so they follow the PDF
// (by content) and never apply to other PDFs.
const COLOR_NAMES_FILE = "color-names.json";
// The heading order last chosen for this PDF's sidecar note.
const COLOR_ORDER_FILE = "color-order.json";
const NOTE_LAYOUT_FILE = "note-layout.json";
// Highlight colors added to this PDF's palette beyond the built-in five.
const EXTRA_COLORS_FILE = "extra-colors.json";
const ANNOTATION_FILES = [
  "annotations.snapshot.json",
  "annotations.snapshot.previous.json",
  "annotations.md",
  "annotations.previous.md",
  "annotations.journal.jsonl",
];

export interface BundleManifest {
  version: number;
  sha256: string;
  workingPath: string;
  originalName: string;
  updatedAt: string;
}

export interface BundleInfo {
  hash: string;
  folder: string;
  backupPath: string;
  manifest: BundleManifest;
}

export interface AnnotationBundleInfo {
  hash: string;
  folder: string;
  manifest: BundleManifest;
}

export interface BackupVerification {
  bundle: BundleInfo;
  ok: boolean;
  reason?: string;
}

export interface LegacyAnnotationRecord {
  id?: string;
  type?: "highlight" | "tag";
  page?: number;
  color?: string;
  style?: string;
  text?: string;
  note?: string;
  noteContentCJK?: string;
  tags?: string[];
  rects?: Array<{ x1?: number; y1?: number; x2?: number; y2?: number }>;
  tagX?: number;
  tagY?: number;
  created?: string;
}

export interface DocumentBundle {
  hash: string;
  folder: string;
  repository: AnnotationRepository;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The PDF's content hash, remembered on this device so unchanged PDFs aren't hashed again. */
async function documentHash(file: TFile, bytes: ArrayBuffer): Promise<string> {
  const cached = cachedFileHash(file.path, file.stat.mtime, file.stat.size);
  if (cached) return cached;
  const hash = await sha256(bytes);
  rememberFileHash(file.path, file.stat.mtime, file.stat.size, hash);
  return hash;
}

/** Where 1.0.29–1.0.37 saved pictures of area annotations. Newer ones follow Obsidian's attachment setting. */
const AREA_IMAGE_FOLDER = "Attachments";
// 1.0.27–1.0.28 kept them in the plugin's own folder.
const PREVIOUS_AREA_IMAGE_FOLDER = `${STORAGE_FOLDER}/images`;

/**
 * The file name of an area annotation's picture. Pictures are found by this
 * name wherever they are in the vault, so they can be moved freely.
 */
export function areaImageName(id: string): string {
  return `pdf-area-${id}.png`;
}

function areaImagePath(id: string): string {
  return `${AREA_IMAGE_FOLDER}/${areaImageName(id)}`;
}

/**
 * Moves pictures saved by 1.0.27–1.0.28 into AREA_IMAGE_FOLDER. `rename` should
 * update links (Obsidian's file manager), so sidecars that embed them follow.
 * The old folder is removed once empty.
 */
export async function migrateAreaImages(vault: Vault, rename: (file: TFile, path: string) => Promise<void>): Promise<void> {
  const folder = vault.getAbstractFileByPath(PREVIOUS_AREA_IMAGE_FOLDER);
  if (!(folder instanceof TFolder)) return;
  for (const file of folder.children.slice()) {
    if (!(file instanceof TFile) || file.extension !== "png") continue;
    const target = areaImagePath(file.basename);
    if (vault.getAbstractFileByPath(target)) continue;
    await ensureFolder(vault, AREA_IMAGE_FOLDER);
    await rename(file, target);
  }
  await removeIfEmpty(vault, PREVIOUS_AREA_IMAGE_FOLDER);
}

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  let current = "";
  for (const part of normalizePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.adapter.exists(current))) await vault.adapter.mkdir(current);
  }
}

function yieldToHost(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function schedulePdfBackup(vault: Vault, sourcePath: string, backupPath: string): void {
  // A full PDF copy is useful for recovery, but it must never sit on the
  // document-open critical path. DataAdapter.copy performs the filesystem work
  // without constructing another large ArrayBuffer in the renderer process.
  window.setTimeout(() => {
    void (async () => {
      if (await vault.adapter.exists(backupPath)) return;
      const partialPath = `${backupPath}.partial`;
      if (await vault.adapter.exists(partialPath)) await vault.adapter.remove(partialPath);
      await vault.adapter.copy(sourcePath, partialPath);
      if (await vault.adapter.exists(backupPath)) {
        await vault.adapter.remove(partialPath);
        return;
      }
      await vault.adapter.rename(partialPath, backupPath);
    })().catch(error => console.error("Lumen could not create a background PDF backup", error));
  }, 1_500);
}

async function readSnapshot(markdown: string): Promise<PdfAnnotation[]> {
  const match = markdown.match(/```json lumen-pdf-data\n([\s\S]*?)\n```/);
  if (!match) return [];
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!Array.isArray(value)) return [];
    const annotations: PdfAnnotation[] = [];
    for (let index = 0; index < value.length; index++) {
      const annotation = normalizeAnnotation(value[index]);
      if (annotation) annotations.push(annotation);
      if (index > 0 && index % 1_000 === 0) await yieldToHost();
    }
    return annotations;
  } catch {
    return [];
  }
}

async function readJsonSnapshot(json: string): Promise<PdfAnnotation[] | null> {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const annotations: PdfAnnotation[] = [];
    for (let index = 0; index < value.length; index++) {
      const annotation = normalizeAnnotation(value[index]);
      if (annotation) annotations.push(annotation);
      if (index > 0 && index % 1_000 === 0) await yieldToHost();
    }
    return annotations;
  } catch {
    return null;
  }
}

function isMarkStyle(value: unknown): value is MarkStyle {
  return value === "highlight" || value === "underline" || value === "dashed" || value === "dotted"
    || value === "strike" || value === "box" || value === "comment";
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAnnotation(value: unknown): PdfAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PdfAnnotation>;
  if (typeof item.id !== "string" || !item.id || !Array.isArray(item.rects)) return null;
  const page = Math.max(1, Math.trunc(finite(item.page, 1)));
  const rects = item.rects.flatMap(rect => {
    if (!rect || typeof rect !== "object") return [];
    const x = finite(rect.x, Number.NaN);
    const y = finite(rect.y, Number.NaN);
    const width = finite(rect.width, Number.NaN);
    const height = finite(rect.height, Number.NaN);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const left = Math.max(0, Math.min(1, x));
    const top = Math.max(0, Math.min(1, y));
    const right = Math.max(0, Math.min(1, x + width));
    const bottom = Math.max(0, Math.min(1, y + height));
    if (right <= left || bottom <= top) return [];
    return [{
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }];
  });
  if (!rects.length) return null;
  // Text marks made across a page break before 1.0.18 could include whole-page
  // boxes (the page's canvas and mark layers). Drop those when the mark also
  // has real text boxes, so older highlights render correctly.
  if (item.kind !== "page-note" && item.kind !== "area" && rects.length > 1) {
    const textRects = rects.filter(rect => !(rect.width >= 0.95 && rect.height >= 0.9));
    if (textRects.length) rects.splice(0, rects.length, ...textRects);
  }
  // No clock fallback: the same record must read the same on every device and every load.
  const createdAt = finite(item.createdAt, 0);
  const style = isMarkStyle(item.style) ? item.style : "highlight";
  return {
    id: item.id,
    groupId: typeof item.groupId === "string" && item.groupId.trim() ? item.groupId : undefined,
    kind: item.kind === "page-note" || item.kind === "area" ? item.kind : "text",
    page,
    rects,
    quote: typeof item.quote === "string" ? item.quote : item.kind === "page-note" ? "Page note" : "",
    note: typeof item.note === "string" ? item.note : "",
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
    color: typeof item.color === "string" && item.color.trim() ? item.color : MARK_COLORS[0],
    style,
    createdAt,
    updatedAt: finite(item.updatedAt, createdAt),
  };
}

function normalizeMutation(value: unknown): AnnotationMutation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { op?: unknown; annotation?: unknown; id?: unknown; at?: unknown };
  if (item.op === "put") {
    const annotation = normalizeAnnotation(item.annotation);
    return annotation ? { op: "put", annotation } : null;
  }
  if (item.op === "remove" && typeof item.id === "string") {
    // Every version writes a time; an undated removal never outranks a dated edit.
    return { op: "remove", id: item.id, at: finite(item.at, 0) };
  }
  return null;
}

/** The compacted snapshot, written only by the device that runs background tasks. */
const SNAPSHOT_V2_FILE = "annotations.snapshot.v2.json";
/** Each device's own journal and palette edits; only that device writes them. */
const DEVICE_JOURNAL = /^journal\.([a-z0-9-]+)\.jsonl$/;
const DEVICE_PALETTE = /^palette\.([a-z0-9-]+)\.json$/;
/** A device rewrites its journal to drop compacted lines only once this many can go. */
const TRIM_THRESHOLD = 200;

/** Whether a file in a PDF's annotation folder holds annotations or palette edits (any version's). */
export function isAnnotationDataFile(name: string): boolean {
  return DEVICE_JOURNAL.test(name) || DEVICE_PALETTE.test(name) || name === SNAPSHOT_V2_FILE
    || ANNOTATION_FILES.includes(name) || [COLOR_NAMES_FILE, COLOR_ORDER_FILE, NOTE_LAYOUT_FILE, EXTRA_COLORS_FILE].includes(name);
}

function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const mutation = normalizeMutation(JSON.parse(line));
      if (mutation) entries.push(mutation);
    } catch { /* a torn or damaged line is skipped; the others still load */ }
  }
  return entries;
}

function readSnapshotV2(text: string, into: AnnotationMerge): boolean {
  try {
    const value = JSON.parse(text) as Partial<SnapshotV2> | null;
    if (!value || value.version !== 2 || !Array.isArray(value.annotations)) return false;
    for (const item of value.annotations) {
      const annotation = normalizeAnnotation(item);
      if (annotation) into.apply({ op: "put", annotation });
    }
    for (const [id, at] of Object.entries(value.tombstones ?? {})) {
      if (typeof at === "number" && Number.isFinite(at)) into.apply({ op: "remove", id, at });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A PDF's annotations and palette, shared by every device through the vault.
 *
 * Each device appends its changes only to its own `journal.<device>.jsonl`
 * and records palette edits only in its own `palette.<device>.json`, so Obsidian
 * Sync's "newest copy wins" for these files can never drop another device's
 * work. Reading merges every device's files, the background device's compacted
 * snapshot and the files older versions wrote, by when each edit was made.
 */
export class AnnotationRepository {
  private readonly folder: string;
  private readonly legacySnapshotPath: string;
  private readonly legacyPreviousPath: string;
  private readonly compactSnapshotPath: string;
  private readonly compactPreviousPath: string;
  private readonly legacyJournalPath: string;
  private readonly snapshotPath: string;
  private readonly journalPath: string;
  private readonly palettePath: string;
  private readonly colorNamesPath: string;
  private readonly colorOrderPath: string;
  private readonly noteLayoutPath: string;
  private readonly extraColorsPath: string;
  private readonly queued = new Map<string, AnnotationMutation>();
  private flushTimer: number | null = null;
  private flushing: Promise<void> | null = null;
  /** Everything known, with deletions, as of the last load plus changes made here since. */
  private merged = new AnnotationMerge();
  /** Called after every queued mutation, e.g. to keep a sidecar note in sync. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly vault: Vault,
    folder: string,
    private readonly hash: string,
    private readonly pdfPath: string,
    /** Called before the first write, to make the folder and manifest. */
    private readonly prepareForWrite: () => Promise<void> = () => ensureFolder(vault, folder),
  ) {
    this.folder = folder;
    this.legacySnapshotPath = `${folder}/annotations.md`;
    this.legacyPreviousPath = `${folder}/annotations.previous.md`;
    this.compactSnapshotPath = `${folder}/annotations.snapshot.json`;
    this.compactPreviousPath = `${folder}/annotations.snapshot.previous.json`;
    this.legacyJournalPath = `${folder}/annotations.journal.jsonl`;
    this.snapshotPath = `${folder}/${SNAPSHOT_V2_FILE}`;
    const device = currentDeviceId();
    this.journalPath = `${folder}/journal.${device}.jsonl`;
    this.palettePath = `${folder}/palette.${device}.json`;
    this.colorNamesPath = `${folder}/${COLOR_NAMES_FILE}`;
    this.colorOrderPath = `${folder}/${COLOR_ORDER_FILE}`;
    this.noteLayoutPath = `${folder}/${NOTE_LAYOUT_FILE}`;
    this.extraColorsPath = `${folder}/${EXTRA_COLORS_FILE}`;
  }

  private async readIfExists(path: string): Promise<string | null> {
    return await this.vault.adapter.exists(path) ? this.vault.adapter.read(path) : null;
  }

  /** Names of the files in this PDF's folder. */
  private async folderFiles(): Promise<string[]> {
    if (!(await this.vault.adapter.exists(this.folder))) return [];
    return (await this.vault.adapter.list(this.folder)).files.map(path => path.split("/").at(-1) ?? "");
  }

  /** Merges everything on disk: older versions' files, the compacted snapshot, and every device's journal. */
  private async readMerged(): Promise<AnnotationMerge> {
    const merge = new AnnotationMerge();
    const apply = async (annotations: PdfAnnotation[]) => {
      for (let item = 0; item < annotations.length; item++) {
        merge.apply({ op: "put", annotation: annotations[item] });
        if (item > 0 && item % 1_000 === 0) await yieldToHost();
      }
    };
    // Snapshots written by 1.0.x, newest format first. They hold no deletion
    // times, so anything deleted since is removed again by the journals' records.
    let legacy: PdfAnnotation[] | null = null;
    for (const path of [this.compactSnapshotPath, this.compactPreviousPath]) {
      const text = await this.readIfExists(path);
      if (text !== null) legacy = await readJsonSnapshot(text);
      if (legacy) break;
    }
    if (!legacy) {
      for (const path of [this.legacySnapshotPath, this.legacyPreviousPath]) {
        const text = await this.readIfExists(path);
        if (text !== null) {
          legacy = await readSnapshot(text);
          break;
        }
      }
    }
    if (legacy) await apply(legacy);
    const snapshot = await this.readIfExists(this.snapshotPath);
    if (snapshot !== null) readSnapshotV2(snapshot, merge);
    const journals = [this.legacyJournalPath, ...(await this.folderFiles()).filter(name => DEVICE_JOURNAL.test(name)).map(name => `${this.folder}/${name}`)];
    for (const path of journals) {
      const text = await this.readIfExists(path);
      if (text === null) continue;
      const entries = parseJournal(text);
      for (let line = 0; line < entries.length; line++) {
        merge.apply(entries[line]);
        if (line > 0 && line % 1_000 === 0) await yieldToHost();
      }
    }
    return merge;
  }

  async load(): Promise<AnnotationIndex> {
    this.merged = await this.readMerged();
    // Changes made here that are not on disk yet stay.
    for (const mutation of this.queued.values()) this.merged.apply(mutation);
    const index = new AnnotationIndex();
    const annotations = this.merged.sorted();
    for (let item = 0; item < annotations.length; item++) {
      index.put(annotations[item]);
      if (item > 0 && item % 1_000 === 0) await yieldToHost();
    }
    return index;
  }

  queue(mutation: AnnotationMutation): void {
    const key = mutation.op === "put" ? mutation.annotation.id : mutation.id;
    this.queued.set(key, mutation);
    this.merged.apply(mutation);
    this.onChange?.();
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      void this.flushJournal().catch(error => console.error("Lumen could not flush its annotation journal", error));
    }, 220);
  }

  /** Changes made here that are not on disk yet (a reload from disk would lose them). */
  get hasPendingWrites(): boolean {
    return this.queued.size > 0 || this.flushing !== null || this.flushTimer !== null;
  }

  async flushJournal(): Promise<void> {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushing) {
      await this.flushing;
      if (this.queued.size) await this.flushJournal();
      return;
    }
    if (!this.queued.size) return;
    const operation = this.writeQueuedBatches();
    this.flushing = operation;
    try {
      await operation;
    } finally {
      if (this.flushing === operation) this.flushing = null;
    }
  }

  /**
   * Appends queued changes to this device's journal. Now and then, while
   * writing anyway, lines the compacted snapshot already holds (and that are
   * over a week old) are dropped, so the journal doesn't grow forever.
   */
  private async writeQueuedBatches(): Promise<void> {
    await this.prepareForWrite();
    const batch = Array.from(this.queued.entries());
    const payload = batch.map(([, value]) => JSON.stringify(value)).join("\n") + "\n";
    const existing = await this.readIfExists(this.journalPath);
    let rewritten = false;
    if (existing) {
      const entries = parseJournal(existing);
      if (entries.length >= TRIM_THRESHOLD) {
        const snapshot = new AnnotationMerge();
        const snapshotText = await this.readIfExists(this.snapshotPath);
        if (snapshotText !== null && readSnapshotV2(snapshotText, snapshot)) {
          const drop = trimmableEntries(entries, snapshot, Date.now());
          if (drop.size >= TRIM_THRESHOLD) {
            const kept = entries.filter(entry => !drop.has(entry)).map(entry => JSON.stringify(entry));
            await this.vault.adapter.write(this.journalPath, (kept.length ? `${kept.join("\n")}\n` : "") + payload);
            rewritten = true;
          }
        }
      }
    }
    if (!rewritten) {
      if (existing !== null) await this.vault.adapter.append(this.journalPath, payload);
      else await this.vault.adapter.write(this.journalPath, payload);
    }
    for (const [key, mutation] of batch) {
      if (this.queued.get(key) === mutation) this.queued.delete(key);
    }
  }

  /**
   * Saves this device's changes. On the device that runs background tasks,
   * also merges every device's changes into the compacted snapshot.
   */
  async checkpoint(_index?: AnnotationIndex): Promise<void> {
    await this.flushJournal();
    if (runsBackgroundTasks()) await this.compact();
  }

  /**
   * Re-reads every device's changes from disk and writes the merged result as
   * the compacted snapshot, only when it differs from what is there. For the
   * background device only: other devices never write the snapshot.
   */
  async compact(): Promise<boolean> {
    await this.flushJournal();
    const merge = await this.readMerged();
    const text = serializeSnapshot(merge);
    if (await this.readIfExists(this.snapshotPath) === text) return false;
    if (!merge.annotations.size && !merge.tombstones.size && !(await this.vault.adapter.exists(this.snapshotPath))) return false;
    await this.prepareForWrite();
    await this.vault.adapter.write(this.snapshotPath, text);
    return true;
  }

  /** Every device's palette edits merged, over what 1.0.x saved (which counts as oldest). */
  private async mergedPalette(): Promise<PaletteFile> {
    const legacy = emptyPalette();
    const json = async (path: string): Promise<unknown> => {
      const text = await this.readIfExists(path);
      if (text === null) return undefined;
      try { return JSON.parse(text) as unknown; } catch { return undefined; }
    };
    for (const [color, name] of Object.entries(normalizeColorNames(await json(this.colorNamesPath)))) legacy.names[color] = { value: name, at: 0 };
    normalizeExtraColors(await json(this.extraColorsPath)).forEach((color, index) => { legacy.extras[color] = { on: true, at: 0, added: index }; });
    const order = normalizeColorOrder(await json(this.colorOrderPath));
    if (order.length) legacy.order = { value: order, at: 0 };
    const layout = (await json(this.noteLayoutPath) as { layout?: unknown } | undefined)?.layout;
    if (isNoteLayout(layout)) legacy.layout = { value: layout, at: 0 };
    const files: PaletteFile[] = [legacy];
    for (const name of (await this.folderFiles()).filter(file => DEVICE_PALETTE.test(file))) {
      files.push(readPaletteFile(await json(`${this.folder}/${name}`), color => normalizeColorOrder([color])[0] ?? null));
    }
    return mergePalettes(files);
  }

  /** The PDF's color names, added colors, heading order and note layout, merged across devices. */
  async loadPalette(): Promise<{ names: ColorNames; extras: string[]; order: string[]; layout: NoteLayout | null }> {
    const view = paletteView(await this.mergedPalette(), MAX_EXTRA_COLORS);
    return { names: view.names, extras: view.extras, order: view.order, layout: isNoteLayout(view.layout) ? view.layout : null };
  }

  /** Records a palette change in this device's own palette file (read, merge, then write; nothing when unchanged). */
  private async editPalette(next: Partial<PaletteView>): Promise<void> {
    const merged = await this.mergedPalette();
    const ownText = await this.readIfExists(this.palettePath);
    let own = emptyPalette();
    if (ownText !== null) {
      try { own = readPaletteFile(JSON.parse(ownText), color => normalizeColorOrder([color])[0] ?? null); } catch { /* rewritten below */ }
    }
    if (!recordPaletteEdit(own, merged, MAX_EXTRA_COLORS, next, Date.now())) return;
    const text = serializePalette(own);
    if (text === ownText) return;
    await this.prepareForWrite();
    await this.vault.adapter.write(this.palettePath, text);
  }

  async loadColorNames(): Promise<ColorNames> {
    return (await this.loadPalette()).names;
  }

  async saveColorNames(names: ColorNames): Promise<void> {
    await this.editPalette({ names: normalizeColorNames(names) });
  }

  async loadColorOrder(): Promise<string[]> {
    return (await this.loadPalette()).order;
  }

  async saveColorOrder(order: string[]): Promise<void> {
    await this.editPalette({ order: normalizeColorOrder(order) });
  }

  /** The note layout chosen for this PDF, or null before one has been chosen. */
  async loadNoteLayout(): Promise<NoteLayout | null> {
    return (await this.loadPalette()).layout;
  }

  async saveNoteLayout(layout: NoteLayout): Promise<void> {
    await this.editPalette({ layout });
  }

  async loadExtraColors(): Promise<string[]> {
    return (await this.loadPalette()).extras;
  }

  async saveExtraColors(colors: string[]): Promise<void> {
    await this.editPalette({ extras: normalizeExtraColors(colors) });
  }

  async exportReadable(index: AnnotationIndex, originalName: string): Promise<string> {
    await this.flushJournal();
    const folder = `${STORAGE_FOLDER}/exports`;
    await ensureFolder(this.vault, folder);
    const stem = originalName.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 90) || "PDF";
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${folder}/${stem}-${this.hash.slice(0, 12)}-${time}`;
    let path = `${base}.annotations.md`;
    for (let copy = 2; await this.vault.adapter.exists(path); copy++) path = `${base}-${copy}.annotations.md`;
    await writeAnnotationExport(this.vault, path, index, this.pdfPath);
    return path;
  }
}

export async function openBundle(
  vault: Vault,
  file: TFile,
  bytes: ArrayBuffer,
  automaticPdfBackup = false,
): Promise<DocumentBundle> {
  const hash = await documentHash(file, bytes);
  const folder = normalizePath(`${ROOT}/${hash}`);
  await importPreviousAnnotations(vault, hash, folder);
  // Opening and reading a PDF writes nothing: its folder and manifest are made
  // when there is first something to save.
  let prepared: Promise<void> | null = null;
  const prepare = () => prepared ??= writeManifest(vault, folder, hash, file);
  const backupPath = `${folder}/document.pdf`;
  // Recovery copies are background work, done only by the device that runs it.
  if (automaticPdfBackup && runsBackgroundTasks() && !(await vault.adapter.exists(backupPath))) {
    await prepare();
    schedulePdfBackup(vault, file.path, backupPath);
  }
  const repository = new AnnotationRepository(vault, folder, hash, file.path, prepare);
  return { hash, folder, repository };
}

/** Makes the PDF's folder and records its path and name, unless that is already recorded. */
async function writeManifest(vault: Vault, folder: string, hash: string, file: TFile): Promise<void> {
  await ensureFolder(vault, folder);
  const manifestPath = `${folder}/manifest.json`;
  if (await vault.adapter.exists(manifestPath)) {
    try {
      const previous = coerceManifest(JSON.parse(await vault.adapter.read(manifestPath)), hash);
      if (previous?.sha256 === hash && previous.workingPath === file.path && previous.originalName === file.name) return;
    } catch { /* replace malformed manifests */ }
  }
  const manifest: BundleManifest = {
    version: 1,
    sha256: hash,
    workingPath: file.path,
    originalName: file.name,
    updatedAt: new Date().toISOString(),
  };
  await vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
}

async function hasAnnotationFiles(vault: Vault, folder: string): Promise<boolean> {
  if (!(await vault.adapter.exists(folder))) return false;
  return (await vault.adapter.list(folder)).files.some(path => {
    const name = path.split("/").at(-1) ?? "";
    return ANNOTATION_FILES.includes(name) || name === SNAPSHOT_V2_FILE || DEVICE_JOURNAL.test(name);
  });
}

/** One-way, one-time copy from the newest previous storage location that has this PDF. */
async function importPreviousAnnotations(vault: Vault, hash: string, folder: string): Promise<void> {
  if (await hasAnnotationFiles(vault, folder)) return;
  for (const root of PREVIOUS_ROOTS) {
    const source = `${root}/${hash}`;
    if (!(await hasAnnotationFiles(vault, source))) continue;
    try {
      await ensureFolder(vault, folder);
      for (const name of [...ANNOTATION_FILES, COLOR_NAMES_FILE, COLOR_ORDER_FILE, EXTRA_COLORS_FILE, NOTE_LAYOUT_FILE]) {
        if (await vault.adapter.exists(`${source}/${name}`)) await vault.adapter.copy(`${source}/${name}`, `${folder}/${name}`);
      }
    } catch (error) {
      console.error(`Lumen could not import annotations from ${root}`, error);
    }
    return;
  }
}

/** A PDF folder's manifest, or null when it is missing or damaged. */
export async function readBundleManifest(vault: Vault, folder: string, hash: string): Promise<BundleManifest | null> {
  const path = `${folder}/manifest.json`;
  if (!(await vault.adapter.exists(path))) return null;
  try {
    return coerceManifest(JSON.parse(await vault.adapter.read(path)), hash);
  } catch {
    return null;
  }
}

function coerceManifest(value: unknown, hash: string): BundleManifest | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<BundleManifest>;
  if (typeof item.originalName !== "string") return null;
  return {
    version: typeof item.version === "number" ? item.version : 1,
    sha256: typeof item.sha256 === "string" ? item.sha256 : hash,
    workingPath: typeof item.workingPath === "string" ? item.workingPath : item.originalName,
    originalName: item.originalName,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
  };
}

export async function listBundles(vault: Vault): Promise<BundleInfo[]> {
  const bundles: BundleInfo[] = [];
  const seen = new Set<string>();
  // Backups made before the storage folder moved stay restorable where they are.
  for (const root of [ROOT, ...UNMIGRATED_ROOTS]) {
    if (!(await vault.adapter.exists(root))) continue;
    for (const folder of (await vault.adapter.list(root)).folders) {
      const hash = folder.split("/").pop() ?? "";
      if (seen.has(hash)) continue;
      const manifestPath = `${folder}/manifest.json`;
      const backupPath = `${folder}/document.pdf`;
      if (!hash || !(await vault.adapter.exists(manifestPath)) || !(await vault.adapter.exists(backupPath))) continue;
      try {
        const manifest = coerceManifest(JSON.parse(await vault.adapter.read(manifestPath)), hash);
        if (manifest) {
          bundles.push({ hash, folder, backupPath, manifest });
          seen.add(hash);
        }
      } catch { /* a malformed bundle is reported by verification only when discoverable */ }
    }
  }
  return bundles.sort((a, b) => b.manifest.updatedAt.localeCompare(a.manifest.updatedAt));
}

/** Discover annotation storage without reading or hashing the source PDFs. */
export async function listAnnotationBundles(vault: Vault): Promise<AnnotationBundleInfo[]> {
  const bundles: AnnotationBundleInfo[] = [];
  const seen = new Set<string>();
  // Not-yet-reopened PDFs from the previous folder stay exportable.
  for (const root of [ROOT, ...UNMIGRATED_ROOTS, LEGACY_ROOT]) {
    if (!(await vault.adapter.exists(root))) continue;
    const folders = (await vault.adapter.list(root)).folders;
    for (let offset = 0; offset < folders.length; offset += 1) {
      const folder = folders[offset];
      const hash = folder.split("/").at(-1) ?? "";
      if (!/^[a-f0-9]{64}$/.test(hash) || seen.has(hash)) continue;
      const manifestPath = `${folder}/manifest.json`;
      if (!(await vault.adapter.exists(manifestPath))) continue;
      if (!(await hasAnnotationFiles(vault, folder))) continue;
      try {
        const manifest = coerceManifest(JSON.parse(await vault.adapter.read(manifestPath)), hash);
        if (manifest) {
          bundles.push({ hash, folder, manifest });
          seen.add(hash);
        }
      } catch { /* skip damaged manifests without blocking healthy PDFs */ }
      if (offset > 0 && offset % 100 === 0) await yieldToHost();
    }
  }
  return bundles.sort((a, b) => a.manifest.workingPath.localeCompare(b.manifest.workingPath));
}

export async function exportAnnotationBundle(vault: Vault, bundle: AnnotationBundleInfo): Promise<{ path: string; count: number }> {
  const repository = new AnnotationRepository(vault, bundle.folder, bundle.hash, bundle.manifest.workingPath);
  const index = await repository.load();
  return { path: await repository.exportReadable(index, bundle.manifest.originalName), count: index.logicalSize };
}

export async function verifyBundle(vault: Vault, bundle: BundleInfo): Promise<BackupVerification> {
  try {
    const bytes = await vault.adapter.readBinary(bundle.backupPath);
    const actual = await sha256(bytes);
    if (actual !== bundle.hash || actual !== bundle.manifest.sha256) {
      return { bundle, ok: false, reason: `checksum mismatch (${actual})` };
    }
    return { bundle, ok: true };
  } catch (error) {
    return { bundle, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "Recovered PDF.pdf";
}

async function availablePath(vault: Vault, preferred: string): Promise<string> {
  const normalized = normalizePath(preferred);
  if (!(await vault.adapter.exists(normalized))) return normalized;
  const dot = normalized.toLowerCase().endsWith(".pdf") ? normalized.length - 4 : normalized.length;
  const stem = normalized.slice(0, dot);
  const extension = normalized.slice(dot);
  for (let index = 2; ; index++) {
    const candidate = `${stem} ${index}${extension}`;
    if (!(await vault.adapter.exists(candidate))) return candidate;
  }
}

export async function restoreBundle(vault: Vault, bundle: BundleInfo): Promise<TFile> {
  const verification = await verifyBundle(vault, bundle);
  if (!verification.ok) throw new Error(verification.reason ?? "backup verification failed");
  const folder = `${STORAGE_FOLDER}/recovered`;
  await ensureFolder(vault, folder);
  const path = await availablePath(vault, `${folder}/${safeFileName(bundle.manifest.originalName)}`);
  return vault.createBinary(path, await vault.adapter.readBinary(bundle.backupPath));
}

function lastJsonFence(markdown: string): unknown {
  const expression = /```json(?:\s+[^\n]*)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let value: unknown = null;
  while ((match = expression.exec(markdown)) !== null) {
    try { value = JSON.parse(match[1]); } catch { /* keep the last valid fenced value */ }
  }
  return value;
}

export async function loadLegacyAnnotations(vault: Vault, hash: string, pdfPath: string): Promise<LegacyAnnotationRecord[]> {
  const stem = normalizePath(pdfPath).replace(/\.pdf$/i, "");
  const candidates = [
    `${LEGACY_ROOT}/${hash}/annotations.md`,
    `PDF annotations/${stem}.annotations.md`,
    `${stem}.annotations.md`,
  ];
  const result: LegacyAnnotationRecord[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (!(await vault.adapter.exists(path))) continue;
    try {
      const parsed = lastJsonFence(await vault.adapter.read(path));
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { highlights?: unknown[] }).highlights)
          ? (parsed as { highlights: unknown[] }).highlights
          : [];
      for (const value of records) {
        if (!value || typeof value !== "object") continue;
        const record = value as LegacyAnnotationRecord;
        const key = record.id ?? JSON.stringify([record.page, record.text, record.tagX, record.tagY]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(record);
      }
    } catch { /* an invalid legacy source must not prevent the PDF from opening */ }
  }
  return result;
}

/** Move `from` to `to` unless `to` already exists; returns whether it moved. */
async function moveIfFree(vault: Vault, from: string, to: string): Promise<boolean> {
  if (!(await vault.adapter.exists(from)) || await vault.adapter.exists(to)) return false;
  await ensureFolder(vault, to.split("/").slice(0, -1).join("/"));
  await vault.adapter.rename(from, to);
  return true;
}

/** Remove `path` and its now-empty subfolders; anything that still holds files stays. */
async function removeIfEmpty(vault: Vault, path: string): Promise<void> {
  if (!(await vault.adapter.exists(path))) return;
  const listing = await vault.adapter.list(path);
  for (const folder of listing.folders) await removeIfEmpty(vault, folder);
  const after = await vault.adapter.list(path);
  if (!after.files.length && !after.folders.length) await vault.adapter.rmdir(path, false);
}

/**
 * One-time move of everything in the previous storage folder ("Dashboard/")
 * into STORAGE_FOLDER. Items already present at the destination are left in
 * place (and remain readable as a previous root); the old folder is removed
 * only if nothing is left in it.
 */
export async function migrateStorageFolder(vault: Vault): Promise<void> {
  const old = PREVIOUS_STORAGE_FOLDER;
  if (!(await vault.adapter.exists(old))) return;
  for (const name of ["bundles", "file-index", "exports", "recovered"]) {
    const from = `${old}/${name}`;
    if (!(await vault.adapter.exists(from))) continue;
    try {
      if (await moveIfFree(vault, from, `${STORAGE_FOLDER}/${name}`)) continue;
      // The destination exists already: move entries one at a time.
      const children = name === "bundles" ? `${from}/sha256` : from;
      const target = name === "bundles" ? `${STORAGE_FOLDER}/bundles/sha256` : `${STORAGE_FOLDER}/${name}`;
      if (!(await vault.adapter.exists(children))) continue;
      const listing = await vault.adapter.list(children);
      for (const entry of [...listing.folders, ...listing.files]) {
        await moveIfFree(vault, entry, `${target}/${entry.split("/").at(-1)}`);
      }
    } catch (error) {
      console.error(`PDF Annotator could not move ${from} to ${STORAGE_FOLDER}`, error);
    }
  }
  try {
    for (const name of ["bundles", "file-index", "exports", "recovered"]) await removeIfEmpty(vault, `${old}/${name}`);
    // Only the old folder itself, never other (user) folders inside it.
    const rest = await vault.adapter.list(old);
    if (!rest.files.length && !rest.folders.length) await vault.adapter.rmdir(old, false);
  } catch (error) {
    console.error(`PDF Annotator could not tidy up ${old}`, error);
  }
}
