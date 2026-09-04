# SiYuan Linker

Transfer notes and workspace data between local and remote SiYuan instances. A common setup is a desktop workspace connected to a Docker-hosted SiYuan server.

> Since v0.3.0, the technical plugin ID is `siyuan-linker`. Settings from the former `siyuan-link` plugin are not migrated automatically and must be configured again.

> This plugin reads and writes SiYuan workspace files. Back up both workspaces and verify the target settings before transferring notes or all data.

## Features

- Transfer the current note, its assets, and attribute-view data while preserving its path.
- Transfer all local workspace data to the target instance.
- Pull all target workspace data into the local instance.
- Browse target notebooks in a lazy-loaded document tree and pull multiple selected notes.
- Configure and switch between two target instances.
- Optionally add a read-only marker to transferred notes.

DeepSeek/Kimi web docks and AList features have been removed. SiYuan Linker now focuses on note transfer between SiYuan instances.

## Configuration

Enter the target SiYuan URL and API token in the plugin settings. Do not add a trailing slash to the URL:

- Correct: `http://siyuan.example.com`
- Incorrect: `http://siyuan.example.com/`

Use **Validate connection** after saving the settings.

## Usage

- **Current note:** open a document, click the Data transfer icon in the top bar, and choose **Transfer current note**.
- **All data:** use **Transfer all data** or **Pull all data** in plugin settings.
- **Selected notes:** open the Remote notes dock, choose a notebook, expand the tree, select documents, and click **Pull notes**.

## History

- v0.1.x introduced single-note and full-data transfer, multiple targets, and the remote file tree.
- v0.2.0–v0.2.5 included AList features; they were split out and removed in v0.2.7.
- v0.2.6 introduced DeepSeek/Kimi web docks; they were removed in later development.
- v0.2.7 removed AList functionality.

## Feedback and license

Report issues at <https://github.com/mixyoung/siyuan-linker>.

Licensed under the MIT License. Do not use this software for unlawful activities; the author is not responsible for consequences arising from its use.
