# SecureOTA Integration Points

This file tracks where SecureOTA will attach to the real Arduino IDE 2.x source tree.

## Current anchors
- `arduino-ide-extension/src/browser/contributions/upload-sketch.ts` - upload success hook for GitHub release automation.
- `arduino-ide-extension/src/browser/arduino-ide-frontend-module.ts` - dependency injection registration.
- `arduino-ide-extension/src/browser/contributions/github-integration.ts` - GitHub release orchestration service.
- `arduino-ide-extension/src/browser/settings/github-settings.ts` - preferences model for GitHub configuration.
- `electron-app/src/main.ts` - Electron shell entry point.

## Next upstream alignment tasks
- Copy the real Arduino IDE source tree into `upstream/arduino-ide-2.3.9/`.
- Compare upstream upload flow against the local upload hook.
- Replace scaffold implementations with upstream-compatible Theia services.
- Add the GitHub settings schema to the real preference system once the upstream tree is available.
