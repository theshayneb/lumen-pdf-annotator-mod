import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { importSource } from "./support/build.mjs";

let m;
before(async () => { m = await importSource("sync-merge.ts"); });

const DAY = 86_400_000;
const highlight = (id, updatedAt, extra = {}) => ({
  id, kind: "text", page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: `quote ${id}`,
  note: "", tags: [], color: "#ffd43b", style: "highlight", createdAt: 1_000, updatedAt, ...extra,
});
const put = annotation => ({ op: "put", annotation });
const remove = (id, at) => ({ op: "remove", id, at });
const mergeAll = (...sources) => {
  const merge = new m.AnnotationMerge();
  for (const source of sources) for (const entry of source) merge.apply(entry);
  return merge;
};

describe("annotation merge", () => {
  it("does not let an offline tablet's stale copy undo a newer desktop edit", () => {
    const desktop = [put(highlight("a", 100)), put(highlight("a", 300, { color: "#4dabf7" }))];
    // The tablet still has the old yellow copy, plus one real edit made offline.
    const tablet = [put(highlight("a", 100)), put(highlight("b", 200))];
    for (const merge of [mergeAll(desktop, tablet), mergeAll(tablet, desktop)]) {
      assert.equal(merge.annotations.get("a").color, "#4dabf7");
      assert.ok(merge.annotations.has("b"), "the tablet's own highlight is kept");
    }
  });

  it("never brings a deleted highlight back from an old copy", () => {
    const desktop = [put(highlight("a", 100)), remove("a", 300)];
    const tablet = [put(highlight("a", 100))];
    for (const merge of [mergeAll(desktop, tablet), mergeAll(tablet, desktop)]) {
      assert.equal(merge.annotations.has("a"), false);
      assert.equal(merge.tombstones.get("a"), 300);
    }
  });

  it("keeps an edit made after the deletion", () => {
    const merge = mergeAll([remove("a", 300)], [put(highlight("a", 400, { note: "kept" }))]);
    assert.equal(merge.annotations.get("a").note, "kept");
  });

  it("breaks ties the same way on every device", () => {
    const one = [put(highlight("a", 500, { color: "#ff8787" }))];
    const two = [put(highlight("a", 500, { color: "#63e6be" }))];
    assert.equal(mergeAll(one, two).annotations.get("a").color, mergeAll(two, one).annotations.get("a").color);
    // A deletion at the same moment as an edit wins either way.
    assert.equal(mergeAll(one, [remove("a", 500)]).annotations.has("a"), false);
    assert.equal(mergeAll([remove("a", 500)], one).annotations.has("a"), false);
  });

  it("writes the same snapshot text whatever order the files were read in", () => {
    const a = [put(highlight("a", 100)), remove("c", 50)];
    const b = [put(highlight("b", 200))];
    assert.equal(m.serializeSnapshot(mergeAll(a, b)), m.serializeSnapshot(mergeAll(b, a)));
  });

  it("drops a device's journal lines only when the snapshot holds them and they are a week old", () => {
    const now = 100 * DAY;
    const snapshot = mergeAll([put(highlight("old", now - 10 * DAY)), put(highlight("recent", now - DAY))]);
    const entries = [
      put(highlight("old", now - 10 * DAY)),
      put(highlight("recent", now - DAY)),
      put(highlight("missing", now - 10 * DAY)),
    ];
    const drop = m.trimmableEntries(entries, snapshot, now);
    assert.deepEqual([...drop].map(entry => entry.annotation.id), ["old"]);
  });
});

describe("palette merge", () => {
  const normalize = color => color.toLowerCase();

  it("keeps the newest color name from any device, and old 1.0.x names only as the oldest layer", () => {
    const legacy = { names: { "#ffd43b": { value: "Old", at: 0 } }, extras: {} };
    const tablet = { names: { "#ffd43b": { value: "Tablet", at: 50 } }, extras: {} };
    const desktop = { names: { "#ffd43b": { value: "Desktop", at: 100 } }, extras: {} };
    assert.equal(m.paletteView(m.mergePalettes([legacy, desktop, tablet]), 12).names["#ffd43b"], "Desktop");
    assert.equal(m.paletteView(m.mergePalettes([legacy]), 12).names["#ffd43b"], "Old");
  });

  it("records only what changed, so an unchanged save writes nothing", () => {
    const merged = m.mergePalettes([{ names: { "#ffd43b": { value: "Key", at: 10 } }, extras: { "#ff8787": { on: true, at: 10, added: 10 } } }]);
    const own = m.emptyPalette();
    assert.equal(m.recordPaletteEdit(own, merged, 12, { names: { "#ffd43b": "Key" }, extras: ["#ff8787"] }, 99), false);
    assert.deepEqual(own, m.emptyPalette());
  });

  it("syncs a cleared name and a removed color", () => {
    const merged = m.mergePalettes([{ names: { "#ffd43b": { value: "Key", at: 10 } }, extras: { "#ff8787": { on: true, at: 10, added: 10 } } }]);
    const own = m.emptyPalette();
    assert.equal(m.recordPaletteEdit(own, merged, 12, { names: {}, extras: [] }, 99), true);
    const view = m.paletteView(m.mergePalettes([merged, own]), 12);
    assert.deepEqual(view.names, {});
    assert.deepEqual(view.extras, []);
  });

  it("reads back what it writes", () => {
    const own = { names: { "#ffd43b": { value: "Key", at: 10 } }, extras: {}, order: { value: ["#ffd43b"], at: 5 }, layout: { value: "callout", at: 6 } };
    assert.deepEqual(m.readPaletteFile(JSON.parse(m.serializePalette(own)), normalize), own);
  });
});

describe("settings merge", () => {
  it("takes a setting another device changed later, and keeps one changed here later", () => {
    const memory = { pdfTheme: "dark", interfaceTheme: "light" };
    const disk = { pdfTheme: "sepia", interfaceTheme: "dark" };
    const { values } = m.mergeSettings(memory, { pdfTheme: 10, interfaceTheme: 50 }, disk, { pdfTheme: 20, interfaceTheme: 30 });
    assert.deepEqual(values, { pdfTheme: "sepia", interfaceTheme: "light" });
  });

  it("keeps a timed setting when an older version writes back a stale value under the same time", () => {
    const { values } = m.mergeSettings({ pdfTheme: "dark" }, { pdfTheme: 40 }, { pdfTheme: "light" }, { pdfTheme: 40 });
    assert.equal(values.pdfTheme, "dark");
  });

  it("takes a change an older version made without a time", () => {
    const { values } = m.mergeSettings({ pdfTheme: "dark" }, {}, { pdfTheme: "sepia" }, {});
    assert.equal(values.pdfTheme, "sepia");
  });
});
