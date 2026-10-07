# Changelog

All notable changes to Lumen PDF Annotator Mod are documented here. Entries from 1.0.19 and earlier come from the upstream Lumen PDF Annotator.

## Mod 1.0.19 — 2026-10-07

- A highlight across a page break is now one annotation: one card in the panel with a page range header (e.g. "p. 4–5"), one entry in the sidecar, and one editor for its note and tags. Highlights split by earlier versions are joined automatically when the PDF opens (keeping any note or tags).
- Exports no longer repeat the same text for each page of a multi-page annotation.

## Mod 1.0.18 — 2026-10-07

- Fixed highlights that cross a page break covering both entire pages. The selection's boxes now come only from the selected text, not from the page layers the selection passes over. Existing highlights with whole-page boxes are cleaned up when they load.

## Mod 1.0.17 — 2026-10-07

- After a manual sidecar export, the sidecar note opens in a new tab (or its existing tab is brought forward). Automatic updates don't open it.

## Mod 1.0.16 — 2026-10-07

- Sidecar notes are italic: `- ["] *note*`.

## Mod 1.0.15 — 2026-10-07

- Exporting a color-grouped sidecar now opens **Order sidecar headings**, where you can move each color heading up or down before exporting. The order is saved per PDF (in its bundle) and used for automatic sidecar updates; **Default order** restores "important" first, then named colors alphabetically, then the palette.

## Mod 1.0.14 — 2026-10-07

- Sidecar tags always go on the highlight line (before the page link), whether or not there is a note.

## Mod 1.0.13 — 2026-10-07

- Sidecar color headings are shown in their highlight color.
- Notes are written as a nested `- ["] note` item under their highlight instead of inline; tags go on the note when there is one. Page references read `pg. 3`.
- A color named "important" (any capitalization) is always listed first, in the sidecar and in the panel's **Color** sort.

## Mod 1.0.12 — 2026-10-06

- Annotation cards show the highlighted text first, styled the same whether or not there is a note; the note follows below in regular weight.
- The annotations panel opens automatically when a PDF opens (except on phones). Turn this off with **Open the annotations panel automatically** in settings.

## Mod 1.0.11 — 2026-10-06

- New sidecar entry format: one bullet per annotation, `- highlighted text *-- note* #tags *(p. 3)*`, where the page reference links to the annotation in the PDF. The note part appears only when there is a note. Multi-line text and notes are joined into one line.

## Mod 1.0.10 — 2026-10-06

- Fixed tags being wiped: when the inspector's editor and the floating editor were both open on one annotation, typing a note in one saved its stale (often empty) tags over the tags entered in the other. Each field now saves on its own.
- Inspector cards show an annotation's tags.
- Sidecar: no blank lines between the highlighted text, the annotation bullet, and the **Open in PDF** link.

## Mod 1.0.9 — 2026-10-06

- Sidecar tags are back: they're written at the end of the annotation bullet when there is one, otherwise at the end of the highlighted text. Spaces in tags become hyphens (`#to-read`) so Obsidian recognizes them.
- The sidecar's **Open in PDF** link is now a nested quote: `> > [Open in PDF](…)`.

## Mod 1.0.8 — 2026-10-06

- New sidecar layout: a link to the PDF, a rule, then a `#` heading per color (or page) with `> Page N: quote`, a `*` bullet for the annotation when there is one, and an **Open in PDF** link. Tags, the title, and the color key are no longer written.
- Sidecar frontmatter is now a single property, `lumen-pdf: "<pdf path>"`. Sidecars written by earlier versions are still recognised and rewritten in the new format.
- New **Interface theme** setting, Dark by default: the toolbar, panels, and editors are dark while PDF pages keep the PDF theme (Light by default). Choose **Match PDF theme** for the previous behavior.
- "Colour" is now spelled "Color" throughout the interface.

## Mod 1.0.7 — 2026-10-05

