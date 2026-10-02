# Veevee V1 — Free-Form Hierarchical Library System
## Complete Implementation Instructions for Antigravity

### ROLE

Act as a senior full-stack software architect, React and Next.js engineer, PostgreSQL database architect, application security engineer, and quality assurance lead.

You are working directly inside the existing Veevee V1 repository.

Your assignment is to design, implement, integrate, migrate, and comprehensively test a free-form, Finder-inspired hierarchical folder system.

The system must accommodate arbitrary user-created organizational structures without imposing predefined folder categories, hierarchy templates, or mandatory project membership.

This is a complete development objective, not a request to produce only an implementation plan.

**Important: All development must happen on a separate Git branch. Do not merge, push, release, or deploy anything. Deployment instructions will be provided separately after the completed implementation has been reviewed.**

Do not prioritize implementation speed. Prioritize correctness, reliability, maintainability, user experience, data integrity, security, and comprehensive validation.

Avoid unnecessary rewrites of unrelated functionality.

---

# PHASE 0 — SOURCE CONTROL AND REPOSITORY INSPECTION

## 0.1 Mandatory Git isolation

Before modifying the repository, inspect its Git state.

Run the equivalent of:

    git status
    git branch --show-current

Identify the current branch, uncommitted changes, untracked files, and relevant repository instructions.

Create and switch to a new branch:

    feat/freeform-hierarchical-library

Create it from the current intended development baseline, preserving existing work.

If this branch name already exists, inspect it and select an appropriate alternative rather than overwriting existing work.

If uncommitted changes prevent safe branch creation, preserve the work and report the specific blocker. Never discard, overwrite, stash, or reset someone's existing work without authorization.

All implementation commits must remain on the feature branch.

Do not modify, merge into, or reset the main branch.

Do not push the feature branch unless explicitly instructed.

Do not create a pull request automatically.

Do not deploy application changes or database migrations to production, staging, preview infrastructure, or any other shared remote environment.

Local development and disposable test databases are permitted.

At completion, report the exact branch name, commits, working-tree state, and outstanding changes.

## 0.2 Read the existing architecture

Before proposing changes, inspect the actual repository.

Read `AGENTS.md` and follow its instructions.

Inspect the relevant source files, including these where present:

- `package.json`
- `src/lib/schema.js`
- `src/lib/projects-db.js`
- `src/lib/store-db.js`
- `src/lib/store.js`
- `src/lib/feed-scope.js`
- `src/lib/history-query.js`
- `src/lib/feed-cache.js`
- `src/lib/auth.js`
- `src/components/ProjectPanel.jsx`
- `src/components/HistoryPanel.jsx`
- `src/components/PromptComposer.jsx`
- `src/components/ComposerControls.jsx`
- `src/app/api/projects/route.js`
- `src/app/api/history/route.js`
- `src/app/api/history/counts/route.js`
- `src/app/api/queue/execute/route.js`
- `scripts/verify-production-schema.js`

Inspect all related components, server routes, workers, generation callbacks, export handlers, tests, and database migration scripts.

Search for every location that reads or modifies project IDs, folder IDs, generation locations, folder selections, and generation storage references.

If `Veevee_hierarchical_library_architecture.md` exists, use it as supplementary architectural context, but apply the free-form organization requirements in this prompt wherever the documents conflict.

Verify any historical assumptions against the current source code.

Produce an internal integration map before making significant changes.

## 0.3 Important existing risks

Investigate whether the current implementation has the following problems:

1. Folder operations accepting project identifiers without independently validating ownership or relationships.
2. Generation moves accepting unverified destination combinations.
3. Bulk moves using separate non-atomic requests.
4. Generation lifecycle operations overwriting newer organizational changes with stale records.
5. Optimistic UI operations failing to handle unsuccessful HTTP responses correctly.
6. Components assuming that all folders are flat or must belong to a project.

Reproduce confirmed problems with tests before repairing them.

Preserve existing authorization rules unless a change is required to close a verified security vulnerability.

Do not print, copy into documentation, or commit credentials and other secrets from the repository.

---

# PHASE 1 — PRODUCT AND DATA MODEL

