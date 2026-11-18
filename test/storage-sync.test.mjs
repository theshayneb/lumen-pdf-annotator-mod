import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { importSource } from "./support/build.mjs";

globalThis.window ??= globalThis;

/** An in-memory vault adapter that counts writes. */
class MemoryVault {
  files = new Map();
  writes = [];
  adapter = {
    exists: async path => this.files.has(path) || [...this.files.keys()].some(file => file.startsWith(`${path}/`)),
    read: async path => {
      if (!this.files.has(path)) throw new Error(`missing ${path}`);
      return this.files.get(path);
    },
    write: async (path, text) => { this.files.set(path, text); this.writes.push(path); },
    append: async (path, text) => { this.files.set(path, (this.files.get(path) ?? "") + text); this.writes.push(path); },
    list: async folder => {
      const files = new Set();
      const folders = new Set();
      for (const path of this.files.keys()) {
        if (!path.startsWith(`${folder}/`)) continue;
        const rest = path.slice(folder.length + 1).split("/");
        if (rest.length === 1) files.add(path);
        else folders.add(`${folder}/${rest[0]}`);
      }
      return { files: [...files], folders: [...folders] };
    },
    mkdir: async () => {},
  };
  getName() { return "Test"; }
}

/** A device: its own local storage, with background tasks on or off. */
function device(id, background) {
  const local = new Map([["pdf-annotator:device-id", id], ["pdf-annotator:background-tasks", background]]);
  return { loadLocalStorage: key => local.get(key) ?? null, saveLocalStorage: (key, value) => local.set(key, value) };
}

const FOLDER = "Utilities/PDF Annotator/bundles/sha256/" + "a".repeat(64);
const highlight = (id, updatedAt, extra = {}) => ({
  id, kind: "text", page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: `quote ${id}`,
  note: "", tags: [], color: "#ffd43b", style: "highlight", createdAt: 1_000, updatedAt, ...extra,
});

let storage;
let deviceModule;
before(async () => {
  // Storage and device code bundled together, so they share one device module.
  const mod = await importSource("../test/support/storage-entry.ts");
  storage = mod.storage;
  deviceModule = mod.device;
});

function repositoryOn(vault, app) {
  deviceModule.initDevice(app);
  return new storage.AnnotationRepository(vault, FOLDER, "a".repeat(64), "Book.pdf");
}

describe("annotations shared by three devices", () => {
  it("merges every device's own journal, so offline edits arriving late lose nothing", async () => {
    const vault = new MemoryVault();
    const desktop = repositoryOn(vault, device("desktop1", true));
    const tablet = repositoryOn(vault, device("tablet01", false));
    desktop.queue({ op: "put", annotation: highlight("a", 100) });
    desktop.queue({ op: "put", annotation: highlight("a", 300, { color: "#4dabf7" }) });
    await desktop.flushJournal();
    // The tablet, offline for days, made one highlight and still has the old yellow "a".
    tablet.queue({ op: "put", annotation: highlight("a", 100) });
    tablet.queue({ op: "put", annotation: highlight("b", 200) });
    await tablet.flushJournal();
    assert.ok(vault.files.has(`${FOLDER}/journal.desktop1.jsonl`));
    assert.ok(vault.files.has(`${FOLDER}/journal.tablet01.jsonl`));
    const index = await repositoryOn(vault, device("phone001", false)).load();
    assert.equal(index.get("a").color, "#4dabf7");
    assert.ok(index.get("b"));
  });

  it("reads what 1.0.x wrote (shared journal and snapshot) and keeps deletions deleted", async () => {
    const vault = new MemoryVault();
    vault.files.set(`${FOLDER}/annotations.snapshot.json`, JSON.stringify([highlight("old", 50), highlight("gone", 50)]));
    vault.files.set(`${FOLDER}/annotations.journal.jsonl`, `${JSON.stringify({ op: "put", annotation: highlight("legacy", 60) })}\n`);
    const phone = repositoryOn(vault, device("phone001", false));
    phone.queue({ op: "remove", id: "gone", at: 400 });
    await phone.flushJournal();
    const index = await repositoryOn(vault, device("desktop1", true)).load();
    assert.ok(index.get("old"));
    assert.ok(index.get("legacy"));
    assert.equal(index.get("gone"), undefined);
    // Nothing older versions wrote was rewritten.
    assert.ok(vault.files.has(`${FOLDER}/annotations.snapshot.json`));
    assert.ok(vault.files.has(`${FOLDER}/annotations.journal.jsonl`));
  });

  it("compacts only when the merged result changed, and never writes on load", async () => {
    const vault = new MemoryVault();
    const desktop = repositoryOn(vault, device("desktop1", true));
    desktop.queue({ op: "put", annotation: highlight("a", 100) });
    await desktop.flushJournal();
    vault.writes.length = 0;
    await desktop.load();
    await repositoryOn(vault, device("phone001", false)).loadPalette();
    assert.deepEqual(vault.writes, [], "loading and browsing write nothing");
    assert.equal(await desktop.compact(), true);
    assert.equal(await desktop.compact(), false, "unchanged data is not rewritten");
    assert.deepEqual(vault.writes, [`${FOLDER}/annotations.snapshot.v2.json`]);
  });

  it("checkpoints on a phone save only its own journal, never the snapshot", async () => {
    const vault = new MemoryVault();
    const phone = repositoryOn(vault, device("phone001", false));
    phone.queue({ op: "put", annotation: highlight("p", 100) });
    await phone.checkpoint();
    assert.deepEqual(vault.writes, [`${FOLDER}/journal.phone001.jsonl`]);
  });
});

