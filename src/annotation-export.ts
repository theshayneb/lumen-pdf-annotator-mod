import { normalizePath, TFile } from "obsidian";
import type { Vault } from "obsidian";
import { annotationUri } from "./links";
import { colorName, compareColors, hasCustomColorName } from "./model";
import type { ColorNames } from "./model";
import type { AnnotationIndex, PdfAnnotation } from "./model";

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
      const quoted = members.filter(item => item.kind !== "page-note" && item.quote.trim());
      for (const member of quoted) {
        if (pages.length > 1) batch.push(`*Page ${member.page}*`, "");
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
 * The sidecar's only frontmatter property: the PDF it belongs to. Its presence
 * is also what allows the plugin to overwrite the note.
 */
const SIDECAR_PDF_KEY = "lumen-pdf";
const SIDECAR_END = "%% lumen-sidecar-end: anything you write below this line is kept when the sidecar is re-exported %%";
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
 * One annotation:
 *
 *     > Page 3: highlighted text #tag
 *
 *     * note (only when there is one) #tag
 *
 *
 *     > > [Open in PDF](obsidian://…)
 *
 * Tags go at the end of the note when there is one, otherwise at the end of
 * the highlighted text.
 */
function renderEntry(lines: string[], entry: ExportEntry, vaultName: string, pdfPath: string): void {
  const { anchor, members } = entry;
  const note = members.find(item => item.id === (anchor.groupId || anchor.id) && item.note.trim())?.note
    ?? members.find(item => item.note.trim())?.note;
  const tags = (members.find(item => item.tags.length)?.tags ?? []).map(tagLabel).join(" ");
  const withTags = (text: string) => tags ? `${text} ${tags}` : text;
  const quoted = members.filter(item => item.kind !== "page-note" && item.quote.trim());
  const quoteLines = quoted.length
    ? quoted.map(member => `> Page ${member.page}: ${member.quote.replace(/\s+/g, " ").trim()}`)
    : [`> Page ${anchor.page}`];
  if (!note) quoteLines[quoteLines.length - 1] = withTags(quoteLines[quoteLines.length - 1]);
  lines.push(...quoteLines, "");
  if (note) {
    const noteLines = note.trim().split(/\r?\n/);
    noteLines[noteLines.length - 1] = withTags(noteLines[noteLines.length - 1]);
    const [first, ...rest] = noteLines;
    lines.push(`* ${first}`, ...rest.map(line => line.trim() ? `  ${line}` : ""), "", "");
  }
  lines.push(`> > [Open in PDF](${annotationUri(vaultName, pdfPath, anchor.groupId || anchor.id)})`, "");
}

/** Markdown for a sidecar note, grouped by highlight color or by page. */
export async function renderSidecarMarkdown(index: AnnotationIndex, pdf: TFile, vaultName: string, grouping: SidecarGrouping, names: ColorNames = {}): Promise<string> {
  const entries = await exportEntries(index);
  const lines = [
    "---",
    `${SIDECAR_PDF_KEY}: ${yamlString(pdf.path)}`,
    "---",
    `[[${pdf.path}|${pdf.name}]]`,
    "",
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
    for (const color of Array.from(groups.keys()).sort((a, b) => compareColors(a, b, names))) {
      lines.push(`# ${markdownColorName(color, names)}`, "");
      for (const entry of groups.get(color) ?? []) renderEntry(lines, entry, vaultName, pdf.path);
    }
    if (notes.length) {
      lines.push("# Page notes", "");
      for (const entry of notes) renderEntry(lines, entry, vaultName, pdf.path);
    }
  } else {
    let currentPage = -1;
    for (const entry of entries) {
      if (entry.pages[0] !== currentPage) {
        currentPage = entry.pages[0];
        lines.push(`# Page ${currentPage}`, "");
      }
      renderEntry(lines, entry, vaultName, pdf.path);
    }
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

/** The PDF path a sidecar was written for, "" if unknown, or null if the note is not a sidecar. */
function sidecarOwner(content: string): string | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (frontmatter === undefined) return null;
  const pdf = frontmatterValue(frontmatter, SIDECAR_PDF_KEY);
  if (pdf !== null) return pdf;
  if (frontmatterValue(frontmatter, LEGACY_MARKER) !== "true") return null;
  const legacyPath = frontmatterValue(frontmatter, LEGACY_PDF_KEY);
  if (legacyPath !== null) return legacyPath;
  // Sidecars from 1.0.0–1.0.3 only carry the `pdf: "[[path|name]]"` link.
  return frontmatter.match(/^pdf:\s*"\[\[(.+?)\|/m)?.[1] ?? "";
}

/**
 * This PDF's sidecar in the vault root: the first of `<pdf name>.md`,
 * `<pdf name> 2.md`, … that is free or already this PDF's sidecar. Notes the
 * user wrote and other PDFs' sidecars are skipped, never overwritten.
 */
export async function sidecarPath(vault: Vault, pdf: TFile): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt++) {
    const path = sidecarCandidate(pdf, attempt);
    const existing = vault.getAbstractFileByPath(path);
    if (!existing) return path;
    if (!(existing instanceof TFile)) continue;
    const owner = sidecarOwner(await vault.cachedRead(existing));
    if (owner === pdf.path || owner === "") return path;
  }
  throw new SidecarConflictError(sidecarCandidate(pdf, 1));
}

/**
 * Write `<pdf name>.md` in the vault root. Existing notes are overwritten only
 * when they are this PDF's sidecar, and text the user added below the end
 * marker is carried over.
 */
export async function writeSidecar(vault: Vault, pdf: TFile, index: AnnotationIndex, grouping: SidecarGrouping, names: ColorNames = {}): Promise<string> {
  const path = await sidecarPath(vault, pdf);
  const generated = await renderSidecarMarkdown(index, pdf, vault.getName(), grouping, names);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.process(existing, content => {
      const owner = sidecarOwner(content);
      if (owner !== pdf.path && owner !== "") return content;
      const end = content.indexOf(SIDECAR_END);
      const kept = end === -1 ? "" : content.slice(end + SIDECAR_END.length).replace(/^\r?\n/, "");
      return generated + kept;
    });
  } else if (existing) {
    throw new SidecarConflictError(path);
  } else {
    await vault.create(path, generated);
  }
  return path;
}