- Made colour naming easier to find: a labelled **Colour names** button now sits in the All / Highlights / Notes row. Right-clicking (or long-pressing) a colour chip opens the same window, and so does the **Name highlight colours for this PDF** command.

## Mod 1.0.6 — 2026-10-05

- Per-PDF colour names: use the tag button next to the colour chips to name each highlight colour (e.g. yellow → "friends") for the open PDF only. Names are stored with that PDF's annotations, appear on colour chips and cards, sort first under **Colour** sort, and are used in sidecar headings with a colour key. Other PDFs keep their own names, or the defaults.

## Mod 1.0.5 — 2026-10-05

- Plugin storage moved from `.lumen-pdf-mod/` to `Dashboard/` (annotation bundles, file index, exports, and recovered PDFs). Each PDF's annotations are copied from `.lumen-pdf-mod/` (or the original plugin's `.lumen-pdf/`) the first time it is opened. The old folder is never modified, so it can be deleted once every annotated PDF has been opened. PDFs not yet reopened can still be exported, and their recovery copies can still be restored, from the old folder.

## Mod 1.0.4 — 2026-10-05

- Sidecar notes are now saved in the vault root (`Smith 2024.md`) instead of beside the PDF. If that name is taken by your own note or by another PDF's sidecar, `Smith 2024 2.md`, `3`, … is used instead. Sidecars now record their PDF in a `lumen-pdf-path` property. Sidecars written beside PDFs by earlier versions are left where they are.

## Mod 1.0.3 — 2026-10-05

- Fixed the annotation inspector's scrollbar jumping back to the top while scrolling.

## Mod 1.0.2 — 2026-10-05

- The annotation inspector now sorts by page by default.
- Fixed unreadable annotation and search cards on hover with themes whose hover colour is near-white; cards now tint their own background instead.

## Mod 1.0.1 — 2026-10-05

- Releases are now published automatically: every push to `main` builds the plugin and creates (or updates) the GitHub release and tag for the version in `manifest.json`, so BRAT can install and update it.

## Mod 1.0.0 — 2026-10-05

- Forked as a separate plugin, **Lumen PDF Annotator Mod** (`lumen-pdf-annotator-mod`). It has its own storage (`.lumen-pdf-mod/`), view type, link scheme (`obsidian://lumen-pdf-mod`), and CSS namespace, so it can't collide with the original. When the fork first opens a PDF, it copies that PDF's existing annotations from the original plugin's storage. It never writes to the original's storage.
- Annotation inspector: the colour filter now shows a chip with a count for each colour, including imported colours. Click a chip again to clear the filter. Added a **Colour** sort option, and cards now show their colour name.
- Sidecar Markdown export: writes `<PDF name>.md` next to the PDF from the inspector button or the **Export annotations to sidecar Markdown note** command. You can group it by page or by colour, and optionally keep it updated automatically. The export never overwrites notes it didn't create, and it keeps text written below its end marker.

## 1.0.19 — 2026-09-25

- Improved PDF outline heading validation so body mentions, printed contents rows, running headers, and text from separate columns are less likely to be mistaken for the heading itself.
- Matched full headings more reliably across wrapped lines, ligatures, and accented text while keeping the PDF's original bookmark titles and hierarchy.
- Kept the table of contents hidden for PDFs without navigable bookmarks and preserved the original bookmark destination when a nearby heading cannot be confirmed.

## 1.0.16 — 2026-09-22

- Wrapped long table-of-contents headings while reserving their page-number column.
- Removed the table-of-contents hover tooltips while keeping its search, close control, and heading rows accessible.
- Restored the saved PDF page only after its reader is ready and visible, including cold starts that open another note in a new tab. Reader-position and settings writes now share a serialized, merged save path so one cannot erase the other.

## 1.0.15 — 2026-09-21

