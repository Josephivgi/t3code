# T3 Code plugins

A plugin is a directory containing a `plugin.json` manifest. Plugins are installed
per environment into `<stateDir>/plugins` and can be managed from **Settings →
Plugins**, the REST API (`/api/plugins*`), or the agent MCP tools
(`t3_plugins_*`).

## Safety model

- Declarative contributions only — a plugin ships assets plus a manifest, never
  code that runs inside the server or app context.
- `capabilities` must cover every contribution the plugin ships; a manifest that
  under-declares is refused at install time.
- Assets are limited by type, size (512 KiB/file, 2 MiB/plugin, 256 files), and
  path containment; symlinks and traversal are rejected.
- Panel HTML is served with `Content-Security-Policy: sandbox` and rendered in a
  `sandbox` iframe, so it cannot reach app state or cookies.

## Revertability

Every install/enable/disable/remove is appended to `journal.jsonl` and
snapshotted. `POST /api/plugins/revert` (or `t3_plugins_revert`) undoes the most
recent unreverted operation — a remove restores files from the plugin trash.

## Example: Devin icon

```
POST /api/plugins/install  { "sourcePath": "<repo>/examples/plugins/devin-icon" }
```

The header icon links to https://app.devin.ai.

## Manifest

```json
{
  "id": "devin-icon",
  "name": "Devin",
  "version": "1.0.0",
  "capabilities": ["ui:header-icon"],
  "contributes": {
    "headerIcons": [{ "icon": "icon.svg", "title": "Devin", "href": "https://app.devin.ai" }],
    "panels": [{ "id": "status", "title": "Status", "html": "panel.html" }],
    "themeCss": ["theme.css"]
  }
}
```

| Capability       | Contribution              |
| ---------------- | ------------------------- |
| `ui:header-icon` | `contributes.headerIcons` |
| `ui:panel`       | `contributes.panels`      |
| `ui:theme-css`   | `contributes.themeCss`    |

## API

| Method | Path                             | Operation              |
| ------ | -------------------------------- | ---------------------- |
| GET    | `/api/plugins`                   | List plugins + journal |
| POST   | `/api/plugins/install`           | Install from a path    |
| POST   | `/api/plugins/:id/enable`        | Enable                 |
| POST   | `/api/plugins/:id/disable`       | Disable                |
| POST   | `/api/plugins/:id/remove`        | Remove (to trash)      |
| POST   | `/api/plugins/revert`            | Undo last operation    |
| GET    | `/api/plugin-assets/:id/<asset>` | Serve plugin assets    |

MCP tools: `t3_plugins_list`, `t3_plugins_install`, `t3_plugins_set_enabled`,
`t3_plugins_remove`, `t3_plugins_revert`.