describe("opening a PDF", () => {
  it("writes nothing until there is something to save", async () => {
    const vault = new MemoryVault();
    deviceModule.initDevice(device("phone001", false));
    const file = { path: "Book.pdf", name: "Book.pdf", stat: { mtime: 1, size: 3 } };
    const bundle = await storage.openBundle(vault, file, new Uint8Array([1, 2, 3]).buffer, true);
    await bundle.repository.load();
    await bundle.repository.loadPalette();
    assert.deepEqual(vault.writes, []);
    bundle.repository.queue({ op: "put", annotation: highlight("x", 10) });
    await bundle.repository.flushJournal();
    assert.ok(vault.files.has(`${bundle.folder}/manifest.json`));
    assert.ok(vault.files.has(`${bundle.folder}/journal.phone001.jsonl`));
  });
});

describe("palette shared by devices", () => {
  it("keeps the newest name per color across devices, over the old 1.0.x files", async () => {
    const vault = new MemoryVault();
    vault.files.set(`${FOLDER}/color-names.json`, JSON.stringify({ "#ffd43b": "Old name", "#4dabf7": "Definitions" }));
    const tablet = repositoryOn(vault, device("tablet01", false));
    const desktop = repositoryOn(vault, device("desktop1", true));
    deviceModule.initDevice(device("tablet01", false));
    await tablet.saveColorNames({ "#ffd43b": "Tablet name", "#4dabf7": "Definitions" });
    await new Promise(resolve => setTimeout(resolve, 5));
    await desktop.saveColorNames({ "#ffd43b": "Desktop name", "#4dabf7": "Definitions" });
    const names = (await repositoryOn(vault, device("phone001", false)).loadPalette()).names;
    assert.equal(names["#ffd43b"], "Desktop name");
    assert.equal(names["#4dabf7"], "Definitions");
    assert.equal(vault.files.get(`${FOLDER}/color-names.json`).includes("Old name"), true, "old file left alone");
  });

  it("writes nothing when a palette save changes nothing", async () => {
    const vault = new MemoryVault();
    const phone = repositoryOn(vault, device("phone001", false));
    await phone.saveColorOrder(["#ffd43b"]);
    vault.writes.length = 0;
    await phone.saveColorOrder(["#ffd43b"]);
    await phone.saveNoteLayout((await phone.loadPalette()).layout ?? "by-color");
    vault.writes.length = 0;
    await phone.saveNoteLayout("by-color");
    assert.deepEqual(vault.writes, []);
  });
});