## 1.1 Fundamental requirement: completely free-form organization

Users must be free to create their own folder structures.

There must be no mandatory folder naming convention, organizational template, predefined hierarchy, or required number of nested levels.

The following are equally valid:

Example A:

    Global Library
    |
    |-- Anime
    |   |-- Characters
    |   |   |-- Character A
    |   |   |-- Character B
    |
    |-- Videos
    |
    |-- Experiments
    |
    |-- Unsorted

Example B:

    Global Library
    |
    |-- Work
    |   |-- October
    |   |   |-- Client A
    |   |   |-- Client B
    |
    |-- Personal
    |
    |-- Unsorted

Example C:

    Global Library
    |
    |-- Projects
    |   |-- Project A
    |   |   |-- Characters
    |   |   |-- Final Renders
    |
    |-- My Folder
    |
    |-- Unsorted

These examples illustrate possible user organization only.

Do not hardcode them.

A user may create a single folder, hundreds of folders, or deeply nested folders. A folder may contain generations, other folders, both, or neither.

Users must also be able to organize generations without creating a project.

Existing project functionality must remain available but optional.

## 1.2 Logical locations

Implement the following logical location types:

1. Global library root.
2. Global folders.
3. Project root.
4. Project folders.
5. Global Unsorted.
6. Project Unsorted.
7. Existing aggregate history and project views.

A global folder belongs to the global library rather than a project.

A project folder belongs to a particular project.

Both may contain arbitrary nested folders and generations.

The global library should make global folders and existing projects accessible without forcing one into the other's hierarchy.

Projects are optional organizational containers, not mandatory ancestors of every folder.

Avoid ambiguous root locations.

Use explicit destination types in internal APIs rather than treating special locations as ordinary database folder IDs.

## 1.3 Unsorted must remain separate

Unsorted is a virtual organizational location.

It must not be implemented as a regular, editable folder.

Preserve:

- Global Unsorted: generations without a project or folder.
- Project Unsorted: generations assigned to a project but not a folder.

Preserve the existing Global History and All in Project aggregate behavior, independently of Unsorted.

Do not interpret a null folder ID as necessarily meaning Global Unsorted. Its meaning also depends on the generation's project assignment.

Users may create ordinary folders with names similar to virtual locations. Distinguish virtual locations internally by identity and type, not solely by their displayed names.

Virtual locations cannot be renamed, deleted, or accidentally reparented.

## 1.4 Permanent generation identity

Every generation retains its permanent UUID.

Its identity must never depend on:

- Folder name.
- Folder path.
- Project name.
- Project membership.
- Download filename.
- Position within the hierarchy.

Preserve the existing media storage architecture.

Reorganizing a generation or its parent folders must not require physically moving, copying, or renaming the underlying media objects.

All folder operations should primarily affect organizational metadata.

Preserve generation lineage, metadata, thumbnails, provider references, and source assets.

---

# PHASE 2 — DATABASE ARCHITECTURE

Design a robust normalized relational model compatible with the existing PostgreSQL and Drizzle architecture.

## 2.1 Folder representation

Extend the existing folders model.

Each folder should have:

- Immutable UUID.
- Nullable project ID.
- Nullable parent folder ID.
- User-defined display name.
- Normalized name key where required for uniqueness.
- Creation timestamp.
- Modification timestamp.
- Necessary hierarchy and concurrency metadata.

Interpret the relationships as follows:

A null project ID indicates global scope.

A non-null project ID indicates membership in an existing project.

A null parent ID indicates that the folder is at the root of its current scope.

A non-null parent ID identifies an existing folder.

Children must belong to the same scope as their parent.

Do not use textual filesystem paths as primary identifiers.

## 2.2 Folder relationships and database integrity

The database and server must jointly enforce the following invariants:

- Every folder has at most one parent.
- Every referenced parent exists.
- Parent and child scopes agree.
- Every project-scoped folder references a valid project.
- No folder is its own ancestor.
- No generation references a nonexistent folder.
- Every generation's project assignment is consistent with its folder's scope.
- Global generations in global folders must not retain contradictory project membership.
- Project generations in project folders must have the corresponding project assignment.

