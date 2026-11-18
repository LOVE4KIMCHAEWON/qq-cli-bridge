# Codex in non-Git directories

Codex CLI (v0.169+) refuses non-Git working directories unless you pass `--skip-git-repo-check` to `codex exec` / `codex exec resume`.

qqbridge forwards that flag to the **Codex subprocess**, not as a raw passthrough of unknown qqbridge globals.

## Enable

### One-shot launch (persists into config)

```powershell
qqbridge codex --skip-git-repo-check --no-terminal
```

### Config file

In `data/config.json`:

```json
{
  "agents": {
    "codex": {
      "command": "codex",
      "extraArgs": [],
      "skipGitRepoCheck": true
    }
  }
}
```

Then:

```powershell
qqbridge codex --no-terminal
```

## What gets executed

With the option on, qqbridge builds argv like:

```text
codex exec --skip-git-repo-check --json "<bootstrap>"
codex exec --skip-git-repo-check resume --last --json "<message>"
codex exec --model <id> --skip-git-repo-check resume <sessionId> --json "<message>"
```

Sandbox, approval, session resume, and `/model` are unchanged.

## Disable

Set `"skipGitRepoCheck": false` in config (or remove the key; default is `false`).
