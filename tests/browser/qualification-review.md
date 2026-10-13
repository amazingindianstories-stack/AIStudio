# E targeted browser coverage changes

`library.spec.mjs`: one new real pointer folder `dragTo` case. It moves a global
folder containing a child into a second global folder, observes Django's PATCH,
checks committed parent/version and preserved child linkage, reloads, expands
the destination/subtree, and verifies the resulting breadcrumb. The final harness
`--trace on` retains its trace; the case attaches a success screenshot.

`django-backend.spec.mjs`: native MOV download now uses the MediaCard's visible
download link after hover and UI search, rather than an injected anchor. The
existing MOV signature/MIME/range and exact SHA256 assertions remain. A success
screenshot is attached. Run the final harness with `--trace on` to retain the
MediaCard trace as well.

Both JavaScript files passed `node --check`. Browser execution is pending the
coordinator's integrated isolated qualification; no harness was started here.
No UI changes or new dependencies. Browser ZIP magic-byte coverage remains;
archive names and byte hashes are qualified by the backend suite.

`protocol-boundaries.spec.mjs` adds real loopback HTTP chunked JSON with no
Content-Length, specific body-validation proof and unchanged project inventory,
plus four single/double-encoded protected-path cases through Next/Django.
