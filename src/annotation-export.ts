import { normalizePath, TFile } from "obsidian";
import type { Vault } from "obsidian";
import { annotationUri } from "./links";
import { colorName, hasCustomColorName, orderColors } from "./model";
import type { ColorNames } from "./model";
import type { AnnotationIndex, PdfAnnotation } from "./model";
import { areaImagePath } from "./storage";

/** An embed of an area annotation's saved picture. */
function areaEmbed(annotation: PdfAnnotation): string {
  return `![[${areaImagePath(annotation.groupId || annotation.id)}]]`;
}

export type SidecarGrouping = "page" | "color";

interface ExportEntry {
  anchor: PdfAnnotation;
  members: PdfAnnotation[];
  pages: number[];
}

function escapeInline(value: string): string {
  return value.replace(/[\\`*_{}<>|]/g, "\\$&").replaceAll("[", "\\[").replaceAll("]", "\\]").replace(/[\r\n]+/g, " ");
}

function quoteLines(value: string): string[] {
  return value.trim().split(/\r?\n/).map(line => `> ${line}`);
}

function pageLabel(pages: number[]): string {
  return pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages.join(", ")}`;
}

function styleLabel(annotation: PdfAnnotation): string {
  if (annotation.kind === "page-note") return "Page note";
  if (annotation.kind === "area") return "Area";
  return annotation.style === "comment" ? "Comment" : annotation.style.charAt(0).toUpperCase() + annotation.style.slice(1);
}

async function exportEntries(index: AnnotationIndex): Promise<ExportEntry[]> {
  const entries: ExportEntry[] = [];
  const logical = index.logicalAll();
  for (let position = 0; position < logical.length; position++) {
    const anchor = logical[position];
    const members = index.inGroup(anchor.id).sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0) || a.createdAt - b.createdAt);
    const pages = Array.from(new Set(members.map(item => item.page))).sort((a, b) => a - b);
    entries.push({ anchor, members, pages });
    if (position > 0 && position % 1_000 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  entries.sort((a, b) => a.pages[0] - b.pages[0] || a.anchor.createdAt - b.anchor.createdAt || a.anchor.id.localeCompare(b.anchor.id));
  return entries;
}

/** A human-readable export. Recovery snapshots remain a separate, lossless format. */
export async function writeAnnotationExport(vault: Vault, path: string, index: AnnotationIndex, pdfPath: string): Promise<number> {
  const entries = await exportEntries(index);
  const partialPath = `${path}.partial`;
  const header = [
    `# Annotations — ${escapeInline(pdfPath.split("/").at(-1) ?? pdfPath)}`,
    "",
    `**PDF:** ${escapeInline(pdfPath)}  `,
    `**Exported:** ${new Date().toISOString()}  `,
    `**Annotations:** ${entries.length}`,
    "",
  ];
  await vault.adapter.write(partialPath, header.join("\n"));
  try {
    let batch: string[] = [];
    let currentPage = -1;
    for (let entryNumber = 0; entryNumber < entries.length; entryNumber++) {
      const { anchor, members, pages } = entries[entryNumber];
      if (pages[0] !== currentPage) {
        currentPage = pages[0];
        batch.push(`## Page ${currentPage}`, "");
      }
      batch.push(`### ${entryNumber + 1}. ${styleLabel(anchor)} · ${pageLabel(pages)}`, "");
      if (anchor.kind === "area") batch.push(areaEmbed(anchor), "");
      const quoted = members.filter(item => item.kind === "text" && item.quote.trim());
      const sameQuote = new Set(quoted.map(member => member.quote.trim())).size === 1;
      for (const member of sameQuote ? quoted.slice(0, 1) : quoted) {
        if (pages.length > 1 && !sameQuote) batch.push(`*Page ${member.page}*`, "");
        batch.push(...quoteLines(member.quote), "");
      }
      const note = members.find(item => item.id === (anchor.groupId || anchor.id) && item.note.trim())?.note
        ?? members.find(item => item.note.trim())?.note;
      if (note) batch.push("**Note**", "", note.trim(), "");
      const tags = members.find(item => item.tags.length)?.tags ?? [];
      if (tags.length) batch.push(`**Tags:** ${tags.map(escapeInline).join(", ")}`, "");
      const target = anchor.groupId || anchor.id;
      batch.push(`[Open in PDF](${annotationUri(vault.getName(), pdfPath, target)})`, "");
      if (entryNumber === entries.length - 1 || batch.length >= 500) {
        await vault.adapter.append(partialPath, batch.join("\n") + "\n");
        batch = [];
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }
    await vault.adapter.rename(partialPath, path);
    return entries.length;
  } catch (error) {
    if (await vault.adapter.exists(partialPath)) await vault.adapter.remove(partialPath);
    throw error;
  }
}

/**
 * The sidecar's only frontmatter property: a link to the PDF it belongs to.
 * Together with the end marker it is what allows the plugin to overwrite the
 * note; "Related" is a common property name, so it is never trusted alone.
 */
const SIDECAR_PDF_KEY = "Related";
const SIDECAR_END = "%% lumen-sidecar-end: anything you write below this line is kept when the sidecar is re-exported %%";
const SIDECAR_END_PREFIX = "%% lumen-sidecar-end";
// Written by 1.0.8–1.0.24: the PDF path as a plain string.
const PREVIOUS_PDF_KEY = "lumen-pdf";
// Frontmatter written by 1.0.0–1.0.7, still recognised so old sidecars are reused.
const LEGACY_MARKER = "lumen-sidecar";
const LEGACY_PDF_KEY = "lumen-pdf-path";

/** Sidecars live in the vault root: `<pdf name>.md`, then `<pdf name> 2.md`, … on name clashes. */
function sidecarCandidate(pdf: TFile, attempt: number): string {
  return normalizePath(`${pdf.basename}${attempt > 1 ? ` ${attempt}` : ""}.md`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function tagLabel(tag: string): string {
  // Obsidian tags cannot contain spaces, so "to read" becomes #to-read. Tags
  // that still are not valid (e.g. only digits) are written as plain text.
  const value = tag.trim().replace(/^#/, "").replace(/\s+/g, "-");
  return /^[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*$/u.test(value) ? `#${value}` : escapeInline(value);
}

/** A color label that Obsidian will not mistake for a tag. */
function markdownColorName(color: string, names: ColorNames): string {
  if (hasCustomColorName(color, names)) return escapeInline(colorName(color, names)).replace(/(^|\s)#/g, "$1\\#");
  const name = colorName(color);
  return name === color ? `Custom color \`${color.replace(/`/g, "")}\`` : name;
}

/**
 * One annotation as a bullet, with its note (if any) as a nested quote item:
 *
 *     - highlighted text #tag *([pg. 3](obsidian://…))*
 *     	- ["] *note*
 *
 * Tags always follow the highlighted text. The page link opens the annotation
 * in the PDF.
 */
function renderEntry(lines: string[], entry: ExportEntry, vaultName: string, pdfPath: string): void {
  const { anchor, members, pages } = entry;
  const note = members.find(item => item.id === (anchor.groupId || anchor.id) && item.note.trim())?.note
    ?? members.find(item => item.note.trim())?.note;
  const tags = (members.find(item => item.tags.length)?.tags ?? []).map(tagLabel).join(" ");
  // Parts of one annotation on several pages usually share the full quote.
  // An area shows its picture instead of the text found inside it.
  const quote = anchor.kind === "area" ? areaEmbed(anchor) : Array.from(new Set(members
    .filter(item => item.kind === "text" && item.quote.trim())
    .map(item => escapeInline(item.quote.replace(/\s+/g, " ").trim()))))
    .join(" … ");
  const pageText = pages.length === 1 ? `pg. ${pages[0]}` : `pgs. ${pages.join(", ")}`;
  const link = `*([${pageText}](${annotationUri(vaultName, pdfPath, anchor.groupId || anchor.id)}))*`;
  const highlight = [quote || "Page note"];
  if (tags) highlight.push(tags);
  highlight.push(link);
  lines.push(`- ${highlight.join(" ")}`);
  if (note) {
    const noteText = escapeInline(note.replace(/\s+/g, " ").trim());
    lines.push(`\t- ["] *${noteText}*`);
  }
}

/** A CSS color safe to put in a style attribute, or null. */
function safeCssColor(color: string): string | null {
  const value = color.trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]+$/i.test(value) || /^(rgb|hsl)a?\([\d.,%\s]+\)$/i.test(value) ? value : null;
}

/** A color-group heading, shown in the highlight's own color. */
function colorHeading(color: string, names: ColorNames): string {
  const label = markdownColorName(color, names);
  const css = safeCssColor(color);
  return css ? `# <span style="color: ${css}">${label}</span>` : `# ${label}`;
}

/** Markdown for a sidecar note, grouped by highlight color or by page. */
export async function renderSidecarMarkdown(index: AnnotationIndex, pdf: TFile, vaultName: string, grouping: SidecarGrouping, names: ColorNames = {}, order: string[] = []): Promise<string> {
  const entries = await exportEntries(index);
  const lines = [
    "---",
    `${SIDECAR_PDF_KEY}: ${yamlString(`[[${pdf.path}|${pdf.name}]]`)}`,
    "---",
    "",
  ];
  if (!entries.length) lines.push("*No annotations yet.*", "");
  if (grouping === "color") {
    const groups = new Map<string, ExportEntry[]>();
    const notes: ExportEntry[] = [];
    for (const entry of entries) {
      if (entry.anchor.kind === "page-note") {
        notes.push(entry);
        continue;
      }
      const group = groups.get(entry.anchor.color) ?? [];
      group.push(entry);
      groups.set(entry.anchor.color, group);
    }
    for (const color of orderColors(Array.from(groups.keys()), names, order)) {
      lines.push(colorHeading(color, names), "");
      for (const entry of groups.get(color) ?? []) renderEntry(lines, entry, vaultName, pdf.path);
      lines.push("");
    }
    if (notes.length) {
      lines.push("# Page notes", "");
      for (const entry of notes) renderEntry(lines, entry, vaultName, pdf.path);
      lines.push("");
    }
  } else {
    let currentPage = -1;
    for (const entry of entries) {
      if (entry.pages[0] !== currentPage) {
        if (currentPage !== -1) lines.push("");
        currentPage = entry.pages[0];
        lines.push(`# Page ${currentPage}`, "");
      }
      renderEntry(lines, entry, vaultName, pdf.path);
    }
    if (currentPage !== -1) lines.push("");
  }
  lines.push(SIDECAR_END, "");
  return lines.join("\n");
}

export class SidecarConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} and its numbered alternatives are already taken, so no sidecar was written.`);
  }
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const raw = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*?)\\s*$`, "m"))?.[1];
  if (raw === undefined) return null;
  try { return String(JSON.parse(raw)); } catch { return raw.replace(/^['"]|['"]$/g, ""); }
}

/**
 * The link target of a `Related` property, whether written inline or, after
 * editing it in Obsidian's property editor, as the first item of a list.
 */
function relatedLinkTarget(frontmatter: string): string | null {
  const match = frontmatter.match(new RegExp(`^${SIDECAR_PDF_KEY}:[ \\t]*(.*?)\\s*$(?:\\r?\\n[ \\t]*-[ \\t]*(.*?)\\s*$)?`, "mi"));
  if (!match) return null;
  const raw = match[1] || match[2] || "";
  let value = raw;
  try { value = String(JSON.parse(raw)); } catch { value = raw.replace(/^['"]|['"]$/g, ""); }
  return value.match(/^\[\[([^|\]]+)/)?.[1]?.trim() ?? null;
}

/**
 * Finds notes linking to a PDF and resolves link text to files, so a sidecar
 * can be recognised after it is moved or after Obsidian shortens its link.
 */
export interface SidecarLookup {
  /** Markdown notes that link to the PDF (frontmatter links included). */
  linkedFrom(pdf: TFile): string[];
  /** The file a link in `sourcePath` points to, if any. */
  resolve(link: string, sourcePath: string): TFile | null;
}

/**
 * The PDF link a sidecar was written for, "" if unknown, or null if the note
 * is not a sidecar. `named` says the note has the sidecar's own file name,
 * where a `Related` link alone is enough even if the end marker was deleted.
 */
function sidecarOwner(content: string, named = false): string | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (frontmatter === undefined) return null;
  const related = named || content.includes(SIDECAR_END_PREFIX) ? relatedLinkTarget(frontmatter) : null;
  if (related !== null) return related;
  const pdf = frontmatterValue(frontmatter, PREVIOUS_PDF_KEY);
  if (pdf !== null) return pdf;
  if (frontmatterValue(frontmatter, LEGACY_MARKER) !== "true") return null;
  const legacyPath = frontmatterValue(frontmatter, LEGACY_PDF_KEY);
  if (legacyPath !== null) return legacyPath;
  // Sidecars from 1.0.0–1.0.3 only carry the `pdf: "[[path|name]]"` link.
  return frontmatter.match(/^pdf:\s*"\[\[(.+?)\|/m)?.[1] ?? "";
}

/** Whether the note at `path` is this PDF's sidecar (true), another note (false), or an old sidecar of unknown PDF (true). */
function ownsPdf(content: string, path: string, pdf: TFile, lookup: SidecarLookup | undefined, named: boolean): boolean {
  const owner = sidecarOwner(content, named);
  if (owner === null) return false;
  if (owner === "" || owner === pdf.path) return true;
  return lookup?.resolve(owner, path)?.path === pdf.path;
}

/** This PDF's sidecar wherever it is: first notes linking to the PDF (it may have been moved), then the vault root names. */
async function findSidecar(vault: Vault, pdf: TFile, lookup?: SidecarLookup): Promise<{ path: string | null; free: string | null }> {
  for (const path of lookup?.linkedFrom(pdf) ?? []) {
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") continue;
    const named = (file.parent?.isRoot() ?? true) && /^(.*?)(?: \d+)?$/.exec(file.basename)?.[1] === pdf.basename;
    if (ownsPdf(await vault.cachedRead(file), path, pdf, lookup, named)) return { path, free: null };
  }
  for (let attempt = 1; attempt <= 100; attempt++) {
    const path = sidecarCandidate(pdf, attempt);
    const existing = vault.getAbstractFileByPath(path);
    if (!existing) return { path: null, free: path };
    if (existing instanceof TFile && ownsPdf(await vault.cachedRead(existing), path, pdf, lookup, true)) return { path, free: null };
  }
  return { path: null, free: null };
}

/**
 * This PDF's sidecar: the note already written for it (even if moved), else
 * the first of `<pdf name>.md`, `<pdf name> 2.md`, … in the vault root that is
 * free. Notes the user wrote and other PDFs' sidecars are never overwritten.
 */
export async function sidecarPath(vault: Vault, pdf: TFile, lookup?: SidecarLookup): Promise<string> {
  const found = await findSidecar(vault, pdf, lookup);
  const path = found.path ?? found.free;
  if (!path) throw new SidecarConflictError(sidecarCandidate(pdf, 1));
  return path;
}

/** This PDF's sidecar if one has been exported (and not deleted), else null. */
export async function existingSidecarPath(vault: Vault, pdf: TFile, lookup?: SidecarLookup): Promise<string | null> {
  return (await findSidecar(vault, pdf, lookup)).path;
}

/** Text the user wrote below the end marker, which a re-export keeps. */
function keptText(content: string): string {
  const start = content.indexOf(SIDECAR_END_PREFIX);
  if (start === -1) return "";
  const close = content.indexOf("%%", start + SIDECAR_END_PREFIX.length);
  if (close === -1) return "";
  return content.slice(close + 2).replace(/^\r?\n/, "");
}

/**
 * Write the sidecar (`<pdf name>.md` in the vault root, or wherever it was
 * moved). Existing notes are overwritten only when they are this PDF's
 * sidecar, and text the user added below the end marker is carried over.
 */
export async function writeSidecar(vault: Vault, pdf: TFile, index: AnnotationIndex, grouping: SidecarGrouping, names: ColorNames = {}, order: string[] = [], lookup?: SidecarLookup): Promise<string> {
  const path = await sidecarPath(vault, pdf, lookup);
  const generated = await renderSidecarMarkdown(index, pdf, vault.getName(), grouping, names, order);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    let changed = false;
    await vault.process(existing, content => {
      // Checked again in case the note changed since it was found.
      const named = (existing.parent?.isRoot() ?? true) && /^(.*?)(?: \d+)?$/.exec(existing.basename)?.[1] === pdf.basename;
      if (!ownsPdf(content, path, pdf, lookup, named || content.includes(SIDECAR_END_PREFIX))) return content;
      changed = true;
      return generated + keptText(content);
    });
    if (!changed) throw new Error(`${path} no longer looks like this PDF's sidecar, so it was left unchanged.`);
  } else if (existing) {
    throw new SidecarConflictError(path);
  } else {
    await vault.create(path, generated);
  }
  return path;
}
