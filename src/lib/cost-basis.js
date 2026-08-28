/** Unknown and legacy values stay estimates; precision must be explicit. */
export function costBasisForGeneration({ costBasis }) {
  return costBasis === "reconciled" ? "reconciled" : "estimated";
}
