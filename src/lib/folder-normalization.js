/**
 * Unicode normalization and validation for folder display names.
 *
 * Requirements:
 * - Allow arbitrary Unicode, international characters, spaces, punctuation.
 * - Sibling comparison uses NFKC + trimmed + lowercase normalization.
 * - Reject empty or whitespace-only names.
 * - Reject dangerous control characters (\u0000-\u001F, \u007F-\u009F).
 * - Enforce reasonable length limits (max 100 characters).
 */

export const MAX_FOLDER_NAME_LENGTH = 100;

// Matches control characters except nothing (all \u0000-\u001F and \u007F-\u009F)
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Validates and normalizes a folder display name.
 * @param {string} rawName
 * @returns {{ valid: boolean, error?: string, displayName?: string, normalizedName?: string }}
 */
export function validateAndNormalizeFolderName(rawName) {
  if (typeof rawName !== "string") {
    return { valid: false, error: "Folder name must be a string." };
  }

  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Folder name cannot be empty." };
  }

  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      valid: false,
      error: `Folder name cannot exceed ${MAX_FOLDER_NAME_LENGTH} characters.`,
    };
  }

  if (CONTROL_CHARS_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: "Folder name cannot contain control characters.",
    };
  }

  // Unicode NFKC normalization for display (retains case and character intent)
  const displayName = trimmed.normalize("NFKC");

  // Normalized key for sibling uniqueness comparison: NFKC + lowercase
  const normalizedName = displayName.toLowerCase();

  return {
    valid: true,
    displayName,
    normalizedName,
  };
}
