/*
 * SecureOTA IDE — ESP32 Tracking Agent (MOD-07, device side)
 * ---------------------------------------------------------
 * Broadcasts an encrypted, authenticated status packet every 30 seconds so the
 * IDE's Live Device Panel can show this board.
 *
 * Injected by the IDE at preprocessing time (design decision 5) — the user's
 * .ino is never modified. The preprocessor adds:
 *
 *     #include <TrackingAgent.h>
 *     #define TRACKING_SSID     "..."
 *     #define TRACKING_PASS     "..."
 *     #define FIRMWARE_VERSION  "v3"
 *     #define SKETCH_NAME       "BlinkLED"
 *     #define HMAC_SECRET       "<64 hex chars>"
 *     #define AES_KEY           "<64 hex chars>"
 *
 * and starts the agent on core 0 (design decision 4), leaving the user's
 * setup()/loop() on core 1 untouched:
 *
 *     xTaskCreatePinnedToCore(trackingAgentTask, "Agent", 8192, NULL, 1, NULL, 0);
 *
 * Wire format — must stay identical to packet-crypto.ts:
 *
 *     ┌──────────────┬────────────────────────────────────┐
 *     │  IV, 16 B    │  AES-256-CBC ciphertext, N × 16 B  │
 *     └──────────────┴────────────────────────────────────┘
 *
 * plaintext = <json> '|' <hmac-sha256 of json, lowercase hex>
 */

#ifndef SECUREOTA_TRACKING_AGENT_H
#define SECUREOTA_TRACKING_AGENT_H

#include <Arduino.h>

#ifndef TRACKING_PORT
#define TRACKING_PORT 5007
#endif

#ifndef TRACKING_INTERVAL_MS
#define TRACKING_INTERVAL_MS 30000UL
#endif

/*
 * FreeRTOS entry point. Pinned to core 0 by the injected main().
 * Never returns.
 */
void trackingAgentTask(void *param);

/*
 * Monotonic counter backed by NVS (design decision 7 — a counter, not an NTP
 * timestamp). Survives reboot; the IDE rejects any packet whose counter does
 * not strictly advance, which is what makes a captured packet unreplayable.
 *
 * Exposed for the self-test sketch.
 */
unsigned long trackingNextCounter();

#endif  // SECUREOTA_TRACKING_AGENT_H
