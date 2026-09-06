# SiYuan Linker

[简体中文](README.md) · **English**

Transfer selected notes or workspace archives between a local SiYuan workspace and an active target SiYuan server.

> [!IMPORTANT]
> This plugin requires **SiYuan 3.8.2 or later**. The implementation is built against the 3.8.2 kernel API surface, but exact-mirror behavior still needs live integration verification on the specific SiYuan versions, deployment topology, proxy, notebooks, and data being used. Unit tests and builds are not a substitute for live-kernel testing.

## Deployment model

Install and enable the plugin only on the **local SiYuan end** where you operate the UI. The remote end does not need the plugin, but its SiYuan kernel API must be reachable and its API token must have administrator-level kernel access. Store that token in a local SiYuan Secret; never place it directly in plugin settings, URLs, logs, or screenshots.

For non-loopback targets, HTTPS is required by default. Trusted-LAN HTTP can be enabled explicitly, but it exposes tokens, notes, metadata, and archives in transit. Browser deployments may additionally be limited by CORS, mixed-content, and Private Network Access policies.

## Note transfer modes

### Exact-ID mirror

Exact-ID mirror is for two explicitly paired, related workspaces. It preserves the source notebook path and document/block IDs so links that depend on stable IDs can remain meaningful.

Before any exact transfer, the plugin verifies lineage on both ends. It then performs conservative preflight checks and aborts on lineage mismatch, pending operations, path mismatch, global ID collision, asset hash conflict, or a three-way content conflict. Destination writes use best-effort ownership verification and rollback; this is not a database transaction.

Exact-ID mirror currently:

- requires exactly matching SiYuan versions and matching notebook IDs on both ends;
- supports selected documents and any missing ancestor documents needed to preserve the path;
- keeps already-existing, unselected ancestors unchanged;
- rejects encrypted notebooks and documents bound to attribute views;
- does not support document renames, document moves, or notebook remapping;
- aborts rather than merges when the destination has independently changed;
- reloads the destination file tree after a verified write when the kernel permits it.

**First transfer without a baseline is conservative:** if a destination document with the same ID already exists, it is accepted only when its complete fingerprint already matches the source. Otherwise the transfer is treated as a conflict. A shared baseline is recorded only after both ends verify the same final state. When the plugin reports this first-sync conflict, it offers an explicit, confirmed overwrite of the affected documents with the source version (adopt-source) to rebuild the baseline; with a baseline recorded, destination-side edits still abort as conflicts.

### Independent copy

Independent copy uses SiYuan's native document export/import archive. It is intended for unrelated workspaces and does **not** require pairing. SiYuan creates new document, block, and attribute-view IDs during import.

The native archive can be broader than the visible selection. Depending on source data and export settings, it can include referenced documents, child documents, related attribute views, PDF annotations, assets, and other supporting data. The confirmation dialog states this expanded scope before import.

### Full-data transfer

Full push and pull always use SiYuan's native all-data archive, independently of the selected note transfer mode. They do not create pairing and are not exact-ID mirror operations. Use them only for backed-up, empty, or disposable destination workspaces: import can overwrite or mix data, and a failure can leave partial writes.

## Mirror lineage

Pairing writes two plugin-owned files on **each workspace**:

- `data/storage/petal/siyuan-linker/workspace-identity.json` — a stable random workspace identity used to distinguish the two ends. Resetting a peer pairing does not remove this identity.
- `data/storage/petal/siyuan-linker/mirror-lineages.json` — peer records containing the pair ID, local and peer workspace IDs, the notebook IDs present on both ends when paired, verified document baselines, and any pending mirror operation.

The files contain no API token. Do not copy, hand-edit, or selectively restore them unless you understand the lineage consequences. A duplicated workspace identity, unilateral peer record, divergent baseline, or pending operation intentionally blocks exact mirroring until inspected and resolved.

## Pairing workflow

