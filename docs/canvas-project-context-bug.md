# Canvas Project Context Is Misleading

## Summary

The Canvas view displays a project dropdown in the asset panel, but that control only filters which project's assets are shown. It does not change the active project that owns the current canvas board.

This makes the UI appear internally inconsistent. For example, the asset panel can display `Shiv Sati` while the board dropdown still lists boards from `NAISHA - PRODUCTION` such as `Conn Test` and `Asset Test`.

## User Impact

- Users reasonably interpret the visible project name as the current canvas project.
- A board can exist in the selected asset project but remain invisible in the board dropdown.
- Users may think a board import or database sync failed.
- Creating a new board at this point adds it to the hidden active project, not necessarily the project named in the asset panel.
- There is no direct way to change the board-owning project while remaining in Canvas view.

## Current Behavior

1. `CanvasView` uses the global store's `activeProjectId` as the board-owning project.
2. `BoardSwitcher` requests boards using that `activeProjectId`.
3. `CanvasAssetPanel` maintains a separate persisted `scope` value.
4. Its dropdown can show any project name, including a project other than `activeProjectId`.
5. Changing this asset scope does not call `setActiveProject`.

The two project contexts are technically separate, but the interface does not communicate that distinction.

## Root Cause

The problem is primarily an information-architecture and control-labeling bug, not a database bug.

- Board ownership comes from `useStore((s) => s.activeProjectId)` in `CanvasView`.
- Asset filtering comes from local `scope` state in `CanvasAssetPanel`.
- `AssetScopeControl` labels a non-active asset scope with the project's plain name, such as `Shiv Sati`.
- Canvas view has no visible control for changing the real `activeProjectId`.

Relevant files:

- `src/components/canvas/CanvasView.tsx`
- `src/components/canvas/CanvasAssetPanel.tsx`
- `src/components/canvas/BoardSwitcher.tsx`
- `src/lib/store.ts`

## Proposed Fix

### 1. Add an explicit board-project selector

Add a project selector to the Canvas header beside the board selector. It must:

- Display the project that owns the current board.
- List projects from the global store.
- Call `setActiveProject(projectId)` when changed.
- Clear the current `boardId` immediately during the switch.
- Let `BoardSwitcher` load and select a board belonging to the new project.

Suggested control order:

`Board project: Shiv Sati` -> `Shiv Sati Storyboard (Synced)`

### 2. Clarify the asset filter

Rename the asset-panel control so it cannot be mistaken for board ownership.

Suggested labels:

- `Assets from: This project`
- `Assets from: Shiv Sati`
- `Assets from: All projects`

The asset filter should remain independent because using assets from another project is useful.

### 3. Harden project switching

When `activeProjectId` changes:

- Set Canvas `boardId` to `null` before loading the next board list.
- Clear stale board metadata from the previous project.
- Ignore late API responses for projects that are no longer active.
- Never display or load a board whose `projectId` differs from `activeProjectId`.
- Avoid auto-creating an empty board until the current project's board-list request has completed successfully.

### 4. Improve empty and loading states

During a project switch, show `Loading boards...` instead of the previous project's board name. If the project has no boards, show the existing new-board flow only after the correct project response is confirmed.

## Acceptance Criteria

- Canvas always shows the active board-owning project explicitly.
- Selecting `Shiv Sati` as the board project makes `Shiv Sati Storyboard (Synced)` appear without leaving Canvas view.
- Selecting another project replaces the board list with only that project's boards.
- The asset-source selector is visibly labeled as an asset filter.
- Selecting an asset source does not silently change board ownership.
- The selected board's `projectId` always equals the global `activeProjectId`.
- Rapid project switching cannot restore a stale board list from an earlier request.
- Creating a board always creates it under the project displayed by the board-project selector.
- Refreshing the page preserves a valid active project and opens one of that project's boards.

## Regression Tests

1. Start in `NAISHA - PRODUCTION`, open Canvas, and confirm only its boards are listed.
2. Change the board project to `Shiv Sati` and confirm `Shiv Sati Storyboard (Synced)` appears.
3. Set `Assets from` back to `NAISHA - PRODUCTION` and confirm the Shiv Sati board remains selected.
4. Rapidly switch board projects several times and confirm the final board list matches the final project.
5. Create a board and verify its database `project_id` matches the displayed board project.
6. Reload the browser and verify the selected board and project remain consistent.

## Current Workaround

1. Leave Canvas by clicking AI Image or AI Video.
2. Select the intended project in the Studio project selector.
3. Return to Canvas.
4. Open the board dropdown.

For the current Shiv Sati board, select the real `Shiv Sati` project before returning to Canvas. The asset panel's `Shiv Sati` filter alone is not sufficient.