- Added a floating, searchable table of contents for PDFs that provide an outline, with source hierarchy indentation and muted physical page numbers that match the editor toolbar.
- Resolved direct and named PDF destinations to their exact page and within-page coordinates, including XYZ, FitH, FitV, and FitR destinations.
- Corrected stale outline destinations by checking for the exact heading on the declared page and a bounded nearby range; navigation keeps the target page in view and falls back to the PDF destination when no exact heading is found.
- Kept the outline button hidden for PDFs without a navigable outline and made search, outline, and annotation panels coordinate cleanly on desktop and mobile.
- Replaced the three theme buttons with one compact current-theme icon and a Light, Sepia, and Dark menu.
- Deferred outline loading until the reader is ready, with cached page resolution, bounded concurrency, cooperative yielding, and deferred row rendering for large outlines.

## 1.0.12 — 2026-09-02

- Enabled installation on iOS and Android without changing the established desktop reader path.
- Added phone and tablet layouts with fit-to-width startup, safe-area-aware toolbars and bottom sheets, keyboard-aware annotation editing, native touch selection capture, and long-press annotation menus.
- Kept mobile and desktop page/zoom state separate so synchronized plugin data cannot transfer a phone scale into a desktop reader.
- Added mobile-specific canvas, search-cache, inspector-overscan, dense-mark, and near-page limits, plus background render cancellation and journal flushing.
- Added PDF.js-managed mobile worker startup with its built-in loopback fallback for WebViews that reject direct worker creation.
- Kept search, annotation panels, and the individual editor above the mobile keyboard using Obsidian's native keyboard metrics with visual-viewport and conservative fallbacks, without re-fitting or re-rendering the PDF during keyboard animation.
- Kept the PDF reader visible behind keyboard-focused panels on Android WebViews that resize the Obsidian leaf, avoiding the large black region beneath Find in PDF and the annotation inspector.
- Replaced the ambiguous mobile theme dots with labelled Light, Sepia, and Dark controls.

## 1.0.11 — 2026-08-29

- Repaired release packaging with a valid dependency lockfile so automated reviews can resolve the existing TypeScript and Obsidian dependencies correctly.
- Restored GitHub provenance attestations for the JavaScript and CSS release assets.
- Made no source-code, stylesheet, feature, appearance, storage, or performance changes from 1.0.10.

## 1.0.10 — 2026-08-29

- Replaced stylesheet priority flags with scoped, higher-specificity equivalents while preserving every existing visual value and interaction state.
- Removed the final source-code review warning without changing the bounded PDF search-cache eviction behavior.
- Kept PDF.js network and base64 capabilities intact because stripping them could break valid documents; Lumen continues to load PDF bytes locally with auto-fetch and worker fetch disabled.

## 1.0.9 — 2026-08-28

- Added official ESLint tooling, PDF.js declarations, safer data normalization, and typed view-state restoration while preserving the existing runtime behavior and UI.
- Added declarative settings definitions for Obsidian settings search without changing the four existing settings, controls, or their appearance.
- Limited future release artifacts to `main.js`, `manifest.json`, and `styles.css`, with GitHub provenance attestations for the JavaScript and CSS artifacts.
- Made no runtime feature, performance architecture, or CSS changes in this review release.

## 1.0.8 — 2026-08-25

- Added an opaque, content-sized selected-text preview beneath the floating extension confirmation; only its text is muted, and long quotes wrap and grow vertically within a bounded surface.
- Supplied PDF.js's required text-layer scale factor so caret hit-testing, quote extraction, selection geometry, and extension previews remain aligned across zoom levels.
- Replaced proportional-character estimates with exact rendered text-range geometry for Find in PDF marks on visible pages, keeping the lightweight whole-document index for large-file performance.
- Centred short extension-preview surfaces beneath their confirmation controls while preserving content-sized growth for longer selections.
- Preserved narrow and zero-width PDF.js glyph-boundary rectangles when capturing selections, then safely coalesced adjacent fragments so punctuation remains part of the visible mark.
- Retained the page and zoom restoration introduced in 1.0.7 while correcting release metadata for both versions.