Pay particular attention to PostgreSQL foreign-key behavior involving nullable columns.

Do not assume that a conventional composite foreign key automatically enforces all global-scope relationships when its constituent columns contain null values.

Use appropriate constraints, indexes, database triggers, transactional validation, or another demonstrably correct mechanism.

Document which invariants are enforced by the database and which depend on application logic.

## 2.3 Folder naming

Folder display names are user-defined.

Do not impose automatic naming patterns or reserved organizational categories.

Support ordinary Unicode names, spaces, punctuation, and names in different languages.

Allow identical folder names in different parent folders.

Prevent ambiguous duplicate sibling names within the same scope, using a documented normalization and comparison policy.

Choose a consistent Unicode normalization policy. Do not introduce aggressive transformations that unexpectedly change legitimate display names.

Reject invalid empty names and dangerous control characters.

Enforce reasonable database and interface resource limits, but do not impose arbitrary naming conventions for a future export feature.

Keep display names separate from future filesystem-safe download filename generation.

Handle concurrency when two clients attempt to create or rename folders to the same sibling name.

Address root-level uniqueness separately for global and project scopes.

## 2.4 Nesting

Support user-controlled nesting.

Do not impose the previously proposed fixed 12-level product restriction.

Protect the system using configurable operational safeguards against resource exhaustion, pathological recursion, extremely large mutation requests, and excessive query complexity.

Determine practical limits through implementation and testing.

Document safeguards and ensure their behavior is consistent across APIs and the UI.

Prefer iterative graph traversal or otherwise demonstrably bounded algorithms where appropriate.

## 2.5 Generation location and concurrency

Every generation must have one authoritative organizational location.

Its project and folder relationship must remain valid after every mutation.

Introduce generation location versioning or another robust optimistic concurrency mechanism.

An asynchronous generation-processing update must not overwrite a user's newer organizational changes.

Separate lifecycle fields from organization fields.

Do not use broad, stale record replacements that inadvertently restore obsolete folder assignments.

Preserve unrelated generation metadata during every move.

---

# PHASE 3 — MOVEMENT AND ORGANIZATION ENGINE

Implement centralized server-side operations for all organizational changes.

Do not duplicate folder-management business logic across numerous API routes.

## 3.1 Supported folder operations

Implement:

- Create a global root folder.
- Create a project root folder.
- Create a subfolder.
- Rename a folder.
- Move a folder within its current hierarchy.
- Move a folder to another valid scope.
- Delete an empty folder.
- Retrieve folder children.
- Retrieve folder ancestry.
- Retrieve the appropriate folder tree.
- Retrieve generations assigned directly to a folder.

Moving folders across global and project scopes must be explicitly supported.

For example, moving a global folder into a project should update the scope of that folder, its descendants, and the generations contained anywhere within that subtree.

Moving a project folder to the global root should similarly update the whole subtree to global scope.

Moving a folder from one project to another must preserve the subtree and reconcile every contained generation's project membership.

These must be intentional atomic operations, not a series of independent client requests.

If a proposed subtree move exceeds an operational safety limit, reject it cleanly without changing anything.

Never silently split a move into partially successful operations.

## 3.2 Prevent invalid operations

The server must reject:

- Moving a folder into itself.
- Moving a folder into its descendants.
- Any operation that would create a cycle.
- Invalid destinations.
- Stale version-dependent operations.
- Unauthorized mutations.
- Conflicting concurrent operations.
- Mutations exceeding documented operational safeguards.

Do not rely on client-side validation for security.

Structural validation must occur against authoritative database state inside the transaction.

## 3.3 Generation moves

Implement:

- Move one generation.
- Move multiple selected generations.
- Move generations between folders.
- Move generations between projects.
- Move generations from project folders into global folders.
- Move generations from global folders into project folders.
- Move generations into project Unsorted.
- Move generations into Global Unsorted.

Destination resolution must be authoritative.

Use explicit destination descriptors, such as typed global root, project root, folder, and Unsorted destinations.

Reject invalid combinations rather than silently guessing what the client intended.

Never trust an independently submitted project ID when the target folder already establishes its scope.

## 3.4 Transactional integrity

