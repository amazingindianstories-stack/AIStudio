/** Board letter shortcuts stay out of text entry, dialogs and image cropping. */
export function isEditingTarget(target) {
  return Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) ||
    target?.closest?.('[data-crop-controls], [role="dialog"], [role="alertdialog"]'));
}