## 1.0.7 — 2026-08-25

- Remembered the last page and zoom level for each PDF and restored them when the document reopens.

## 1.0.6 — 2026-08-24

- Paused new page rendering during active scrolling and cancelled stale canvas and text-layer work as soon as a page leaves the render window.
- Replaced the FIFO page renderer with a direction-aware, visible-page-priority queue limited to one canvas job at a time.
- Added a low-resolution preview after scrolling settles, followed by an idle high-detail canvas and selectable text layer without replacing a ready canvas prematurely.
- Yielded PDF.js render continuations to animation frames so long page paints do not monopolize the interface thread.
- Reduced dense-mark DOM pressure, paced dense canvas overlays during scrolling, and delegated annotation pointer events from one page-container listener.
- Released canvas backing stores and PDF page resources during unmount, zoom, and teardown.
- Verified rapid forward and reverse scrolling in Obsidian with a synthetic 3,000-page PDF: no sampled frame exceeded 34 ms, with a worst sampled gap of 33 ms.

## 1.0.5 — 2026-08-24

- Removed the automatic vault-wide legacy-note scan from PDF open; legacy import is now an explicit command.
- Replaced eager per-page canvases, text layers, annotation layers, and listeners with batched lightweight page shells and delegated events.
- Limited normal viewport rendering to two concurrent page mounts and fixed off-screen teardown so canvases, PDF page proxies, text layers, render tasks, and hit indexes are actually released.
- Added a direct windowed recency index for the default annotation inspector, keeping visible-card lookup within a frame at 250,000 annotations.
- Added bounded least-recently-used PDF search text caching and cleanup of non-visible page resources.
- Added stable file metadata caching so unchanged PDFs are not re-hashed on every open.
- Made full PDF recovery copies optional, disabled them by default, and moved enabled copies off the document-open critical path.
- Replaced automatic close-time Markdown snapshot rebuilds with bounded journal flushes and faster compact JSON checkpoints.
- Added fallback from corrupt compact snapshots through the previous snapshot and legacy Markdown recovery data.
- Removed per-page zoom layout animations that scaled poorly with documents containing thousands of pages.
- Fixed the expanded inspector detail remaining open after its annotation was deleted.
- Verified the production bundle with a synthetic 3,000-page PDF, rare-match full-document search, rapid distant-page navigation, and 100,000/250,000-annotation workloads.

## 1.0.0 — 2026-08-23

- Initial public release.
- Added near-viewport PDF rendering with bounded canvas memory.
- Added direct page navigation, compact zoom controls, and light, sepia, and dark themes.
- Kept the selected PDF theme across Obsidian restarts and preserved the vault accent colour on plugin buttons across every PDF theme.
- Added cancellable contextual full-PDF search.
- Added highlight, underline, dashed underline, dotted underline, strike-through, box, comment, colour, note, tag, copy, and delete workflows.
- Changed the selection palette so colour and mark type can be chosen independently before an explicit Apply or Apply-and-note action; colour swatches remain visible on hover.
- Added exact on-page highlighting for PDF search matches, with a stronger marker for the opened result.
- Added right-click Markdown links that reopen and reveal an exact saved highlight.
- Added post-creation annotation extension on the same page or across PDF pages, stored as page-indexed segments under one logical annotation.
- Added click-to-place page notes and persistent PDF themes.
- Added a virtualized annotation inspector and individual annotation editor.
- Added inspector colour filters and newest, oldest, or page ordering.
- Added indexed annotation search, mutation-order sorting, dense-page canvas fallback, spatial mark hit-testing, and cooperatively yielded restore/journal/checkpoint work for six-figure workloads.
- Added local SHA-256 document bundles with Markdown snapshots, a recovery copy, an append-only journal, export, verification, restore, and compatible legacy import.
