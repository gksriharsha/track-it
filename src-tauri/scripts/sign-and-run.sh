#!/bin/sh
# Cargo `runner` hook, so `tauri dev` launches a binary macOS can grant the camera to.
#
# cargo's linker-signed ad-hoc signature carries an identifier that changes every
# build (trackit-cca062a5...) and leaves the embedded Info.plist unbound. TCC
# keys camera grants to a stable identity with a BOUND plist, so without this the
# app never appears in Privacy & Security and getUserMedia can only ever be
# refused — with no way for the user to say yes.
#
# Re-signing after the link, with the bundle's real identifier, is the only hook
# cargo offers between "binary exists" and "binary runs".
set -e
BIN="$1"
shift
case "$(basename "$BIN")" in
  trackit)
    HERE=$(cd "$(dirname "$0")" && pwd)
    codesign --force --sign - \
      --identifier com.kgundu1.trackit \
      --entitlements "$HERE/../Entitlements.plist" \
      "$BIN" >/dev/null 2>&1 || true
    ;;
esac
exec "$BIN" "$@"