All multi-record moves must be atomic.

A folder-subtree move must either complete entirely or leave the entire subtree unchanged.

The same rule applies to bulk generation moves.

Use transactions and a documented locking strategy.

Establish deterministic lock acquisition to reduce deadlocks.

Account for concurrent structural changes, including opposing moves of different folders that might otherwise create a cycle.

Implement operation idempotency for retryable mutations.

A retry after a lost network response must not execute an already committed operation a second time.

Where useful, use expected versions to detect stale requests and return explicit conflict responses.

## 3.5 Deletion

For this release, folder deletion must be nonrecursive.

Reject deletion of folders containing child folders or generations.

Do not automatically transfer their contents into Unsorted.

Do not introduce destructive recursive deletion.

Existing project-deletion behavior must be reviewed and made compatible with nested folders.

Prevent silent loss of generations and hierarchy metadata.

## 3.6 Auditability

Record sufficient metadata to investigate significant organizational changes.

Include operation identity, affected record identifiers, source and destination, and available authenticated actor information.

Avoid recording secrets, unnecessary personal information, or entire generation payloads.

Audit logging must not become an additional consistency risk.

---

# PHASE 4 — FINDER-INSPIRED USER INTERFACE

Build a free-form, Finder-inspired file organization interface using the project's existing React architecture and design conventions.

The UI should be intuitive without forcing users into any particular organizational model.

## 4.1 Primary navigation

The interface should clearly expose:

- Global Library.
- User-created global folders.
- Existing projects.
- Folders belonging to each project.
- Global Unsorted.
- Project Unsorted.
- Existing aggregate views.

Users should be able to navigate their chosen organizational hierarchy naturally.

Avoid treating the project list as the only possible starting point.

Do not create duplicate mandatory organizational categories.

Preserve access to existing project features.

## 4.2 Folder tree

Implement a reusable folder-tree component supporting:

- Arbitrary user-defined structures.
- Expand and collapse.
- Nested visual indentation.
- Selection.
- Folder creation.
- Subfolder creation.
- Renaming.
- Moving.
- Empty-folder deletion.
- Drag-and-drop.
- Keyboard navigation.
- Loading and error states.

The displayed tree must derive from authoritative folder relationships.

Prefer normalized folder state over maintaining multiple independently mutable nested copies.

Handle very broad folder trees without making the interface unresponsive.

Do not eagerly load every generation in a large hierarchy.

## 4.3 Main content area

When a user selects a folder, display its immediate child folders and directly contained generations.

Do not automatically flatten all descendants into the selected folder's contents.

Allow folders and generations to coexist in the same view.

Use the application's existing generation cards where practical.

Preserve existing relevant filtering, selection, and history functionality.

Make empty folders useful and visually understandable.

## 4.4 Breadcrumb navigation

Implement dynamic breadcrumbs based on folder ancestry.

For example:

    Global Library > Anime > Characters > Character A

Or:

    Project A > Assets > Final

Each ancestor should be navigable.

Breadcrumbs must update correctly when folders or their ancestors are renamed or moved.

Do not use cached textual paths as the authoritative hierarchy.

Handle deeply nested breadcrumbs gracefully.

## 4.5 Folder creation and renaming

Support creating a folder in the currently selected valid location.

Support creating subfolders using a context menu or equivalent action.

Provide an accessible rename interface.

Perform suitable client-side validation, but always repeat authoritative validation server-side.

Handle duplicate sibling names, stale selections, and concurrent conflicts without losing the user's input unnecessarily.

## 4.6 Drag-and-drop

Support dragging generations and folders onto valid destinations.

Differentiate a generation move from a folder-subtree move.

Clearly identify valid and invalid drop targets.

Support moves across global and project scopes.

Ensure project scope transitions are understandable when moving an entire folder containing generations.

Provide visual feedback for pending operations.

Do not show an operation as completed until the server confirms success.

On failure, reconcile with authoritative server state rather than retaining a fictional optimistic result.

Prevent accidental duplicate submissions.

## 4.7 Destination picker

Provide a destination-selection dialog as an alternative to dragging.

