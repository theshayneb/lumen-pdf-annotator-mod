import { FuzzySuggestModal, Modal, normalizePath, Notice, ObsidianProtocolData, Platform, Plugin, PluginSettingTab, TFile } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { LUMEN_PROTOCOL_ACTION } from "./links";
import { disposePdfRuntime } from "./pdf-runtime";
import { BackgroundTasks } from "./background";
import { initDevice, runsBackgroundTasks, setRunsBackgroundTasks, syncStatusText } from "./device";
import { AnnotationBundleInfo, BundleInfo, STORAGE_FOLDER, exportAnnotationBundle, listAnnotationBundles, listBundles, restoreBundle, verifyBundle } from "./storage";
import { mergeSettings } from "./sync-merge";
import { InterfaceTheme, LumenPdfView, LUMEN_VIEW_TYPE, PdfTheme } from "./view";
import { PdfViewStateManager } from "./view-state";

interface LumenSettings {
  defaultViewer: boolean;
  pdfTheme: PdfTheme;
  interfaceTheme: InterfaceTheme;
  openAnnotationsPanel: boolean;
  legacyAnnotationFolder: string;
  automaticPdfBackups: boolean;
  sidecarAutoUpdate: boolean;
}

const DEFAULT_SETTINGS: LumenSettings = {
  defaultViewer: true,
  pdfTheme: "light",
  interfaceTheme: "dark",
  openAnnotationsPanel: true,
  legacyAnnotationFolder: "PDF annotations",
  automaticPdfBackups: false,
  sidecarAutoUpdate: true,
};

function isPdfTheme(value: unknown): value is PdfTheme {
  return value === "light" || value === "sepia" || value === "dark";
}

function isInterfaceTheme(value: unknown): value is InterfaceTheme {
  return value === "dark" || value === "light" || value === "pdf";
}

function readSettings(value: unknown): LumenSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
  const stored = value as Record<string, unknown>;
  return {
    defaultViewer: typeof stored.defaultViewer === "boolean" ? stored.defaultViewer : DEFAULT_SETTINGS.defaultViewer,
    pdfTheme: isPdfTheme(stored.pdfTheme) ? stored.pdfTheme : DEFAULT_SETTINGS.pdfTheme,
    interfaceTheme: isInterfaceTheme(stored.interfaceTheme) ? stored.interfaceTheme : DEFAULT_SETTINGS.interfaceTheme,
    openAnnotationsPanel: typeof stored.openAnnotationsPanel === "boolean" ? stored.openAnnotationsPanel : DEFAULT_SETTINGS.openAnnotationsPanel,
    legacyAnnotationFolder: typeof stored.legacyAnnotationFolder === "string" ? stored.legacyAnnotationFolder : DEFAULT_SETTINGS.legacyAnnotationFolder,
    automaticPdfBackups: typeof stored.automaticPdfBackups === "boolean" ? stored.automaticPdfBackups : DEFAULT_SETTINGS.automaticPdfBackups,
    sidecarAutoUpdate: typeof stored.sidecarAutoUpdate === "boolean" ? stored.sidecarAutoUpdate : DEFAULT_SETTINGS.sidecarAutoUpdate,
  };
}

/** data.json key holding when each setting was last changed, on any device. */
const SETTING_TIMES_KEY = "settingsUpdatedAt";

