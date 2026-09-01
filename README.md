# dsh-restart-harness

An independent self-restart plugin for DeepSeek Harness Web.

The plugin adds a restart action under Settings -> General and registers an AI-callable `restart_harness` tool. It does not depend on `dshmarket`.

## Features

- Self-restart flow for Windows, macOS, and Linux;
- Waits for the old Web port to be released before launching the replacement;
- Replays the current DSH invocation;
- Adds `--no-open` to replacement Web launches so the existing browser tab can recover without opening another tab;
- Requires an explicit `reason` and `confirm: true` for AI-triggered restarts;
- Persists the initiating session and attempts to resume its Agent after restart;
- Sends a recovery notice to the original session and wakes it to continue unfinished work;
- Writes diagnostic logs to `$DSH_HOME/dsh-restart-harness.log`.

## Install

From the target Web profile:

```powershell
dsh plugin --profile web add dsh-restart-harness
```

For a local checkout, place the package in the target profile's `node_modules`, then add this entry to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-restart-harness
      name: 'dsh-restart-harness'
```

Restart Harness once after installing or changing Host-side code.

## AI tool

Tool name: `restart_harness`

Arguments:

```json
{
  "reason": "Why the Harness must restart",
  "confirm": true
}
```

The AI should explain that restarting may interrupt the current process before calling the tool. The current process exits after the request is accepted, and the independent helper launches the original `dsh web` invocation.

## Diagnostics

Log file:

```text
$DSH_HOME/dsh-restart-harness.log
```

Read-only HTTP endpoint:

```text
GET /dsh-restart/log
```

## Security

The restart endpoint accepts only loopback requests, requires a matching `Origin` and `Host`, and rejects common proxy forwarding headers. Do not expose the Web port to an untrusted network.

## Compatibility

Requires a DeepSeek Harness Web profile with Cordis loader, WebServer, Tools, and Timer capabilities. Session recovery additionally depends on session persistence and the Agent registry being enabled.

## License

MIT
