import { App, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { existingSidecarPath, SidecarConflictError, sidecarLayout, sidecarLookupFor, writeSidecar } from "./annotation-export";
import { noteVaultChange, runsBackgroundTasks, syncSettled } from "./device";
import { AnnotationRepository, BUNDLE_ROOT, FILE_INDEX_ROOT, isAnnotationDataFile, migrateAreaImages, migrateStorageFolder, readBundleManifest } from "./storage";

/*
 * Background work, done only on the device with "Run background tasks on this
 * device" on (the always-on desktop by default), and only once Obsidian Sync
 * has gone quiet:
 *
 * - merging every device's annotation journals into each PDF's compacted snapshot;
 * - rewriting exported sidecar notes after changes from any device arrive,
 *   including for PDFs that aren't open;
 * - one-time storage moves left from earlier versions;
 * - moving the old, synced hash cache folder to the trash once no device has
 *   written to it for 30 days (older versions write to it; updated ones don't).
 *
 * Phones and tablets do none of this. They only save what you do by hand.
 */

const CHECK_EVERY_MS = 60_000;
const SIGNATURES_KEY = "pdf-annotator:bundle-signatures";
const LAST_RUN_KEY = "pdf-annotator:background-last-run";
const OLD_CACHE_QUIET_MS = 30 * 86_400_000;

export class BackgroundTasks {
  private readonly dirty = new Set<string>();
  private running = false;
  private sweptAll = false;
  private didOneTimeWork = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly sidecarAutoUpdate: () => boolean,
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  start(): void {
    const vault = this.app.vault;
    const watch = (file: TAbstractFile, oldPath?: string) => {
      noteVaultChange();
      for (const path of [file.path, oldPath]) {
        const folder = path ? bundleFolderOf(path) : null;
        if (folder) this.dirty.add(folder);
      }
    };
    this.plugin.registerEvent(vault.on("create", file => watch(file)));
    this.plugin.registerEvent(vault.on("modify", file => watch(file)));
    this.plugin.registerEvent(vault.on("delete", file => watch(file)));
    this.plugin.registerEvent(vault.on("rename", (file, oldPath) => watch(file, oldPath)));
    this.plugin.registerInterval(window.setInterval(() => void this.tick(), CHECK_EVERY_MS));
  }

  /** When background work last finished on this device, or 0. */
  lastRun(): number {
    const value: unknown = this.app.loadLocalStorage(LAST_RUN_KEY);
    return typeof value === "number" ? value : 0;
  }

  async tick(): Promise<void> {
    if (this.running || !runsBackgroundTasks() || !syncSettled()) return;
    this.running = true;
    try {
      if (!this.didOneTimeWork) {
        this.didOneTimeWork = true;
        await this.oneTimeWork();
      }
      if (!this.sweptAll) {
        // Changes that arrived while Obsidian was closed: anything whose files differ from the last run.
        this.sweptAll = true;
        for (const folder of await this.changedBundles()) this.dirty.add(folder);
      }
      const folders = Array.from(this.dirty);
      this.dirty.clear();
      for (const folder of folders) {
        try {
          await this.processBundle(folder);
        } catch (error) {
          console.error(`PDF Annotator could not update ${folder}`, error);
        }
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      if (folders.length) this.app.saveLocalStorage(LAST_RUN_KEY, Date.now());
    } finally {
      this.running = false;
    }
  }

  private async oneTimeWork(): Promise<void> {
    try {
      await migrateStorageFolder(this.app.vault);
    } catch (error) {
      console.error("PDF Annotator could not move its storage folder", error);
    }
    try {
      await migrateAreaImages(this.app.vault, (file, path) => this.app.fileManager.renameFile(file, path));
    } catch (error) {
      console.error("PDF Annotator could not move area pictures", error);
    }
    try {
      await this.trashOldHashCache();
    } catch (error) {
      console.error("PDF Annotator could not remove its old hash cache folder", error);
    }
  }

  /** The 1.0.x hash cache lived in the synced vault. Once no device has touched it for 30 days, it goes to the trash. */
  private async trashOldHashCache(): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(FILE_INDEX_ROOT);
    if (!(folder instanceof TFolder)) return;
    const now = Date.now();
    for (const child of folder.children) {
      if (child instanceof TFile && now - child.stat.mtime < OLD_CACHE_QUIET_MS) return;
    }
    await this.app.fileManager.trashFile(folder);
  }

  private signatures(): Record<string, string> {
    const value: unknown = this.app.loadLocalStorage(SIGNATURES_KEY);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  }

  /** The names, sizes and change times of a PDF folder's data files: changes when any device's files change. */
  private async signature(folder: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) return "";
    const parts: string[] = [];
    for (const path of (await adapter.list(folder)).files.sort()) {
      const name = path.split("/").at(-1) ?? "";
      if (!isAnnotationDataFile(name)) continue;
      const stat = await adapter.stat(path);
      parts.push(`${name}:${stat?.size ?? 0}:${stat?.mtime ?? 0}`);
    }
    return parts.join("|");
  }

  private async changedBundles(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(BUNDLE_ROOT))) return [];
    const known = this.signatures();
    const changed: string[] = [];
    for (const folder of (await adapter.list(BUNDLE_ROOT)).folders) {
      if (known[folder] !== await this.signature(folder)) changed.push(folder);
    }
    return changed;
  }

  /** Merges one PDF's journals into its snapshot and brings its exported sidecar up to date. */
  private async processBundle(folder: string): Promise<void> {
    const hash = folder.split("/").at(-1) ?? "";
    const manifest = await readBundleManifest(this.app.vault, folder, hash);
    if (!manifest) return;
    const repository = new AnnotationRepository(this.app.vault, folder, hash, manifest.workingPath);
    await repository.compact();
    const pdf = this.app.vault.getAbstractFileByPath(manifest.workingPath);
    if (this.sidecarAutoUpdate() && pdf instanceof TFile) {
      const lookup = sidecarLookupFor(this.app);
      const sidecar = await existingSidecarPath(this.app.vault, pdf, lookup);
      const note = sidecar ? this.app.vault.getAbstractFileByPath(sidecar) : null;
      if (note instanceof TFile) {
        const index = await repository.load();
        const palette = await repository.loadPalette();
        const layout = palette.layout ?? sidecarLayout(await this.app.vault.cachedRead(note));
        try {
          await writeSidecar(this.app.vault, pdf, index, layout, palette.names, palette.order, lookup);
        } catch (error) {
          if (!(error instanceof SidecarConflictError)) throw error;
        }
      }
    }
    const signatures = this.signatures();
    signatures[folder] = await this.signature(folder);
    this.app.saveLocalStorage(SIGNATURES_KEY, signatures);
  }
}

/** The PDF folder a vault path is in, when it is one of that folder's data files. */
function bundleFolderOf(path: string): string | null {
  if (!path.startsWith(`${BUNDLE_ROOT}/`)) return null;
  const parts = path.slice(BUNDLE_ROOT.length + 1).split("/");
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[0] ?? "") || !isAnnotationDataFile(parts[1] ?? "")) return null;
  return `${BUNDLE_ROOT}/${parts[0]}`;
}