The dialog should expose available global and project destinations, their nested folders, and explicit Unsorted targets.

Prevent invalid folder-subtree destinations from being selected.

Allow users to navigate extensive folder hierarchies.

Keep the destination picker reusable across generation management and relevant existing workflows.

## 4.8 Multiselection

Preserve existing generation multiselection.

Users should be able to select multiple generations and move them together.

Use the atomic bulk-move API.

If a batch is invalid, report the problem clearly and preserve the original state of every generation.

Do not replace one atomic batch operation with independent client requests.

## 4.9 Accessibility and responsiveness

Support keyboard-only navigation and operations.

Use appropriate accessible tree and menu semantics.

Provide visible focus states.

Do not require drag-and-drop for essential functionality.

Support narrow desktop windows and long folder names.

Avoid excessive rendering and unnecessary network requests.

Reuse existing project styling and component patterns wherever practical.

---

# PHASE 5 — EXISTING APPLICATION INTEGRATION

The new library must be integrated into the entire existing application.

Do not implement it as an isolated demonstration screen.

Inspect and update every relevant component and endpoint that currently assumes a flat folder structure or mandatory project membership.

## 5.1 Generation creation

Users should be able to choose the organizational destination for new generations where the existing interface supports that behavior.

Allow generation creation without requiring a project.

Correctly support global folders, project folders, and applicable Unsorted locations.

The selected location must determine the appropriate project and folder assignment.

Avoid ambiguous destinations.

Do not allow client-side virtual identifiers to be stored as ordinary database folder IDs.

## 5.2 Generation lifecycle

Review queue processing, provider callbacks, retry handling, generation completion, failure handling, and worker recovery.

A generation must remain in its newly selected folder even if a delayed provider callback arrives with outdated organizational information.

Write targeted tests for this behavior.

Do not accidentally change existing generation execution semantics or provider integrations.

## 5.3 History and cached state

Integrate the hierarchy with:

- Global History.
- Project views.
- Folder views.
- Existing pagination.
- Search.
- Favorites.
- Feed caches.
- Asset selectors.
- Existing generation-card actions.

Preserve existing aggregate views.

Ensure scope changes invalidate or reconcile all affected views.

Prevent stale client caches from making moved generations appear permanently in their previous folders.

Avoid introducing N+1 database queries.

## 5.4 Other integrations

Search for and update relevant integrations with:

- Image generation.
- Video generation.
- Generation continuation and retries.
- Canvas.
- Prompt Composer.
- Existing project management.
- Existing download and export mechanisms.

Preserve existing media URLs, thumbnails, metadata, and source-generation relationships.

Do not redesign the application's underlying media storage.

---

# PHASE 6 — DATABASE MIGRATION

Implement a safe additive migration from the current flat folder architecture.

Follow all repository-specific migration instructions, particularly those in `AGENTS.md`.

Do not execute database migrations automatically during normal application deployment.

## 6.1 Migration preflight

Create a read-only preflight auditor.

It should identify:

- Existing projects and folders.
- Existing generations.
- Global and project Unsorted counts.
- Existing folder relationships.
- Orphaned references.
- Project-folder inconsistencies.
- Duplicate names under the proposed uniqueness rules.
- Data that would violate the proposed constraints.
- Other anomalies requiring explicit remediation.

Produce a human-readable report with no secret values.

Do not silently repair questionable existing data.

## 6.2 Additive schema migration

Preserve all existing IDs and generation metadata.

Existing project folders should initially become root-level folders within their current projects.

Existing project memberships and generation-folder assignments should remain unchanged.

Introduce nullable project ownership for global folders without changing existing project-folder identities.

Introduce parent references and required database constraints.

Ensure the new schema supports both global and project folder hierarchies.

Handle old constraints, indexes, and foreign keys that assume all folders necessarily belong to projects.

Address any existing invalid data before applying constraints that would reject it.

## 6.3 Test the actual migration

Do not rely only on creating a fresh database with the final schema.

Construct an isolated database using the actual previous schema and representative legacy records.

Apply the migration.

Verify:

- Existing identities survive.
- Existing generations remain accessible.
- Existing folders retain their memberships.
- Existing global and project Unsorted behavior remains unchanged.
- Existing media references remain unchanged.
- New global folders can be created.
- New nested folders can be created.
- New integrity constraints behave correctly.

Test migration idempotency.

Document the compatibility boundary between the old and new application versions.

## 6.4 Verification and rollback planning

Update production schema-verification tooling to validate hierarchy-critical schema objects and invariants.

Prepare a deployment and rollback runbook.

Distinguish disabling new functionality from reverting a deployed application.

If the previous application cannot safely read newly created global folders or hierarchy relationships, explicitly document that limitation and prepare a compatible fallback strategy.

Do not claim that reverting to the old application is safe unless it has been tested.

Do not build a destructive rollback that removes user-created hierarchies.

**Important: prepare migration scripts and deployment documentation, but do not execute migrations against production, staging, or other shared environments.**

Deployment authorization will be provided separately.

---

# PHASE 7 — SECURITY AND ADVERSARIAL TESTING

Testing is a central requirement of this assignment.

The objective is to deliberately reproduce failures, repair them, and prove that the corrected implementation behaves properly.

Follow a RED/GREEN testing process.

For existing defects, write and execute regression tests against the original implementation wherever practical.

Record the initial failure.

Apply the repair.

Run the same test again and demonstrate that it passes.

For new functionality, first establish tests describing the required behavior, observe their initial failure, implement the functionality, and repeat them.

Never weaken assertions merely to make the test suite pass.

## 7.1 Folder attack scenarios

Test attempts to:

1. Move a folder into itself.
2. Move a folder into one of its descendants.
3. Simultaneously move two folders in ways that would create a cycle.
4. Create invalid parent-child relationships.
5. Create contradictory global and project ownership.
6. Move a large subtree between projects while another client modifies it.
7. Create duplicate sibling names concurrently.
8. Exploit Unicode-equivalent naming collisions.
9. Delete a nonempty folder.
10. Submit malformed identifiers.
11. Exceed operational resource safeguards.
12. Trigger unbounded recursion.
13. Submit unauthorized folder operations.

Verify database state after every relevant attempt.

## 7.2 Generation integrity scenarios

Test:

1. Moving a generation while its provider request is running.
2. Receiving a stale completion callback after a move.
3. Receiving duplicate callbacks.
4. Simultaneously moving the same generation from different sessions.
5. Moving generations between global and project folders.
6. Moving generations between projects.
7. Moving generations into project Unsorted.
8. Moving generations into Global Unsorted.
9. Supplying a forged project identifier with an otherwise valid folder.
10. Retrying an operation after its response was lost.
11. Submitting duplicate generation IDs in one batch.
12. Triggering a failure midway through a large batch.
13. Attempting unauthorized generation relocation.
14. Confirming unrelated generation fields never change during organizational operations.

All invalid operations must fail without corrupting data.

## 7.3 Folder-subtree migration scenarios

Test folder moves between:

- Global folders.
- Global root and global subfolders.
- Global folders and project folders.
- One project and another project.
- Project folders and project roots.

Verify all descendant folder scopes and directly or indirectly contained generation assignments.

Deliberately inject a transaction failure after some internal updates have executed.

Prove the entire transaction rolls back.

Test concurrent modifications during subtree moves.

Test retrying a successfully committed move.

## 7.4 Unsorted scenarios

Confirm that:

- Global Unsorted contains only generations with no project and no folder.
- Project Unsorted contains only generations belonging to that project without a folder.
- All in Project includes all relevant project generations.
- Global History preserves its original intended scope.
- Ordinary folders cannot accidentally become virtual Unsorted locations.
- Moves between Unsorted and ordinary folders do not lose generations.

## 7.5 UI failure scenarios

Test:

- A destination folder is deleted during dragging.
- A selected folder is moved by another browser session.
- A folder is renamed while its descendant is selected.
- A destination becomes invalid before a request commits.
- An HTTP request fails.
- A request commits but the network response is lost.
- A user switches projects during an active mutation.
- A user submits the same operation multiple times.
- A user selects many generations.
- A user navigates using only the keyboard.
- A user creates and navigates unusually broad and deep hierarchies.

