# SiYuan Linker

Transfer notes and workspace data between independent SiYuan instances.

SiYuan Linker is designed for workflows such as:

- Editing on SiYuan Desktop while publishing from a Docker-hosted instance.
- Capturing web content on a remote instance and pulling it into a local workspace.
- Moving selected notes and assets between separate workspaces.

> [!WARNING]
> SiYuan Linker uses SiYuan kernel file and data-import APIs. Back up both the local and target workspaces before transferring data. Never run a full transfer or pull operation unless you have confirmed the direction and destination.

## Features

### Transfer the current note

Transfer the currently open local note to the selected target while preserving its document path and notebook structure where possible. The operation includes:

- The `.sy` document data
- Assets referenced by the document
- Attribute-view data used by the document
- Notebook name and open state

An optional read-only marker can be added to transferred documents when the target is intended for publishing or read-only access.

### Pull selected remote notes

The **Remote notes** dock provides a browsable document tree for the selected target:

- Switch between remote notebooks
- Expand child documents on demand
- Select multiple documents
- Pull selected documents and their resources into the local workspace

The tree is loaded lazily, so child documents are requested only when their parent is expanded.

### Transfer all workspace data

Plugin settings provide two full-data operations:

- **Transfer all data:** export the local workspace data and import it into the target.
- **Pull all data:** export the target workspace data and import it into the local workspace.

Full-data operations use SiYuan's export and import APIs. They are intended for initialization or migration, not real-time synchronization.

### Two target configurations

Store two target SiYuan server configurations and switch between them in plugin settings.

Each target contains:

- A SiYuan server URL
- An API token

When the selected target changes, the Remote notes dock clears stale selections and reloads from the new target.

## Installation

### Install from Marketplace

In SiYuan, open:

`Settings → Marketplace → Plugins`

Search for **SiYuan Linker** and install it.

### Manual installation

1. Download `package.zip` from the project releases.
2. Extract it into the SiYuan workspace directory:

   ```text
   data/plugins/siyuan-linker
   ```

3. Restart SiYuan or reload the plugin.

## Target configuration

1. Obtain the API token from the target SiYuan instance.
2. Open SiYuan Linker settings.
3. Enter the target URL and API token.
4. Select the target configuration to use.
5. Click **Validate connection**.

Example target URLs:

```text
http://127.0.0.1:6806
https://siyuan.example.com
```

The plugin removes trailing slashes automatically, but using the full URL without a trailing slash is recommended.

If the target is behind a reverse proxy, make sure the proxy supports:

- SiYuan `/api/*` requests
- Large file uploads and downloads
- An appropriate cross-origin policy
- Sufficient request timeouts

## Usage

### Transfer the current note

1. Open the note to transfer.
2. Click the **Data transfer** icon in the top toolbar.
3. Select **Transfer current note**.
4. Wait for the completion notification.

### Pull selected notes

1. Open the **Remote notes** dock.
2. Select a remote notebook.
3. Expand the document tree and select one or more documents.
4. Click **Pull notes**.

### Transfer or pull all data

Open plugin settings and use **Transfer all data** or **Pull all data**.

Confirm the direction before proceeding:

```text
Transfer all data: local → target
Pull all data:     target → local
```

## Behavior and limitations

- This plugin performs one-way data transfers; it is not a real-time two-way sync engine.
- It does not merge document content or resolve editing conflicts.
- Existing files at the destination path may be overwritten by SiYuan's file APIs.
- Regular document assets and attribute-view data are transferred with the document.
- Network interruptions, reverse-proxy limits, or insufficient target permissions can cause partial failures.
- Avoid editing the same document on both instances while it is being transferred.
- Mobile and browser frontends are enabled in the manifest, but desktop is recommended for large transfers.

## Privacy and security

- API tokens are stored only in the current SiYuan workspace's plugin settings.
- Do not publish settings files, logs, or screenshots containing tokens.
- Use HTTPS for remote SiYuan instances whenever possible.
- Do not transfer private notes to an untrusted target.
- The plugin does not intentionally send data to services other than the configured target.

## Development

Requirements:

- Node.js 20 or later
- pnpm 10
- SiYuan 3.0.12 or later

Install dependencies:

```bash
pnpm install
```

Run type checking:

```bash
pnpm typecheck
```

Validate project metadata and locale files:

```bash
pnpm validate
```

Create a production build:

```bash
pnpm build
```

Build outputs:

```text
dist/
package.zip
```

Start watch mode:

```bash
pnpm dev
```

Create a development link:

```bash
pnpm make-link
```

## Project structure

```text
src/index.ts                 Plugin entry point, settings, and transfer orchestration
src/myapi.ts                 SiYuan file and data-transfer APIs
src/FileTreeApi.ts           Remote document-tree API
src/app.vue                  Remote notes dock
src/MyVue/FileTree.vue       Recursive document-tree component
public/i18n/                 English and Chinese locale files
scripts/validate_project.js  Project consistency checks
```

## Reporting issues

When opening an issue, include the following where possible:

- SiYuan version
- Plugin version
- Local and target deployment types
- Operation type: current note, selected-note pull, or full-data operation
- Redacted error output and reproduction steps

Project repository: <https://github.com/mixyoung/siyuan-linker>

## License

This project is licensed under the [MIT License](LICENSE).
