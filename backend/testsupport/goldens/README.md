# Frozen historical Node qualification outputs

These inert JSON files were captured in an isolated source copy with an empty
credential home, mock providers, and a dedicated local PostgreSQL database.
They preserve the pre-retirement Node comparison contract; they do not describe
current production state or authorize a production baseline.

`provenance.json` records the historical checkout revision and SHA-256 of every
source Node library/API/oracle file. Its canonical, sorted source mapping has a
separate SHA-256. Each output file records that revision/tree hash, the original
command as a non-executable provenance identifier, canonical JSON input, exact
stdout, and stdout SHA-256. The filename is the SHA-256 of canonical command and
input. `source-schema.json` contains the actual Drizzle-generated SQL and its
hash, independently captured before the business implementation was retired.

`testsupport.frozen_oracle` only reads fixtures. It never executes an embedded
command, falls back to an oracle, or manufactures missing expected values.
Unknown inputs and changed output/provenance hashes fail qualification.

Coverage includes schema columns/defaults/indexes/FKs/checks/invariant SQL,
provider requests and responses, model metadata, enqueue validation, reference
normalization, canvas data and JSON encoding, limits/throttle/pricing, filenames,
generation serialization, driver bigint bindings, and deterministic history
responses. Live Django EXPLAIN plans run against 5,006 managed fixture rows;
historical Node execution times are retained as provenance, not performance
thresholds. The old mixed-runtime HTTP harness remains inert under
`docs/django-migration/historical-oracles/`.

The remaining executable password oracle uses only Node crypto and has no
application imports, so randomly salted cross-language scrypt checks remain
independent. A standalone JavaScript Number probe likewise has no business-code
dependency. These fixtures should only change after independent review of the
intended contract, with new provenance and meaningful rejection controls.