Ensure the interface never displays an unconfirmed operation as permanently successful.

## 7.6 Security testing

Test:

- SQL-injection-like input in names and request parameters.
- Path traversal strings.
- Unsafe control characters.
- Unicode normalization collisions.
- Malformed request bodies.
- Excessive request sizes.
- Unauthorized mutations.
- Stale version conflicts.
- Cross-scope reference forgery.
- Concurrency and deadlock behavior.
- Resource exhaustion safeguards.
- Sensitive information exposure through errors or audit logs.

Preserve legitimate user naming freedom while protecting application integrity.

## 7.7 Randomized testing

Implement reproducible randomized or property-based tests involving folder creation, renaming, movement, and generation relocation.

Check organizational invariants after every operation.

Preserve failing random seeds so failures can be reproduced.

Include adversarial combinations of global and project scopes.

## 7.8 Performance testing

Use representative large datasets.

Test broad and deep folder hierarchies.

Verify that tree construction, ancestry resolution, folder navigation, generation pagination, bulk moves, and scope changes remain reliable.

Avoid unnecessary whole-library downloads and N+1 database queries.

Do not claim performance characteristics without measurements.

---

# PHASE 8 — FUTURE AUTOMATIC NAMING COMPATIBILITY

Do not implement the automatic naming system in this development phase.

However, design the folder architecture so that a subsequent phase can introduce it without redesigning organizational storage.

The future system may derive downloadable filenames from arbitrary user-created folder paths.

For example:

    anime_characters_0001.png

Or:

    work_october_client_a_0038.mp4

These examples are not naming conventions users must follow.

The future naming system must be able to handle:

- Arbitrary user-defined folder names.
- Arbitrary hierarchy depth.
- Folder renaming.
- Folder-subtree movement.
- Individual generation movement.
- Global and project folder scopes.
- Concurrent serial-number allocation.
- Filename collisions.
- Unsafe filesystem characters.
- Long hierarchy paths.
- Bulk exports.
- Stable generation identities.

A future move may result in a different derived download filename without affecting the underlying media object.

Do not implement serial allocation, automatic renaming, or physical media relocation now.

Produce a separate technical design describing how this functionality can be introduced later.

Keep naming metadata separate from permanent generation identity.

---

# PHASE 9 — IMPLEMENTATION EXECUTION ORDER

Use the following sequence.

### Stage A — Baseline

Inspect the repository and its instructions.

Create and switch to the isolated feature branch.

Document all integration points.

Run existing tests and record baseline results.

Identify confirmed defects.

### Stage B — Existing integrity repairs

Create failing regression tests for verified existing defects.

Repair destination validation, lifecycle-update races, and incorrect optimistic error handling.

Demonstrate passing regression tests.

### Stage C — Database foundation

Implement the revised folder schema, global and project scopes, database constraints, migration preflight, additive migration, and verification tooling.

Validate against the legacy schema in an isolated database.

### Stage D — Centralized organization engine

Implement authoritative folder and generation mutations.

Add transactional subtree moves, atomic bulk moves, locking, idempotency, and concurrency protection.

Execute integration and adversarial tests.

### Stage E — Finder-style interface

Implement the folder tree, main content view, breadcrumbs, context menus, dialogs, destination picker, drag-and-drop, and keyboard interactions.

Integrate global folders and existing projects without imposing mandatory hierarchy.

### Stage F — Application integration

Update every affected generation workflow, history query, asset selector, project feature, cache, and export integration.

Verify that moving generations does not interfere with generation execution.

### Stage G — Comprehensive qualification

Run all relevant regression, migration, adversarial, randomized, UI, accessibility, and performance tests.

Repair discovered defects.

Document unresolved environmental blockers and their exact reproduction procedures.

### Stage H — Final review

Inspect the complete diff for accidental unrelated changes, debug artifacts, security problems, and migration hazards.

Prepare the deployment documentation without deploying.

Provide the final implementation and testing report.

---

# PHASE 10 — REQUIRED DELIVERABLES

Complete the implementation and create appropriate documentation within the existing repository structure.

Deliver:

