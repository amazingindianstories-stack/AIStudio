#!/usr/bin/env bash
# Regenerates the board timer's background tracks in public/timer-music. Every track is synthesized here from
# plain sine tones, so they are original works released as CC0 (see public/timer-music/LICENSE.md).
# Each loops cleanly: 16 seconds, every tone completes whole cycles, and the ends fade to the same level.
set -euo pipefail
out="$(cd "$(dirname "$0")/../.." && pwd)/public/timer-music"
mkdir -p "$out"
mix() { # name, volume, then one lavfi sine source per remaining argument
  local name="$1" volume="$2"; shift 2
  local inputs=() count=0
  for source in "$@"; do inputs+=(-f lavfi -t 16 -i "$source"); count=$((count + 1)); done
  ffmpeg -y -loglevel error "${inputs[@]}" \
    -filter_complex "amix=inputs=${count}:normalize=0,volume=${volume},afade=t=in:d=0.4,afade=t=out:st=15.6:d=0.4" \
    -ac 1 -ar 32000 -c:a libmp3lame -b:a 48k "$out/$name.mp3"
}
# C major chord, slow tremolo.
mix calm 0.28 "sine=f=261.63:r=32000,tremolo=f=0.25:d=0.5" "sine=f=329.63:r=32000,tremolo=f=0.25:d=0.4" "sine=f=392:r=32000,tremolo=f=0.125:d=0.5"
# Low steady pad with a gentle pulse.
mix focus 0.3 "sine=f=110:r=32000,tremolo=f=0.5:d=0.3" "sine=f=164.81:r=32000,tremolo=f=0.25:d=0.3" "sine=f=220:r=32000,tremolo=f=1:d=0.2"
# Brighter chord with a quick pulse.
mix upbeat 0.26 "sine=f=392:r=32000,tremolo=f=2:d=0.7" "sine=f=493.88:r=32000,tremolo=f=2:d=0.6" "sine=f=587.33:r=32000,tremolo=f=4:d=0.5"
# A soft tick every second.
mix tick 0.5 "sine=f=880:r=32000,tremolo=f=1:d=1,lowpass=f=1200"
