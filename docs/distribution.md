# Distribution Notes

Chrome extensions cannot automatically install or run a local Native Messaging
host during extension installation. The extension and the native companion must
be distributed as two install steps.

## Recommended Distribution

1. Publish the Chrome extension.
2. Use the published Chrome Web Store extension ID in the Native Messaging host
   installer.
3. Ship a Windows companion installer that:
   - places the backend/native-host files on disk,
   - writes the Native Messaging manifest,
   - registers
     `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.youtube_live_dub.backend`,
   - restarts or asks the user to restart Chrome.

For this development checkout, run:

```powershell
cd "$env:USERPROFILE\youtube-live-dub-mvp\native-host"
.\install-native-host.ps1 -ExtensionId "bmomajjogjjhmdfimgedkajndgcbjpgb"
```

For production, replace the extension ID:

```powershell
.\install-native-host.ps1 -ExtensionId "your_web_store_extension_id"
```

## Alternatives

- Enterprise deployment can install the native host through managed registry
  policy or an MSI/EXE installer.
- A hosted backend removes the Native Messaging installer, but API keys and
  audio generation then move to your server.
- Manual local backend startup is still useful for developer-mode testing.

## Why Auto-Install Is Not Possible

Chrome Native Messaging requires a host manifest registered outside the
extension. On Windows, an installer must create a registry key pointing to the
host manifest. The extension itself cannot write that registry key or execute a
PowerShell installer.

