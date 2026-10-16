// Tree rows keep their full width inside the sideways-scrolling folder tree, with the actions
// button pinned to the visible edge. Click the start of the folder name, as a person would; the
// centre of a long, indented row can sit under that pinned button.
export const openTreeFolder = (panel, name) =>
  panel.getByRole("treeitem").filter({ hasText: name }).getByText(name, { exact: true }).click({ position: { x: 8, y: 6 } });