1. The complete hierarchical library implementation.
2. The integrated Finder-inspired UI.
3. The updated database schema.
4. Safe additive migration scripts.
5. Migration preflight and verification tooling.
6. The centralized organizational mutation service.
7. Transactional and concurrency protections.
8. Existing application integration changes.
9. Automated regression and adversarial tests.
10. Reproducible randomized tests.
11. Relevant UI and accessibility tests.
12. Migration, deployment, and rollback documentation.
13. A security review.
14. A future automatic-naming architecture document.
15. A detailed implementation completion report.

Include a test matrix identifying VERIFIED, FAILED, BLOCKED, and NOT RUN results.

Record actual test commands and evidence.

Do not report success for tests that were not executed.

Do not use a passing test suite as proof of production migration safety unless the actual legacy migration path was also tested.

---

# PHASE 11 — ACCEPTANCE CRITERIA

Consider the development objective complete only when:

1. Users can create arbitrary global and project folder structures without mandatory predefined categories.
2. Existing project functionality remains operational and optional.
3. Every folder can contain generations and nested folders.
4. Users can navigate and reorganize their hierarchies through the integrated interface.
5. Global and project Unsorted locations remain logically distinct.
6. Existing generations retain their identities and media references.
7. Existing projects, folders, and generations survive the additive migration.
8. Global and project ownership relationships remain consistent.
9. Folder cycles and invalid parent relationships are prevented.
10. Folder-subtree movement preserves all descendant relationships and contained generations.
11. Generation bulk moves are atomic.
12. Concurrent operations cannot silently corrupt organization state.
13. Delayed generation callbacks cannot restore obsolete organizational locations.
14. Destructive operations cannot silently orphan or delete generations.
15. Existing generation, history, Canvas, selection, and export workflows remain operational.
16. The new interface supports accessible non-drag alternatives.
17. Relevant regression, adversarial, migration, and UI tests pass.
18. Outstanding blockers and unverified behavior are explicitly documented.
19. Future naming can be introduced without restructuring generation identities or physical media storage.
20. All changes remain isolated on the feature branch.

---

# PHASE 12 — STRICT DEPLOYMENT BOUNDARY

This is a development and validation assignment only.

You are explicitly prohibited from:

- Deploying the application.
- Executing migrations against production or staging.
- Pushing commits to a remote repository.
- Opening or merging a pull request.
- Merging into the main branch.
- Modifying production data.
- Changing production environment variables.
- Enabling this functionality for existing production users.
- Running any external generation workflow that incurs charges unless specifically authorized.

You may use local development services and disposable test databases.

If validation requires unavailable infrastructure, prepare the executable validation procedure and document the blocker.

Do not interpret permission to prepare deployment scripts as permission to execute them.

When implementation and locally available validation are complete, stop.

Do not continue automatically into deployment.

Wait for my separate deployment instructions.

---

# FINAL RESPONSE FORMAT

At the end of execution, provide:

**1. Git branch and source-control state**

State the exact feature branch, relevant commits, and any uncommitted changes.

**2. Implementation summary**

Explain what changed in the database, backend, UI, and existing integrations.

**3. Architecture decisions**

Document important decisions about global folders, projects, movement semantics, concurrency, and data integrity.

**4. Red/green test evidence**

Identify the defects reproduced, the tests that initially failed, the repairs applied, and the final results.

**5. Migration status**

Summarize local migration tests, legacy data preservation, schema verification, and rollback readiness.

**6. Security findings**

Report confirmed vulnerabilities, implemented protections, unresolved risks, and any remaining security tests.

**7. Completion matrix**

List all implementation stages and acceptance criteria with evidence-based completion status.

**8. Future naming readiness**

Explain what is ready for the future filename system and what remains to be implemented.

**9. Deployment preparation**

List prerequisites, prepared scripts, known risks, and the precise actions that will require deployment authorization.

End with the following explicit status statement, using the appropriate verified values:

    Feature branch: <branch>
    Development: <verified status>
    Local validation: <verified status>
    Migration readiness: <verified status>
    Deployment: NOT STARTED
    Awaiting deployment authorization: YES

Do not deploy, merge, or push.

Await further instructions after delivering the implementation and validation report.
