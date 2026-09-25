# SecureOTA IDE

A fork of Arduino IDE 2.x that adds an automated GitHub release pipeline and a
live panel of every device it has flashed — without changing the Arduino
workflow the user already knows.

## Structure

| Path | Contents |
|---|---|
| `arduino-ide-extension/` | Theia/Arduino extension layer — the SecureOTA modules |
| `electron-app/` | Electron desktop shell |
| `device/` | ESP32 tracking agent (C++), injected at preprocessing |
| `upstream/arduino-ide-2.3.9/` | Arduino IDE 2.3.9 source tree (cloned at tag `2.3.9`) |
| `docs/integration-points.md` | Exact patches to wire the modules into upstream |
| `secureota-ai-system-prompt.md` | Project prompt and constraints |

## Modules

| ID | Module | Where | State |
|---|---|---|---|
| MOD-04 | GitHub release pipeline | `src/common/github/`, `src/browser/contributions/` | Implemented, tested |
| MOD-06 | Update relevance checker | `src/common/devices/relevance.ts` | Implemented, tested |
| MOD-07 | Packet crypto + device registry + UDP listener | `src/common/security/`, `src/common/devices/` | Implemented, tested |
| MOD-07 | ESP32 tracking agent | `device/TrackingAgent.{h,cpp}` | Written, not yet flashed |
| MOD-05 | Version history panel | — | Not started (needs upstream Theia widgets) |
| MOD-03 | Preprocessing injection | — | Not started (needs arduino-cli hook) |

The implemented modules import nothing from Theia, so they build and test
independently of the IDE. See `docs/integration-points.md` for how they attach.

## Building and testing the modules

```bash
yarn install
yarn typecheck
yarn test        # 42 tests
```

Runs on the Node version already installed — the modules have no native
dependencies.

## Building the full IDE

Not yet possible on this machine. Upstream requires **Node >=18.17.0 <21** and
the installed runtime is Node 24. Install Node 20.x (nvm-windows) first, then:

```bash
cd upstream/arduino-ide-2.3.9
yarn install     # downloads Arduino CLI + language server, builds native modules
yarn build
```

Then apply the patches in `docs/integration-points.md`.

## Security model

Every tracking packet a device broadcasts passes four independent layers before
it can reach the panel:

1. **AES-256-CBC decrypt** — per-device key; a device with no registry entry has no key
2. **HMAC-SHA256 verify** — per-device secret, compared in constant time
3. **MAC registry check** — the keys that decrypted it must belong to the MAC it claims
4. **Counter check** — NVS-backed, must strictly advance, so a captured packet cannot be replayed

Keys are minted per device, so extracting one board's flash compromises that
board alone. The wire format lives in `src/common/security/packet-crypto.ts` and
`device/TrackingAgent.cpp`; the two must change together.

The GitHub token is held in the Arduino IDE keychain (`.scripts/store-pat.js`),
never in a Theia preference — preferences are written to a plaintext
`settings.json`.
