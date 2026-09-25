#include "TrackingAgent.h"

#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <esp_system.h>

#include "mbedtls/aes.h"
#include "mbedtls/md.h"

namespace {

constexpr size_t IV_BYTES = 16;
constexpr size_t AES_BLOCK = 16;
constexpr size_t KEY_BYTES = 32;
constexpr size_t HMAC_HEX_CHARS = 64;

// Bounded so the agent's stack footprint is knowable. A status packet is
// ~200 bytes of JSON plus a 64-char HMAC; 512 leaves generous headroom.
constexpr size_t MAX_PLAINTEXT = 512;
constexpr size_t MAX_PACKET = IV_BYTES + MAX_PLAINTEXT + AES_BLOCK;

WiFiUDP udp;
Preferences trackingPrefs;

/*
 * Decode a 64-char hex key into 32 bytes.
 *
 * The IDE injects keys as hex. Passing the hex string itself to mbedTLS would
 * silently use the first 32 *characters* as the key — a real and easy mistake
 * that would make the device's packets undecodable by the IDE while appearing
 * to work.
 */
bool decodeHexKey(const char *hex, uint8_t out[KEY_BYTES]) {
  if (hex == nullptr || strlen(hex) != HMAC_HEX_CHARS) {
    return false;
  }
  for (size_t i = 0; i < KEY_BYTES; ++i) {
    char byteText[3] = {hex[i * 2], hex[i * 2 + 1], '\0'};
    char *end = nullptr;
    const long value = strtol(byteText, &end, 16);
    if (end != byteText + 2 || value < 0 || value > 0xFF) {
      return false;
    }
    out[i] = static_cast<uint8_t>(value);
  }
  return true;
}

void toHex(const uint8_t *bytes, size_t length, char *out) {
  static const char *digits = "0123456789abcdef";
  for (size_t i = 0; i < length; ++i) {
    out[i * 2] = digits[bytes[i] >> 4];
    out[i * 2 + 1] = digits[bytes[i] & 0x0F];
  }
  out[length * 2] = '\0';
}

bool computeHmac(const char *message, const uint8_t key[KEY_BYTES], char *hexOut) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) {
    return false;
  }

  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);

  bool ok = false;
  uint8_t digest[32];

  if (mbedtls_md_setup(&ctx, info, 1) == 0 &&
      mbedtls_md_hmac_starts(&ctx, key, KEY_BYTES) == 0 &&
      mbedtls_md_hmac_update(&ctx, reinterpret_cast<const uint8_t *>(message),
                             strlen(message)) == 0 &&
      mbedtls_md_hmac_finish(&ctx, digest) == 0) {
    toHex(digest, sizeof(digest), hexOut);
    ok = true;
  }

  mbedtls_md_free(&ctx);
  return ok;
}

/*
 * AES-256-CBC encrypt with PKCS#7 padding, writing IV || ciphertext.
 * Returns the total packet length, or 0 on failure.
 */
size_t encryptPacket(const char *plaintext,
                     const uint8_t key[KEY_BYTES],
                     uint8_t *out,
                     size_t outCapacity) {
  const size_t textLength = strlen(plaintext);
  const size_t padding = AES_BLOCK - (textLength % AES_BLOCK);
  const size_t paddedLength = textLength + padding;

  if (IV_BYTES + paddedLength > outCapacity) {
    return 0;
  }

  // esp_fill_random draws from the hardware RNG. A predictable IV would let an
  // observer confirm that two packets carry identical plaintext.
  esp_fill_random(out, IV_BYTES);

  // mbedtls_aes_crypt_cbc advances the IV buffer in place, so encrypt from a
  // copy or the IV written to the packet would be destroyed.
  uint8_t workingIv[IV_BYTES];
  memcpy(workingIv, out, IV_BYTES);

  uint8_t padded[MAX_PLAINTEXT + AES_BLOCK];
  if (paddedLength > sizeof(padded)) {
    return 0;
  }
  memcpy(padded, plaintext, textLength);
  memset(padded + textLength, static_cast<int>(padding), padding);

  mbedtls_aes_context aes;
  mbedtls_aes_init(&aes);

  size_t written = 0;
  if (mbedtls_aes_setkey_enc(&aes, key, 256) == 0 &&
      mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, paddedLength, workingIv,
                            padded, out + IV_BYTES) == 0) {
    written = IV_BYTES + paddedLength;
  }

  mbedtls_aes_free(&aes);
  return written;
}

}  // namespace

unsigned long trackingNextCounter() {
  trackingPrefs.begin("secureota", false);
  const unsigned long next = trackingPrefs.getULong("cnt", 0UL) + 1UL;
  trackingPrefs.putULong("cnt", next);
  trackingPrefs.end();
  return next;
}

void trackingAgentTask(void *param) {
  (void)param;

  uint8_t aesKey[KEY_BYTES];
  uint8_t hmacKey[KEY_BYTES];

  // Without valid injected keys the agent cannot produce a packet the IDE
  // would accept. Exit rather than broadcasting undecodable noise every 30s.
  if (!decodeHexKey(AES_KEY, aesKey) || !decodeHexKey(HMAC_SECRET, hmacKey)) {
    log_e("[SecureOTA] Invalid injected keys; tracking agent disabled.");
    vTaskDelete(nullptr);
    return;
  }

  WiFi.begin(TRACKING_SSID, TRACKING_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    vTaskDelay(500 / portTICK_PERIOD_MS);
  }

  MDNS.begin(SKETCH_NAME);
  MDNS.addService("secureota", "tcp", TRACKING_PORT);
  udp.begin(TRACKING_PORT);

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      // Reconnect rather than spin: the panel showing the device offline is
      // correct while the radio is down.
      WiFi.reconnect();
      vTaskDelay(5000 / portTICK_PERIOD_MS);
      continue;
    }

    const unsigned long counter = trackingNextCounter();

    char json[MAX_PLAINTEXT - HMAC_HEX_CHARS - 2];
    const int jsonLength = snprintf(
        json, sizeof(json),
        "{\"mac\":\"%s\",\"version\":\"%s\",\"sketch\":\"%s\","
        "\"ip\":\"%s\",\"status\":\"online\",\"cnt\":%lu}",
        WiFi.macAddress().c_str(), FIRMWARE_VERSION, SKETCH_NAME,
        WiFi.localIP().toString().c_str(), counter);

    if (jsonLength > 0 && static_cast<size_t>(jsonLength) < sizeof(json)) {
      char hmacHex[HMAC_HEX_CHARS + 1];
      if (computeHmac(json, hmacKey, hmacHex)) {
        char combined[MAX_PLAINTEXT];
        const int combinedLength =
            snprintf(combined, sizeof(combined), "%s|%s", json, hmacHex);

        if (combinedLength > 0 && static_cast<size_t>(combinedLength) < sizeof(combined)) {
          uint8_t packet[MAX_PACKET];
          const size_t packetLength =
              encryptPacket(combined, aesKey, packet, sizeof(packet));

          if (packetLength > 0) {
            udp.beginPacket(IPAddress(255, 255, 255, 255), TRACKING_PORT);
            udp.write(packet, packetLength);
            udp.endPacket();
          }
        }
      }
    }

    vTaskDelay(TRACKING_INTERVAL_MS / portTICK_PERIOD_MS);
  }
}
