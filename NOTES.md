# Veevee accessibility batch (branch fm/veevee-audit-a11y)

Every finding below was re-checked against the current code (main moved past 86bbfbbb) and its evidence still held. Each DS/FE pair is fixed once.

Verification run for the batch: `npm test` (1658 pass, 0 fail) and `npm run lint` (clean). The Playwright specs listed below were added or updated and pass `node --check`, but were NOT executed here: the sandbox has no Django environment and no Playwright browser install. Run `scripts/dev/test-db.sh PYTHON scripts/dev/browser-harness.py --grep <name>` in CI or locally before merging. axe is driven through the already-locked `axe-core` package (now an explicit devDependency, same 4.13.0) via `tests/browser/axe.mjs`; `@axe-core/playwright` is not installed in the repo and was not added.

## DS-001 / FE-013: viewport disables pinch zoom
- Changed: removed `maximumScale: 1` from `src/app/layout.jsx` (kept `width` and `initialScale`). Login inputs use `text-base sm:text-sm` so iOS does not auto-zoom.
- Covering test: `tests/browser/phone-layouts.spec.mjs` "viewport allows zoom" (meta content has no maximum-scale, axe `meta-viewport` is clean at 390 and 1440). Not executed here.
- Evidence: `grep -n maximumScale src/app/layout.jsx` returns nothing.

## DS-002 / FE-003: library card semantics
- Changed: `MediaCard` root is a labelled `role="group"`, with a real `<button data-card-open>` as the first child carrying the roving tabindex and open logic; checkbox, More actions and favourite are siblings. `aria-selected` and `aria-haspopup` removed from the root. `data-*` hooks kept; AssetGrid focuses `[data-card-open]`.
- Covering test: `src/components/MediaCard.a11y.test.js`; browser axe in `tests/browser/library.spec.mjs` (zero `aria-allowed-attr` and `nested-interactive` on `.media-card`). Existing browser specs now focus the open button.
- Evidence: `npm test` passes the new file. Browser axe not executed here.

## DS-003 / FE-011: low-contrast small text
- Changed: `muted` (white at 62%) and `faint` (50%) colour tokens in `tailwind.config.js`; `text-white/30|35|40` on text nodes replaced by `text-muted` in the files the findings list (HistoryPanel, MediaCard, DetailModal, CardContextMenu, DestinationPickerModal, FolderTree, ComposerControls, AgentModelPicker, UpscaleSettings, AdminDashboard) plus every other 9-10px line the new guard found (18 lines in other components). 9px raised to 10px; FolderTree counts and MediaCard captions to 11px. Icons, borders, separators, placeholders and disabled controls keep their opacity.
- Covering test: `src/lib/contrast.test.js` (fails with file:line when 9-10px text uses white/30-40); axe `color-contrast` in the `library.spec.mjs` axe test (library with a queued row, View settings, viewer). The login labels already use `text-muted`.
- Evidence: contrast test passes. White at 62% over #101013 is about 7.6:1 by calculation. Browser axe not executed here.
- Deviation: lines outside the listed files were touched only where the guard required it.

## DS-010 / FE-012: login labels (and the rest of FE-012)
- Changed: login `htmlFor`/`id` pairs, `aria-describedby="login-error"` and `id="login-error" role="alert"` on the error. Sidebar "All generations" no longer overrides its name with "All assets" (`SidebarItem` sets `aria-label` and `title` to the visible label). "+ New folder" aria-label is now "New folder". Composer attach dropdown has `label="Attach references"` with the visible caption `aria-hidden`. AssetLibrary search has `aria-label="Search materials"`, clear button `aria-label="Clear search"` and `type="button"`, editor name and description labels are tied to their fields with `useId()`.
- Covering tests: `src/app/login/page.test.js`, `HistoryPanel.test.js` ("All generations" present, "All assets" absent), `PromptComposer.test.js` ("Attach references"). Browser specs that clicked "All assets", "material" or "+ New folder" were updated to the new names.
- Deviation: `SidebarItem` keeps `aria-label={label}` instead of dropping it, so the name stays the label without the count and existing exact-name selectors keep working. The Material Type and Material Sheet captions are not labels of one input, so they are a `role="group"` heading and a plain span.

## FE-008: confirmation dialog focus while busy
- Changed in the shared `useModalFocus` work (commit 646890ed): the effect no longer re-runs when `busy` or `onCancel` change, focus falls back to the dialog when Cancel is disabled, and focus is pulled back on `focusin`.
- Covering test: `src/components/ConfirmActionDialog.test.js` (focus stays inside while the action is pending, returns to the opener after close). Passes.

## FE-009: DetailModal dialog semantics and focus
- Changed: `role="dialog" aria-modal="true" aria-label` and `tabIndex={-1}` on the viewer panel, focus managed by `src/components/useModalFocus.js` (also used by AssetLightbox, AssetLibrary and the confirm dialog), restore to the opener card.
- Covering tests: `src/components/useModalFocus.test.js`; `tests/browser/viewer-navigation.spec.mjs` "viewer is a modal dialog" (Enter opens, 20 Tabs stay inside, Escape returns to the card). Browser spec not executed here.

## FE-010: Dropdown role
- Changed: `Dropdown` takes `role` (default "menu"); trigger `aria-haspopup` follows it ("dialog" or "true") and non-menu panels skip menuitem arrow handling. View settings uses `role="dialog"`, the thumbnail slider has `aria-label="Thumbnail size"` and `aria-valuetext`. The TopBar identity block is `role="presentation"`.
- Covering test: `HistoryPanel.test.js` (dialog "View settings" holds the slider "Thumbnail size", no empty `role="menu"`); axe `aria-required-children` in the `library.spec.mjs` axe test (not executed here).

## FE-016: clip picker and audio modal
- Changed: `VideoRefPicker` and `AudioTranscriptionModal` use `useModalFocus` with `role="dialog" aria-modal aria-labelledby`, Escape, Tab trap and focus restore; `useComposerCollapse` ignores focus moves into `[role="dialog"]`.
- Covering tests: `VideoRefPicker.test.js`, `AudioTranscriptionModal.test.js`, `useModalFocus.test.js`. Pass.
- Deviation: the hook lives at `src/components/useModalFocus.js` (shared with FE-009) rather than `src/hooks/`.

## FE-033: portrait lightbox buttons
- Changed: `type="button"` and aria-labels on every icon button in `PortraitLightbox`.
- Covering test: `PortraitLightbox.test.js` (`Next portrait` button resolves, every button has a name and type). Passes.

## FE-034: drop zones, model tabs, depth error
- Changed: drop zones in Depth, Upscaler and VideoUpscaler composers are `role="button"` with `tabIndex=0` and Enter/Space opening the file chooser; model tabs have `aria-pressed`; depth error has `role="alert"`.
- Covering test: `src/components/DropZones.a11y.test.js`. Passes. The axe pass on the Upscale and Depth tabs is not covered by a browser spec.
