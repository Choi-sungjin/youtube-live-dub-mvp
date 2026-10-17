# Native Host

Chrome extensions cannot start local processes directly. This Native Messaging
host lets the extension start, stop, and check the local backend so the panel's
**Test** button can boot the backend on demand.

The host launches the backend on **port 18789** by default (matching the
extension default). The extension passes the port from its `Backend` field, so
if you change the URL in the panel, the host follows.

## One-time install (per machine, per extension, per browser)

1. Open `chrome://extensions` in your browser, enable **Developer mode**, load
   the `extension/` folder unpacked, and copy the 32-char extension ID.
2. Run PowerShell, choosing the matching `-Browser` value:

   ```powershell
   cd "$env:USERPROFILE\youtube-live-dub-mvp\native-host"
   .\install-native-host.ps1 -ExtensionId "your_extension_id" -Browser Chrome
   ```

   Supported browsers: `Chrome` (default), `Comet`, `Edge`, `Brave`, `Vivaldi`,
   `Opera`, `Arc`, `Chromium`. Each Chromium-based browser uses its own
   registry subtree, so you must register once per browser you actually use.

3. **Fully quit that browser** (close every window — the running process must
   exit so it re-reads the registry), then reopen and reload the extension.
4. Open a YouTube watch page, open the panel, click **Test**.

If you re-load the extension from a different folder the browser assigns a new
ID and you must rerun the install script with the new ID.

## Uninstall

```powershell
.\uninstall-native-host.ps1                  # remove from all browsers
.\uninstall-native-host.ps1 -Browser Comet   # remove from one browser
.\uninstall-native-host.ps1 -RemoveManifest  # also delete the generated JSON
```

## Distribution

For published distribution, run the install helper from a companion installer
and pass the Chrome Web Store extension ID. The host itself only needs Node.js
on `PATH` (used by `yld-native-host.cmd`).
