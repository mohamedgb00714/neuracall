# NeuraCall scripts

Shell tooling for the NeuraCall runtime. Each script is standalone and
idempotent (safe to re-run).

## `adb-setup.sh` — one-time wireless ADB handshake

Pairs each Android phone connected over USB with the host over Wi-Fi:

1. enumerates USB devices (`adb devices`, skipping wireless endpoints),
2. switches each to TCP/IP listening on `:5555` (`adb tcpip 5555`),
3. discovers the phone's Wi-Fi IP (default route source, falling back to the
   `wlan0` link address),
4. `adb connect <ip>:5555`,
5. verifies the wireless link, and
6. writes the endpoints to `devices.json` at the repo root (schema version 1,
   same shape the device-manager's `devicesFile.ts` reads).

Handles multiple phones. Re-running is safe: already-online endpoints are
recognized and `devices.json` is written atomically.

```bash
./scripts/adb-setup.sh          # real handshake (needs a phone over USB)
./scripts/adb-setup.sh --dry-run  # print the adb commands without running them
```

## `adbtool.sh` — manage known wireless endpoints

Reads and edits the same `devices.json`:

```bash
./scripts/adbtool.sh list                                   # known endpoints
./scripts/adbtool.sh add 192.168.1.60                       # add (+ reconnect)
./scripts/adbtool.sh remove 192.168.1.60                    # remove by host
./scripts/adbtool.sh reconnect                              # connect offline ones
./scripts/adbtool.sh reconnect --all                        # connect all
```

Use `reconnect --all` after a phone reboot or a network change — wireless
endpoints are dropped by the phone in those cases. Uses `node` (a guaranteed
dependency of this monorepo) for robust JSON read/write.
