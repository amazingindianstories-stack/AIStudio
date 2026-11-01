# Board templates

A template library, blueprints and "save as template" on canvas boards. Templates are board graphs
(format v1, unchanged), so nothing here changes how a board is stored or synced.

## Library

Shipped templates and blueprints are defined in code (`backend/apps/canvas/template_catalog.py`)
with refs `builtin:<slug>` and `blueprint:builtin:<slug>`. Custom templates are `BoardTemplate` rows
(graph plus a `preview` of normalised rectangles for thumbnails); the service layer is
`backend/apps/canvas/templates.py` and the routes are `api/canvas-templates*` and
`api/canvas-blueprints*`. Server stamps (createdBy, updatedAt and similar) are stripped from every
snapshot. Media inside a template is copied under `canvas/templates/<id>/` and is never deleted, so
boards made from a template keep working after the template is removed.

Access levels: personal (owner only), project (members of the project) and everyone. Saving a board
or a selection of it as a template needs edit rights on that board, and a blueprint needs edit rights on every board it includes.
Only an admin shares a template or blueprint with everyone, and only a member of a project shares one
with that project; the save dialog offers only the levels the person may use, and editing details
leaves the level and project alone unless the person changes them. Only an admin may mark a template
featured. Delete is soft, and the picker shows an undo toast. Likes, feedback
comments and usage counts are keyed by the template ref. Usage insights (counts per template) are
admin only at `api/admin/template-usage`.

## Using a template

The picker (`TemplatePicker.jsx`) opens from the toolbar Templates button, the board menu ("New
board from template"), tool panels (sticky notes and shapes list matching templates) and the
`?template=<ref>` deep link. A template can be added pre-filled or blank. Insertion is one undo
step (`editBoard`) with fresh ids, remapped parent, group, connector and tag references, and a size
check against the 2 Mi board cap (`MAX_BOARD_UNITS`) before anything is applied. Cmd/Ctrl+Delete
clears the text, tags and emoji votes of the selected sticky notes, text and shapes as one undo step;
other selected objects (frames, images and their children) stay as they are.

"Show this picker on every new board" is a personal preference in `localStorage`
(`veevee.canvas.showTemplatePicker`), not board data.

## Saving templates

Save the whole board or the current selection (frame children and internal connectors included),
or create one from scratch. Create from scratch and "Edit content" use an ordinary board named
"Template: <name>" linked by `BoardTemplate.board_id`; opening it switches to the project the board
lives in and lists it in the board switcher. "Save to template" in the banner syncs it back. Because it is a board, collaborative editing inherits board access and roles.

## Depends on other work

Format templates (`defaultView`), recorded walkthroughs, table and mind map tool shortcuts and the
AI side of intelligent templates are stored or shown on the template side only, and take effect
when the owning feature lands.
