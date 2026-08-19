# SecureOTA IDE

This workspace is the starting scaffold for the SecureOTA IDE fork of Arduino IDE 2.x.

## Structure
- `arduino-ide-extension/` - Theia/Arduino IDE extension layer
- `electron-app/` - Electron desktop shell
- `upstream/arduino-ide-2.3.9/` - Placeholder for the real Arduino IDE 2.x source tree
- `docs/integration-points.md` - Map of SecureOTA integration anchors
- `secureota-ai-system-prompt.md` - Project prompt and constraints

## Status
The project is being built from scratch.

## Next Step
Copy or clone the real Arduino IDE 2.3.9 source tree into `upstream/arduino-ide-2.3.9/`, then replace the scaffolded extension and Electron files with upstream-compatible implementations.
