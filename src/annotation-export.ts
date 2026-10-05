import { normalizePath, TFile } from "obsidian";
import type { Vault } from "obsidian";
import { annotationUri } from "./links";
import { colorName, compareColors } from "./model";
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

/** Frontmatter key that marks a note as a sidecar this plugin may overwrite. */
const SIDECAR_MARKER = "lumen-sidecar";
const SIDECAR_END = "%% lumen-sidecar-end: anything you write below this line is kept when the sidecar is re-exported %%";

export function sidecarPath(pdf: TFile): string {
  const folder = pdf.parent && !pdf.parent.isRoot() ? `${pdf.parent.path}/` : "";
  return normalizePath(`${folder}${pdf.basename}.md`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function tagLabel(tag: string): string {
  // Render as an Obsidian tag when it is a valid one, otherwise as plain text.
  return /^[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*$/u.test(tag) ? `#${tag}` : escapeInline(tag);
}

/** A colour label that Obsidian will not mistake for a tag. */
function markdownColorName(color: string): string {
  const name = colorName(color);
  return name === color ? `Custom colour \`${color.replace(/`/g, "")}\`` : name;
}

function renderEntry(lines: string[], entry: ExportEntry, vaultName: string, pdfPath: string, heading: string): void {
  const { anchor, members, pages } = entry;
  const kind = anchor.kind === "page-note" ? "Page note" : styleLabel(anchor);
  const label = anchor.kind === "page-note" ? kind : `${markdownColorName(anchor.color)} ${kind.toLowerCase()}`;
  lines.push(`${heading} ${label} · ${pageLabel(pages)}`, "");
  const quoted = members.filter(item => item.kind !== "page-note" && item.quote.trim());
  for (const member of quoted) {
    if (pages.length > 1) lines.push(`*Page ${member.page}*`, "");
    lines.push(...quoteLines(member.quote), "");
  }
  const note = members.find(item => item.id === (anchor.groupId || anchor.id) && item.note.trim())?.note
    ?? members.find(item => item.note.trim())?.note;
  if (note) lines.push(note.trim(), "");
  const tags = members.find(item => item.tags.length)?.tags ?? [];
  if (tags.length) lines.push(`Tags: ${tags.map(tagLabel).join(", ")}`, "");
  lines.push(`[Open in PDF](${annotationUri(vaultName, pdfPath, anchor.groupId || anchor.id)})`, "");
}

/** Markdown for a sidecar note, grouped by page or by highlight colour. */
export async function renderSidecarMarkdown(index: AnnotationIndex, pdf: TFile, vaultName: string, grouping: SidecarGrouping): Promise<string> {
  const entries = await exportEntries(index);
  const lines = [
    "---",
    `${SIDECAR_MARKER}: true`,
    `pdf: ${yamlString(`[[${pdf.path}|${pdf.name}]]`)}`,
    `exported: ${new Date().toISOString()}`,
    `annotations: ${entries.length}`,
    "---",
    "",
    `# ${escapeInline(pdf.basename)}`,
    "",
    `Annotations from [[${pdf.path}|${escapeInline(pdf.name)}]].`,
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
    for (const color of Array.from(groups.keys()).sort(compareColors)) {
      const group = groups.get(color) ?? [];
      lines.push(`## ${markdownColorName(color)} (${group.length})`, "");
      for (const entry of group) renderEntry(lines, entry, vaultName, pdf.path, "###");
    }
    if (notes.length) {
      lines.push(`## Page notes (${notes.length})`, "");
      for (const entry of notes) renderEntry(lines, entry, vaultName, pdf.path, "###");
    }
  } else {
    let currentPage = -1;
    for (const entry of entries) {
      if (entry.pages[0] !== currentPage) {
        currentPage = entry.pages[0];
        lines.push(`## Page ${currentPage}`, "");
      }
      renderEntry(lines, entry, vaultName, pdf.path, "###");
    }
  }
  lines.push(SIDECAR_END, "");
  return lines.join("\n");
}

export class SidecarConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists and was not created by this plugin, so it was left unchanged.`);
  }
}

function isSidecar(content: string): boolean {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!frontmatter && new RegExp(`^${SIDECAR_MARKER}:\\s*true\\s*$`, "m").test(frontmatter[1]);
}

/**
 * Write `<pdf name>.md` next to the PDF. Existing notes are overwritten only
 * when they are sidecars this plugin wrote, and text the user added below the
 * end marker is carried over.
 */
export async function writeSidecar(vault: Vault, pdf: TFile, index: AnnotationIndex, grouping: SidecarGrouping): Promise<string> {
  const path = sidecarPath(pdf);
  const generated = await renderSidecarMarkdown(index, pdf, vault.getName(), grouping);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    if (!isSidecar(await vault.read(existing))) throw new SidecarConflictError(path);
    await vault.process(existing, content => {
      if (!isSidecar(content)) return content;
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
