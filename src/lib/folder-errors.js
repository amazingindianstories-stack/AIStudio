export class OrganizationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status=400]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "OrganizationError";
    this.code = code;
    this.status = status;
  }
}