1. Configure and validate the active target connection.
2. Select **Exact-ID mirror** only if the two workspaces are intended to share stable IDs.
3. In plugin settings, select **Pair active target**. Pairing is always user-triggered; it is never automatic and is never coupled to full transfer.
4. Review the status summary: pair ID, local and remote workspace IDs, allowed notebook count, and any pending or mismatch reasons.
5. Use **Verify active pairing** after changing targets, restoring data, or investigating a refusal.
6. Back up both workspaces, then push the current note or pull selected notes.
7. Use **Reset active pairing** only after reading the confirmation. Reset is refused while either lineage record has a pending operation; recover or complete a verified rollback first.

A destination made by a full workspace clone initially has the same workspace identity as the source. Ordinary pairing deliberately refuses this condition. If, and only if, the selected target is a confirmed full clone, use the separate **Adopt full-clone destination** action, accept the destructive warning, and type the exact confirmation phrase. The action archives the destination's copied lineage, rotates only the destination identity, clears its active copied lineage, and does not pair automatically. Review the archive path, then pair explicitly.

Pairing records only notebook IDs that exist on both ends at pairing time. If required notebook IDs do not exist on both ends, prepare the workspace/notebooks first rather than expecting exact mirror to remap them.

## Configuration

1. In the remote SiYuan, find the API token under **Settings → About**.
2. In the local SiYuan that runs this plugin, open **Settings → Secrets and variables** and create a Secret such as `SIYUAN_LINKER_TARGET_1_TOKEN` whose value is the remote token.
3. Enter the target URL and Secret name in plugin settings. Do not enter the token itself.
4. Select the active target and choose **Validate**.
5. Choose **Independent copy** for unrelated workspaces, or follow the explicit pairing workflow for **Exact-ID mirror**.

Older plugin releases stored tokens in plaintext plugin data. The plugin warns when it finds those legacy fields and removes each old field after the corresponding configured Secret validates successfully.

The former persisted `preserveIds` checkbox is migrated to the transfer-mode selector. `true` becomes Exact-ID mirror and `false` becomes Independent copy; the old key is intentionally removed while unrelated legacy settings are retained.

## Usage

- **Push current note:** open a document, select the bidirectional-arrow toolbar item, and choose Push current note.
- **Pull selected notes:** open the Remote notes dock, choose a notebook and documents, then select Pull notes. The dock shows active target, mode, and pairing state. In Exact-ID mirror mode the pull button is disabled until pairing is valid and has no pending operation.
- **Full push/pull:** use the corresponding plugin setting only for a one-time native archive migration.

## Limitations and safety model

- SiYuan does not provide this plugin with an official cross-workspace ACID transaction, cross-process lease, or documented maintenance lock that freezes concurrent edits. The plugin serializes pairing, reset, adoption, and exact-mirror operations only inside the current plugin process. Another browser window, plugin process, device, or external API client is not covered. Stop editing affected data and run only one operator/process during an exact transfer.
- Best-effort rollback verifies operation-owned content before restoring or deleting it. Ambiguous concurrent changes are left in place and reported rather than destructively overwritten.
- Assets created before a failed document write are intentionally retained as harmless orphans rather than deleted based only on matching bytes. The error reports residual asset paths for manual inspection and cleanup; verified document rollback can still clear pending lineage.
- A pending lineage record is a safety signal, not an instruction to retry blindly. Reset refuses pending records. Inspect both workspaces and backups and complete recovery or verified rollback first.
- Exact mirror does not merge conflicts, rename or move documents, remap notebooks, support encrypted notebooks, or support attribute-view-bound documents.
- Independent copy and full-data import inherit the scope and behavior of SiYuan's native archive APIs.
- Back up both workspaces and confirm source, destination, active target, transfer mode, and pairing status before every write.

## Local installation

Extract `package.zip` into:

```text
<SiYuan workspace>/data/plugins/siyuan-linker/
```

Ensure `plugin.json`, `index.js`, and `index.css` are at that directory's root, then restart SiYuan or refresh the plugin list. Install the plugin only on the local operator end; the remote end only exposes the administrator kernel API.

## Development

```bash
pnpm install
pnpm validate
pnpm typecheck
pnpm test
pnpm build
```

Build output is written to `dist/`; the release archive is `package.zip` at the repository root.

Project repository: <https://github.com/mixyoung/siyuan-linker>

## License

[MIT](LICENSE)
