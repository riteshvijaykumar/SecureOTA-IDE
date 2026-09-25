# SecureOTA Integration Points

Where SecureOTA attaches to the Arduino IDE 2.3.9 source tree in
`upstream/arduino-ide-2.3.9/` (present — cloned at tag `2.3.9`, commit
`17a44c35`).

## Status

The modules in `arduino-ide-extension/src/` are implemented and tested
standalone (42 tests, `yarn test`). They are deliberately free of Theia imports
so they build and run without the upstream tree. What remains is *wiring* them
into the fork.

| Module | State |
|---|---|
| MOD-04 GitHub release pipeline | Implemented + tested |
| MOD-06 Update relevance checker | Implemented + tested |
| MOD-07 packet crypto, device registry, UDP listener | Implemented + tested |
| Tracking agent (ESP32 C++) | Written, **not yet compiled on hardware** |
| MOD-05 Version history panel (Theia widget) | Not started — needs upstream |
| MOD-07 panel UI (Theia widget) | Not started — needs upstream |
| Preprocessing injection | Not started — needs arduino-cli hook |

## Anchor 1 — upload success hook

**File:** `upstream/arduino-ide-2.3.9/arduino-ide-extension/src/browser/contributions/upload-sketch.ts`
**Location:** line 176, immediately after the `Done uploading.` message.

Existing code:

```ts
      this.messageService.info(
        nls.localize('arduino/sketch/doneUploading', 'Done uploading.'),
        { timeout: 3000 }
      );
```

Add directly beneath it:

```ts
      // SecureOTA: publish a GitHub release for this flash. Deliberately not
      // awaited and never rethrown — the board has already been flashed, so a
      // GitHub failure must not surface as an upload failure. Failures are
      // queued and retried by GitHubIntegration.drainQueue().
      void this.gitHubIntegration
        .triggerRelease({
          sketchPath: sketch.mainFileUri,
          binPath: compileSummary.buildPath,
          sketchName: sketch.name,
          devicePort: uploadResponse.portAfterUpload?.address,
          fqbn: uploadOptions.fqbn,
        })
        .catch((error) => console.error('[SecureOTA] release failed', error));
```

And the injection at the top of the class:

```ts
  @inject(GitHubIntegration)
  private readonly gitHubIntegration: GitHubIntegration;
```

> `compileSummary.buildPath` is the build **directory**; the `.bin` inside it is
> named after the sketch. Resolve the exact artefact before passing it — see
> `CompileSummary` in `src/common/protocol/core-service.ts:126`.

## Anchor 2 — DI registration

**File:** `upstream/.../src/browser/arduino-ide-frontend-module.ts`

Load the SecureOTA module, supplying a settings reader backed by Theia
preferences plus the keychain:

```ts
import { createSecureotaFrontendModule } from 'secureota/lib/browser';

container.load(
  createSecureotaFrontendModule(() => ({
    enabled: preferences.get('secureota.github.enabled', false),
    username: preferences.get('secureota.github.username', ''),
    token: keychainToken,   // from .scripts/store-pat.js, NOT a preference
  }))
);
```

## Anchor 3 — preferences schema

**File:** `upstream/.../src/browser/arduino-preferences.ts`

Merge `gitHubPreferenceSchema` from `src/browser/settings/github-settings.ts`.
Note it intentionally declares no `token` property — a Theia preference lands in
a plaintext `settings.json`, which is not an acceptable home for a token that
can create repositories. The keychain holds it instead.

## Anchor 4 — preprocessing injection (not yet built)

**Target:** the sketch preprocessing step that generates the temporary `.cpp`
the compiler sees. The user's `.ino` is never modified (design decision 5).

Must inject `#include <TrackingAgent.h>`, the six `#define`s listed in
`device/TrackingAgent.h`, and the `xTaskCreatePinnedToCore` call into the
generated `main()`. Keys come from `DeviceRegistry.provision(mac, sketchName)`.

Open question: the MAC is not known until the board is contacted, but keys must
be injected at compile time. Either provision by serial port and reconcile the
MAC on first packet, or read the MAC during the pre-upload board probe.

## Anchor 5 — Electron shell identity

**Files:** `electron-app/package.json` (`name`, `productName`),
`electron-app/src-gen/frontend/index.html` (window title).

## Wire format contract

`arduino-ide-extension/src/common/security/packet-crypto.ts` and
`device/TrackingAgent.cpp` implement the same format and **must be changed
together**:

```
IV (16 B) || AES-256-CBC( "<json>|<hmac-sha256-hex>" , PKCS#7 )
```

The HMAC covers the JSON only. `packet-crypto.ts` exports `encodePacket`, which
is the executable specification the tests run against.

## Build blocker

Upstream `package.json` declares `"node": ">=18.17.0 <21"`. This machine has
Node v24.12.0, so `yarn install` in `upstream/` will refuse and the native
modules would not build. Install Node 20.x (nvm-windows recommended) before
attempting a full IDE build. The SecureOTA modules and their tests are
unaffected and run on Node 24.
