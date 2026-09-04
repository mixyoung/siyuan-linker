# SiYuan Linker

[简体中文](README.md) · **English**

Move notes or workspace data between two SiYuan instances.

> [!IMPORTANT]
> This release requires **SiYuan 3.8.2 or later**. Desktop and desktop-window are the supported frontends; browser and mobile support remain unclaimed until cross-origin, mixed-content, layout, and large-file tests pass.

## Transfer modes

### Safe transfer (default)

Uses SiYuan's native `.sy.zip` export/import flow. The kernel handles assets, PDF annotations, attribute views, relations, caches, and indexes.

Safe transfer is intended for independent workspaces. SiYuan regenerates document, block, and attribute-view IDs during import, so it is not suitable for a mirror that depends on stable internal IDs. Native export may also include referenced documents, child documents allowed by the source export setting, related attribute views, and supporting assets; the plugin confirms this expanded scope before import.

### Preserve internal IDs (expert)

Copies document files between related workspace clones. It is available only when:

- both instances run exactly the same SiYuan version;
- the destination already contains the same notebook ID;
- the documents contain no attribute views;
- the notebook is not encrypted and both workspaces are backed up.

The plugin updates v3.8.2 indexes and reloads the file tree after writing, but this mode is still not transactional synchronization.

## Features

- Push the current local document to a target SiYuan server.
- Browse remote notebooks and lazily loaded document trees, then pull selected documents in a batch.
- Perform guarded full-data migration between disposable workspaces.
- Configure and switch between two targets.
- Check both SiYuan versions before a transfer.
- Report empty responses, malformed JSON, proxy HTML pages, and invalid ZIP archives with endpoint context.

## Configuration

1. Find the target API token under target SiYuan **Settings → About**.
2. In the local SiYuan instance that runs this plugin, open **Settings → Secrets and variables** and create a Secret such as `SIYUAN_LINKER_TARGET_1_TOKEN` whose value is that token.
3. Enter the target URL and the Secret name in the plugin settings. Do not enter the token itself.
4. Select Validate to check version, authentication, and notebook read access.

Non-loopback targets require HTTPS by default. For a trusted LAN only, you may explicitly enable **Allow remote HTTP (unsafe)**; tokens, notes, and archives are then transmitted in plaintext.

Older releases stored tokens in plaintext plugin data. This release warns about legacy values and removes them from the plugin configuration after a configured Secret validates successfully.

## Usage

- **Push current document:** open a document, select the bidirectional-arrow toolbar item, and choose Transfer current note. Safe mode uses `source name (source notebook ID)` as a stable destination name so separate same-name notebooks cannot be merged.
- **Pull selected documents:** open the Remote notes dock, choose a notebook and documents, then select Pull notes.
- **Full push/pull:** use only with backed-up, empty, or disposable workspaces. The operation may overwrite or merge existing data, and a failure can leave partial writes.

## Local installation

Extract `package.zip` into:

```text
<SiYuan workspace>/data/plugins/siyuan-linker/
```

Ensure `plugin.json`, `index.js`, and `index.css` are at that directory's root, then restart SiYuan or refresh the plugin list.

## Development

```bash
pnpm install
pnpm validate
pnpm typecheck
pnpm test
pnpm build
```

Build output is written to `dist/`; the release archive is `package.zip` at the repository root.

## Safety

- Never expose API tokens in URLs, logs, screenshots, or source control.
- Use HTTPS for remote services. Browser environments also enforce CORS, mixed-content, and Private Network Access rules.
- Full import is not bidirectional conflict resolution and has no cross-instance transaction rollback.
- Back up both workspaces and confirm transfer direction before any write.

Project repository: <https://github.com/mixyoung/siyuan-linker>

## License

[MIT](LICENSE)
