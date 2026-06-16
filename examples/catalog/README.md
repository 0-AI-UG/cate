# Local example catalog

A self-contained catalog index for testing the extension catalog offline. It
advertises the `cate.hello` extension (see `../extensions/hello`).

## Files

- `index.json` — the catalog index. Its `artifactUrl` is a path relative to the
  app root (`./examples/catalog/cate.hello-0.1.0.tgz`), which Cate's local-source
  support resolves against `app.getAppPath()` in dev.
- `cate.hello-0.1.0.tgz` — the packaged Hello extension artifact.

## Producing the artifact

Regenerate the tarball from the Hello extension folder (run from the repo root):

```sh
tar -czf examples/catalog/cate.hello-0.1.0.tgz -C examples/extensions/hello .
```

The index intentionally omits `sha256` so the committed fixture stays stable
across tar versions. To pin a hash, add `"sha256": "<shasum -a 256 output>"` to
the entry.

## Using it

Add the index as a catalog source (a `file://` URL or absolute path), e.g. via
`electronAPI.extensionAddCatalogSource('file:///abs/path/examples/catalog/index.json')`,
then refresh. The Hello extension shows up as a catalog entry you can install +
enable with no network.
