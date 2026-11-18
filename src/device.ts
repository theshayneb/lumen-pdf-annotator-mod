import { App, Platform } from "obsidian";

/*
 * What is kept on this device only, in Obsidian's per-vault local storage,
 * and never synced: this device's id, whether it runs background tasks, and
 * Sync's state as far as it can be told.
 */

const DEVICE_ID_KEY = "pdf-annotator:device-id";
const BACKGROUND_KEY = "pdf-annotator:background-tasks";

/** After Obsidian starts, how long before Sync is assumed to have caught up at the earliest. */
const SETTLE_AFTER_START = 60_000;
/** How long the vault must be quiet (no file created, changed, deleted or renamed). */
const SETTLE_QUIET = 60_000;

let app: App | null = null;
let deviceId = "";
const startedAt = Date.now();
let lastVaultChange = 0;

/** A file name–safe device id: letters, digits and dashes. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{3,39}$/.test(value);
}

export function initDevice(theApp: App): void {
  app = theApp;
  const stored: unknown = theApp.loadLocalStorage(DEVICE_ID_KEY);
  if (isDeviceId(stored)) {
    deviceId = stored;
  } else {
    deviceId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    theApp.saveLocalStorage(DEVICE_ID_KEY, deviceId);
  }
}

/** This device's id, used in the names of the files only this device writes. */
export function currentDeviceId(): string {
  if (!deviceId) throw new Error("PDF Annotator's device id is not ready yet");
  return deviceId;
}

/**
 * Whether this device runs background tasks (sidecar updates, storage tidying,
 * recovery copies). On by default for desktop, off for phones and tablets.
 */
export function runsBackgroundTasks(): boolean {
  const stored: unknown = app?.loadLocalStorage(BACKGROUND_KEY);
  return typeof stored === "boolean" ? stored : Platform.isDesktopApp;
}

export function setRunsBackgroundTasks(value: boolean): void {
  app?.saveLocalStorage(BACKGROUND_KEY, value);
}

/** Called on every vault change, so background work can wait for Sync to go quiet. */
export function noteVaultChange(): void {
  lastVaultChange = Date.now();
}

/** Whether the core Sync plugin says it is syncing right now. Undocumented, so guarded. */
function syncReportsSyncing(): boolean {
  try {
    const sync = (app as unknown as { internalPlugins?: { getPluginById?: (id: string) => { enabled?: boolean; instance?: { syncing?: unknown } } | null } } | null)
      ?.internalPlugins?.getPluginById?.("sync");
    return Boolean(sync?.enabled && sync.instance?.syncing === true);
  } catch {
    return false;
  }
}

/**
 * Whether Obsidian Sync has likely caught up: Obsidian has been open a minute,
 * no file has changed for a minute (Sync writes what other devices did as file
 * changes), and Sync, where it says so, isn't syncing.
 */
export function syncSettled(now = Date.now()): boolean {
  if (now - startedAt < SETTLE_AFTER_START || now - lastVaultChange < SETTLE_QUIET) return false;
  return !syncReportsSyncing();
}

/** "Waiting for Sync to finish", for the settings status line. */
export function syncStatusText(): string {
  return syncSettled() ? "Sync is quiet" : "waiting for Sync to finish";
}

const HASH_CACHE_KEY = "pdf-annotator:file-hashes";
const HASH_CACHE_LIMIT = 2_000;

interface HashCacheEntry {
  mtime: number;
  size: number;
  hash: string;
  /** When it was last used, to keep the most recent entries. */
  used: number;
}

function hashCache(): Record<string, HashCacheEntry> {
  const stored: unknown = app?.loadLocalStorage(HASH_CACHE_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, HashCacheEntry> : {};
}

/** A PDF's content hash remembered on this device, if the file hasn't changed since. */
export function cachedFileHash(path: string, mtime: number, size: number): string | null {
  const entry = hashCache()[path];
  return entry && entry.mtime === mtime && entry.size === size && typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash) ? entry.hash : null;
}

/** Remembers a PDF's content hash on this device (never in the synced vault). */
export function rememberFileHash(path: string, mtime: number, size: number, hash: string): void {
  if (!app) return;
  const cache = hashCache();
  cache[path] = { mtime, size, hash, used: Date.now() };
  const entries = Object.entries(cache);
  const kept = entries.length > HASH_CACHE_LIMIT
    ? Object.fromEntries(entries.sort((a, b) => (b[1].used ?? 0) - (a[1].used ?? 0)).slice(0, HASH_CACHE_LIMIT))
    : cache;
  app.saveLocalStorage(HASH_CACHE_KEY, kept);
}