function readSettingTimes(value: unknown): Record<string, number> {
  const times = (value as Record<string, unknown> | null)?.[SETTING_TIMES_KEY];
  if (!times || typeof times !== "object" || Array.isArray(times)) return {};
  return Object.fromEntries(Object.entries(times as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface ViewRegistryWithExtensions {
  typeByExtension: Record<string, string>;
}

export default class LumenPdfPlugin extends Plugin {
  settings: LumenSettings = DEFAULT_SETTINGS;
  /** When each setting was last changed, on any device, so merges keep the latest. */
  private settingTimes: Record<string, number> = {};
  private dataWrite: Promise<void> = Promise.resolve();
  private viewState!: PdfViewStateManager;
  background!: BackgroundTasks;

  async onload(): Promise<void> {
    initDevice(this.app);
    const data: unknown = await this.loadData() as unknown;
    this.settings = readSettings(data);
    this.settingTimes = readSettingTimes(data);
    // Storage moves, sidecar updates and tidying happen only on the device that runs background tasks.
    this.background = new BackgroundTasks(this, () => this.settings.sidecarAutoUpdate);
    this.background.start();
    this.app.workspace.onLayoutReady(() => void this.background.tick());
    this.viewState = new PdfViewStateManager(this);
    await this.viewState.load();
    this.registerView(LUMEN_VIEW_TYPE, leaf => new LumenPdfView(
      leaf,
      this.settings.pdfTheme,
      theme => void this.setPdfTheme(theme).catch(error => {
        console.error("Lumen could not save the PDF theme", error);
        new Notice("Could not save the PDF theme. Your current document will keep using it until reload.");
      }),
      this.settings.legacyAnnotationFolder,
      this.settings.automaticPdfBackups,
      () => this.viewState.attach(leaf),
      () => ({ autoSync: this.settings.sidecarAutoUpdate }),
      () => this.settings.interfaceTheme,
      () => this.settings.openAnnotationsPanel,
    ));
    if (this.settings.defaultViewer) this.installAsDefaultPdfViewer();
    this.registerObsidianProtocolHandler(LUMEN_PROTOCOL_ACTION, params => void this.openAnnotationLink(params).catch(error => {
      console.error("Lumen could not open an annotation link", error);
      new Notice("Could not open this annotation link.");
    }));

    this.addCommand({
      id: "open-current-pdf-in-lumen",
      name: "Open current PDF in the annotator",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return false;
        if (!checking) void this.openFile(file);
        return true;
      },
    });
    this.addReaderCommand("toggle-pdf-search", "Toggle PDF search", view => view.toggleSearch());
    this.addReaderCommand("toggle-annotation-inspector", "Toggle annotation inspector", view => view.toggleInspector());
    this.addReaderCommand("name-highlight-colours", "Name highlight colors for this PDF", view => view.openColorNamesModal());
    this.addReaderCommand("previous-pdf-page", "Previous PDF page", view => view.previousPage());
    this.addReaderCommand("next-pdf-page", "Next PDF page", view => view.nextPage());
    this.addReaderCommand("zoom-pdf-in", "Zoom PDF in", view => view.zoomIn());
    this.addReaderCommand("zoom-pdf-out", "Zoom PDF out", view => view.zoomOut());
    this.addReaderCommand("reset-pdf-zoom", "Reset PDF zoom", view => view.resetZoom());
    this.addReaderCommand("place-page-note", "Place a page note", view => view.togglePageNotePlacement());
    this.addReaderCommand("capture-area", "Capture an area (image or table)", view => view.toggleAreaMode());
    this.addReaderCommand("copy-annotations-from-version", "Copy annotations from another version of this PDF", view => view.chooseVersionToCopy());
    this.addReaderCommand("checkpoint-annotations", "Save an annotation checkpoint", async view => {
      await view.checkpointAnnotations();
      new Notice("Annotation checkpoint saved.");
    });
    this.addReaderCommand("export-annotations", "Export annotations for this PDF", async view => {
      const path = await view.exportAnnotations();
      if (path) new Notice(`Annotations exported to ${path}`);
    });
    this.addReaderCommand("export-annotations-sidecar", "Export annotations to sidecar Markdown note", view => view.chooseSidecarExport());
    this.addReaderCommand("change-note-layout", "Change note layout for this PDF", view => view.changeNoteLayout());
    this.addReaderCommand("import-legacy-annotations", "Import legacy annotations for this PDF", view => view.importLegacyAnnotations(true));
    this.addCommand({ id: "verify-pdf-backups", name: "Verify all PDF backup checksums", callback: () => void this.verifyAllBackups() });
    this.addCommand({ id: "restore-backed-up-pdf", name: "Restore a backed-up PDF", callback: () => void this.chooseBackupToRestore() });
    this.addSettingTab(new LumenSettingTab(this));

    this.registerEvent(this.app.workspace.on("layout-change", () => this.viewState.attachAll()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf) this.viewState.attach(leaf);
    }));
    window.setTimeout(() => this.viewState.attachAll(), 0);
  }

  onunload(): void {
    void this.viewState?.flush().catch(error => console.error("Lumen could not flush PDF view state", error));
    disposePdfRuntime();
  }

  private installAsDefaultPdfViewer(): void {
    // Obsidian reserves the PDF extension for its built-in view, so
    // registerExtensions() rejects it. Preserve and restore the exact prior
    // mapping instead of deleting or permanently mutating the core handler.
    const registry = (this.app as unknown as { viewRegistry?: ViewRegistryWithExtensions }).viewRegistry;
    if (!registry?.typeByExtension) {
      if (Platform.isMobile) {
        console.warn("Lumen could not replace the built-in PDF extension mapping on this mobile Obsidian build.");
        return;
      }
      throw new Error("Obsidian's PDF view registry is unavailable");
    }
    const previous = registry.typeByExtension.pdf;
    registry.typeByExtension.pdf = LUMEN_VIEW_TYPE;
    this.register(() => {
      if (registry.typeByExtension.pdf === LUMEN_VIEW_TYPE) registry.typeByExtension.pdf = previous;
    });
  }

  private addReaderCommand(
    id: string,
    name: string,
    action: (view: LumenPdfView) => void | Promise<unknown>,
  ): void {
    this.addCommand({
      id,
      name,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(LumenPdfView);
        if (!view) return false;
        if (!checking) void Promise.resolve(action(view)).catch(error => {
          console.error("Lumen command failed", error);
          new Notice(`Could not complete the command: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      },
    });
  }

  private async openFile(file: TFile, leaf = this.app.workspace.getLeaf(false)): Promise<LumenPdfView | null> {
    await leaf.setViewState({ type: LUMEN_VIEW_TYPE, active: true, state: { file: file.path } });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof LumenPdfView ? leaf.view : null;
  }

  private async openAnnotationLink(params: ObsidianProtocolData): Promise<void> {
    if (params.vault && params.vault !== this.app.vault.getName()) {
      new Notice(`This highlight link belongs to the “${params.vault}” vault.`);
      return;
    }
    if (!params.file || !params.annotation) {
      new Notice("This highlight link is incomplete.");
      return;
    }
    const exactPath = normalizePath(params.file);
    const legacyPath = normalizePath(params.file.replace(/\+/g, " "));
    const target = this.app.vault.getAbstractFileByPath(exactPath)
      ?? (legacyPath !== exactPath ? this.app.vault.getAbstractFileByPath(legacyPath) : null);
    if (!(target instanceof TFile) || target.extension.toLowerCase() !== "pdf") {
      new Notice("The PDF for this highlight link could not be found.");
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    const view = await this.openFile(target, leaf);
    if (!view || !(await view.revealAnnotation(params.annotation))) {
      new Notice("The linked highlight could not be found in this PDF.");
    }
  }

  async setPdfTheme(theme: PdfTheme): Promise<void> {
    await this.updateSetting("pdfTheme", theme);
  }

  async setInterfaceTheme(theme: InterfaceTheme): Promise<void> {
    await this.updateSetting("interfaceTheme", theme);
  }

  /** Applies a theme change, wherever it was made, to every open reader. */
  private applySettingEffects(previous: LumenSettings): void {
    for (const leaf of this.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) {
      if (!(leaf.view instanceof LumenPdfView)) continue;
      if (previous.pdfTheme !== this.settings.pdfTheme) leaf.view.setTheme(this.settings.pdfTheme);
      if (previous.interfaceTheme !== this.settings.interfaceTheme) leaf.view.refreshInterfaceTheme();
    }
  }

  /** Changes one setting here and saves only that setting, stamped with when it was changed. */
  async updateSetting<K extends keyof LumenSettings>(key: K, value: LumenSettings[K]): Promise<void> {
    const previous = { ...this.settings };
    this.settings = { ...this.settings, [key]: value };
    this.settingTimes = { ...this.settingTimes, [key]: Date.now() };
    this.applySettingEffects(previous);
    await this.savePatch([key]);
  }

  /**
   * Read, merge, then write: re-reads data.json and changes only `keys` in it,
   * so settings another device changed are never overwritten with this
   * device's older copy. Nothing is written when nothing would change.
   */
  private savePatch(keys: Array<keyof LumenSettings>): Promise<void> {
    const write = this.dataWrite.catch(() => undefined).then(async () => {
      const disk = asRecord(await this.loadData() as unknown);
      const diskTimes = readSettingTimes(disk);
      const next: Record<string, unknown> = { ...disk };
      const times = { ...diskTimes };
      for (const key of keys) {
        if ((diskTimes[key] ?? 0) > (this.settingTimes[key] ?? 0)) continue;
        next[key] = this.settings[key];
        times[key] = this.settingTimes[key] ?? 0;
      }
      next[SETTING_TIMES_KEY] = times;
      if (JSON.stringify(next) !== JSON.stringify(disk)) await this.saveData(next);
    });
    this.dataWrite = write;
    return write;
  }

  /**
   * Another device's settings arrived through Sync: merge them with this
   * device's, setting by setting, keeping whichever was changed last. Saves
   * only if this device holds a newer change that disk lacks.
   */
  async onExternalSettingsChange(): Promise<void> {
    await this.dataWrite.catch(() => undefined);
    const disk = asRecord(await this.loadData() as unknown);
    const diskSettings = readSettings(disk);
    const diskTimes = readSettingTimes(disk);
    const merged = mergeSettings({ ...this.settings }, this.settingTimes, diskSettings as unknown as Record<string, unknown>, diskTimes);
    const previous = { ...this.settings };
    this.settings = readSettings(merged.values);
    this.settingTimes = merged.times;
    this.applySettingEffects(previous);
    const newerHere = (Object.keys(DEFAULT_SETTINGS) as Array<keyof LumenSettings>)
      .filter(key => JSON.stringify(this.settings[key]) !== JSON.stringify(diskSettings[key]));
    if (newerHere.length) await this.savePatch(newerHere);
  }

  private async verifyAllBackups(): Promise<void> {
    const bundles = await listBundles(this.app.vault);
    if (!bundles.length) {
      new Notice("No PDF backups found.");
      return;
    }
    let valid = 0;
    const failures: string[] = [];
    for (const bundle of bundles) {
      const result = await verifyBundle(this.app.vault, bundle);
      if (result.ok) valid++;
      else failures.push(`${bundle.manifest.originalName}: ${result.reason ?? "verification failed"}`);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (failures.length) {
      console.error("Lumen backup verification failures", failures);
      new Notice(`${valid}/${bundles.length} PDF backups verified. ${failures.length} failed; details are in the developer console.`, 8000);
    } else {
      new Notice(`All ${valid} PDF backup${valid === 1 ? "" : "s"} verified.`);
    }
  }

  private async chooseBackupToRestore(): Promise<void> {
    const bundles = await listBundles(this.app.vault);
    if (!bundles.length) {
      new Notice("No PDF backups found.");
      return;
    }
    new BackupRestoreModal(this, bundles).open();
  }
}

class BackupRestoreModal extends FuzzySuggestModal<BundleInfo> {
  constructor(private readonly plugin: LumenPdfPlugin, private readonly bundles: BundleInfo[]) {
    super(plugin.app);
    this.setPlaceholder("Choose a PDF backup to restore");
  }

  getItems(): BundleInfo[] { return this.bundles; }
  getItemText(item: BundleInfo): string { return `${item.manifest.originalName} — ${item.manifest.workingPath}`; }
  onChooseItem(item: BundleInfo): void {
    void this.restore(item).catch(error => {
      console.error("Lumen restore failed", error);
      new Notice(`Restore failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    });
  }

  private async restore(item: BundleInfo): Promise<void> {
    const file = await restoreBundle(this.plugin.app.vault, item);
    new Notice(`Restored ${file.path}`);
    await this.plugin.app.workspace.getLeaf(true).openFile(file);
  }
}

class LumenSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: LumenPdfPlugin) {
    super(plugin.app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "This device",
        items: [
          {
            name: "Run background tasks on this device",
            desc: "Keeps sidecar notes up to date and tidies annotation storage. Turn this on for one always-on computer and off on phones and tablets. Saved on this device only, never synced. Default: on for desktop, off for mobile.",
            control: { type: "toggle", key: "backgroundTasks", defaultValue: Platform.isDesktopApp },
          },
          {
            name: "Background status",
            render: setting => {
              const last = this.plugin.background.lastRun();
              const when = last ? `last run ${new Date(last).toLocaleString()}` : "not run yet on this device";
              setting.setDesc(runsBackgroundTasks() ? `Status: ${syncStatusText()} · ${when}` : "Off on this device. Your changes here are saved and merged by the device that runs background tasks.");
            },
          },
        ],
      },
      {
        name: "Make PDF Annotator the default PDF viewer",
        desc: "Open PDFs in PDF Annotator after the next Obsidian restart.",
        control: { type: "toggle", key: "defaultViewer", defaultValue: DEFAULT_SETTINGS.defaultViewer },
      },
      {
        name: "PDF theme",
        desc: "Use this document theme for every PDF Annotator reader.",
        control: { type: "dropdown", key: "pdfTheme", options: { light: "Light", sepia: "Sepia", dark: "Dark" }, defaultValue: DEFAULT_SETTINGS.pdfTheme },
      },
      {
        name: "Interface theme",
        desc: "Theme for PDF Annotator's toolbar, panels, and editors. The PDF pages keep the PDF theme.",
        control: { type: "dropdown", key: "interfaceTheme", options: { dark: "Dark", light: "Light", pdf: "Match PDF theme" }, defaultValue: DEFAULT_SETTINGS.interfaceTheme },
      },
      {
        name: "Open the annotations panel automatically",
        desc: "Show the annotations panel whenever a PDF opens. It stays closed on phones, where it would cover the page.",
        control: { type: "toggle", key: "openAnnotationsPanel", defaultValue: DEFAULT_SETTINGS.openAnnotationsPanel },
      },
      {
        name: "Legacy annotation folder",
        desc: "Look here for older Markdown annotation notes that target the open PDF.",
        control: { type: "text", key: "legacyAnnotationFolder", placeholder: "PDF annotations", defaultValue: DEFAULT_SETTINGS.legacyAnnotationFolder },
      },
      {
        name: "Create automatic PDF recovery copies",
        desc: "Copy each opened PDF into PDF Annotator's recovery storage in the background. Only the device that runs background tasks makes copies. Keep this off for the smoothest large-PDF and cloud-vault performance.",
        control: { type: "toggle", key: "automaticPdfBackups", defaultValue: DEFAULT_SETTINGS.automaticPdfBackups },
      },
      {
        name: "Keep exported sidecar notes up to date",
        desc: "Once a PDF's sidecar note has been exported, rewrite it automatically a moment after each annotation change, using the heading order you chose. PDFs without a sidecar are left alone. Notes you did not create with this plugin are never overwritten, and text below the sidecar's end marker is kept. Updates are written by the device that runs background tasks, so notes change only after your edits reach it. Exporting by hand works on any device.",
        control: { type: "toggle", key: "sidecarAutoUpdate", defaultValue: DEFAULT_SETTINGS.sidecarAutoUpdate },
      },
      {
        name: "Export annotations",
        desc: `Choose annotated PDFs and export each one as a readable Markdown note in ${STORAGE_FOLDER}/exports/.`,
        render: setting => {
          setting.addButton(button => button.setButtonText("Choose PDFs to export").onClick(() => new AnnotationExportModal(this.plugin).open()));
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "backgroundTasks") return runsBackgroundTasks();
    if (key === "defaultViewer") return this.plugin.settings.defaultViewer;
    if (key === "pdfTheme") return this.plugin.settings.pdfTheme;
    if (key === "interfaceTheme") return this.plugin.settings.interfaceTheme;
    if (key === "openAnnotationsPanel") return this.plugin.settings.openAnnotationsPanel;
    if (key === "legacyAnnotationFolder") return this.plugin.settings.legacyAnnotationFolder;
    if (key === "automaticPdfBackups") return this.plugin.settings.automaticPdfBackups;
    if (key === "sidecarAutoUpdate") return this.plugin.settings.sidecarAutoUpdate;
    return undefined;
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    if (key === "backgroundTasks" && typeof value === "boolean") {
      setRunsBackgroundTasks(value);
      if (value) void this.plugin.background.tick();
      return;
    }
    if (key === "defaultViewer" && typeof value === "boolean") {
      return this.plugin.updateSetting("defaultViewer", value).then(() => {
        new Notice("Restart Obsidian to apply the PDF viewer change.");
      });
    }
    if (key === "pdfTheme" && isPdfTheme(value)) return this.plugin.setPdfTheme(value);
    if (key === "interfaceTheme" && isInterfaceTheme(value)) return this.plugin.setInterfaceTheme(value);
    if (key === "openAnnotationsPanel" && typeof value === "boolean") {
      return this.plugin.updateSetting("openAnnotationsPanel", value);
    }
    if (key === "legacyAnnotationFolder" && typeof value === "string") {
      return this.plugin.updateSetting("legacyAnnotationFolder", value.trim().replace(/^\/+|\/+$/g, "") || "PDF annotations");
    }
    if (key === "automaticPdfBackups" && typeof value === "boolean") {
      return this.plugin.updateSetting("automaticPdfBackups", value);
    }
    if (key === "sidecarAutoUpdate" && typeof value === "boolean") {
      return this.plugin.updateSetting("sidecarAutoUpdate", value);
    }
  }
}

class AnnotationExportModal extends Modal {
  private bundles: AnnotationBundleInfo[] = [];
  private readonly selected = new Set<string>();
  private filter = "";
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private exportButton!: HTMLButtonElement;
  private busy = false;

  constructor(private readonly plugin: LumenPdfPlugin) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("lumod-export-modal");
    this.titleEl.setText("Export PDF annotations");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Select the PDFs to export. Each PDF gets its own markdown note with its highlights, associated notes, and page references." });
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "Filter PDFs by name or path", cls: "lumod-export-search" });
    search.setAttribute("aria-label", "Filter PDFs to export");
    search.addEventListener("input", () => { this.filter = search.value.toLowerCase().trim(); this.renderList(); });
    const toolbar = this.contentEl.createDiv({ cls: "lumod-export-toolbar" });
    this.countEl = toolbar.createSpan();
    const selectMatches = toolbar.createEl("button", { text: "Select all matches", cls: "lumod-export-quiet-button" });
    selectMatches.addEventListener("click", () => {
      for (const bundle of this.visibleBundles()) this.selected.add(bundle.folder);
      this.renderList();
    });
    const clear = toolbar.createEl("button", { text: "Clear", cls: "lumod-export-quiet-button" });
    clear.addEventListener("click", () => { this.selected.clear(); this.renderList(); });
    this.listEl = this.contentEl.createDiv({ cls: "lumod-export-list" });
    this.listEl.setAttribute("role", "group");
    this.listEl.setAttribute("aria-label", "Annotated PDFs");
    this.statusEl = this.contentEl.createDiv({ cls: "lumod-export-status" });
    const footer = this.contentEl.createDiv({ cls: "lumod-export-footer" });
    this.exportButton = footer.createEl("button", { text: "Export selected", cls: "mod-cta" });
    this.exportButton.addEventListener("click", () => void this.exportSelected());
    this.renderList("Finding annotated PDFs…");
    try {
      // Persist pending edits in open readers without rebuilding large snapshots.
      for (const leaf of this.plugin.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) {
        if (leaf.view instanceof LumenPdfView) await leaf.view.flushAnnotationJournal();
      }
      this.bundles = await listAnnotationBundles(this.plugin.app.vault);
      this.renderList();
    } catch (error) {
      this.renderList("Could not find annotations. Check the developer console.");
      console.error("Lumen could not list annotation bundles", error);
    }
  }

  private visibleBundles(): AnnotationBundleInfo[] {
    if (!this.filter) return this.bundles;
    return this.bundles.filter(bundle => `${bundle.manifest.originalName} ${bundle.manifest.workingPath}`.toLowerCase().includes(this.filter));
  }

  private renderList(message?: string): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const visible = this.visibleBundles();
    this.countEl.setText(`${this.selected.size} selected · ${this.bundles.length} available`);
    this.exportButton.disabled = this.busy || this.selected.size === 0;
    if (message || this.bundles.length === 0) {
      this.listEl.createEl("p", { text: message ?? "No annotated PDFs were found in this vault.", cls: "lumod-export-empty" });
      return;
    }
    if (!visible.length) {
      this.listEl.createEl("p", { text: "No PDFs match this filter.", cls: "lumod-export-empty" });
      return;
    }
    // Keep the modal cheap even when the vault has many annotated PDFs.
    for (const bundle of visible.slice(0, 150)) {
      const row = this.listEl.createEl("label", { cls: "lumod-export-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(bundle.folder);
      checkbox.disabled = this.busy;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(bundle.folder);
        else this.selected.delete(bundle.folder);
        this.countEl.setText(`${this.selected.size} selected · ${this.bundles.length} available`);
        this.exportButton.disabled = this.selected.size === 0;
      });
      const text = row.createSpan({ cls: "lumod-export-row-text" });
      text.createSpan({ cls: "lumod-export-name", text: bundle.manifest.originalName });
      text.createSpan({ cls: "lumod-export-path", text: bundle.manifest.workingPath });
    }
    if (visible.length > 150) this.listEl.createEl("p", { text: `Showing the first 150 of ${visible.length} matches. Filter to browse more, or select all matches.`, cls: "lumod-export-empty" });
  }

  private async exportSelected(): Promise<void> {
    if (this.busy || this.selected.size === 0) return;
    this.busy = true;
    this.renderList();
    const chosen = this.bundles.filter(bundle => this.selected.has(bundle.folder));
    let exported = 0;
    const failures: string[] = [];
    for (const bundle of chosen) {
      this.statusEl.setText(`Exporting ${exported + failures.length + 1} of ${chosen.length}: ${bundle.manifest.originalName}`);
      try {
        await exportAnnotationBundle(this.plugin.app.vault, bundle);
        exported++;
      } catch (error) {
        failures.push(bundle.manifest.originalName);
        console.error(`Lumen could not export ${bundle.manifest.workingPath}`, error);
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    this.busy = false;
    this.renderList();
    this.statusEl.setText(`${exported} PDF${exported === 1 ? "" : "s"} exported to ${STORAGE_FOLDER}/exports/${failures.length ? ` · ${failures.length} failed` : ""}`);
    new Notice(this.statusEl.textContent ?? "Export complete.", failures.length ? 8000 : 5000);
  }
}
