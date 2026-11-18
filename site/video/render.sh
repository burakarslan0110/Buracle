#!/usr/bin/env bash
# Renders the launch film in English and Turkish and writes the deliverables into site/media/:
#   buracle-stack-en.mp4, buracle-stack-tr.mp4  1920x1080, 30 fps, 55.0 s, H.264 + AAC, +faststart; captured at
#                                               3840x2160 (device scale 2) and downscaled with Lanczos so letters stay
#                                               sharp, CRF 18; audio at -16 LUFS, true peak under -4 dBFS
#   poster-en.jpg, poster-tr.jpg                the end card at 54.0 s (logos, wordmark, tagline, command, URL, colophon)
#   preview.gif                                 a silent 720 px loop: the logos lock onto the layer, the distillation
#                                               and the search over the knowledge graph, VERIFIED and the workflow
#                                               rows, the feature cards, the end card
# The legibility gate (tools/legibility-gate.mjs) runs first and stops the render when it fails (SKIP_GATE=1 skips it).
# Needs Node 22+, ffmpeg and ffprobe. Large intermediate files go to $WORK (a temporary folder by default).
# The music file assets/music/buracle-drive.m4a is built by music/score.py (see CREDITS.md); this script does not
# rebuild it. The sound-effect clips in index.html are written by tools/write-sfx.mjs.
set -euo pipefail

cd "$(dirname "$0")"
# HYPERFRAMES_BIN overrides the CLI (for example a local launcher); the default is the version package.json pins.
if [ -n "${HYPERFRAMES_BIN:-}" ]; then HF=("$HYPERFRAMES_BIN"); else HF=(npx --yes hyperframes@0.9.65); fi
MEDIA="../media"
WORK="${WORK:-$(mktemp -d)}"
CRF="${CRF:-18}"
DUR=55
mkdir -p "$MEDIA" "$WORK"

if [ "${SKIP_GATE:-0}" != "1" ]; then
  CHROME_PATH="${CHROME_PATH:-$("${HF[@]}" browser path | tail -1)}" node tools/legibility-gate.mjs
fi

master() { # $1 raw 4K render, $2 output: Lanczos downscale to 1080p, two-pass loudnorm on the audio
  local stats
  stats=$(ffmpeg -hide_banner -nostats -i "$1" -af loudnorm=I=-16:TP=-6.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
  local mi mtp mlra mth off
  mi=$(node -e 'const s=JSON.parse(process.argv[1]);console.log(s.input_i)' "$stats")
  mtp=$(node -e 'const s=JSON.parse(process.argv[1]);console.log(s.input_tp)' "$stats")
  mlra=$(node -e 'const s=JSON.parse(process.argv[1]);console.log(s.input_lra)' "$stats")
  mth=$(node -e 'const s=JSON.parse(process.argv[1]);console.log(s.input_thresh)' "$stats")
  off=$(node -e 'const s=JSON.parse(process.argv[1]);console.log(s.target_offset)' "$stats")
  ffmpeg -hide_banner -v error -y -i "$1" -map 0:v:0 -map 0:a:0 \
    -vf "scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv420p" \
    -c:v libx264 -preset slow -tune animation -crf "$CRF" -aq-mode 3 -profile:v high -g 60 \
    -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
    -af "loudnorm=I=-16:TP=-6.5:LRA=11:measured_I=$mi:measured_TP=$mtp:measured_LRA=$mlra:measured_thresh=$mth:offset=$off:linear=true,aresample=48000,atrim=0:$DUR" \
    -c:a aac -b:a 192k -ar 48000 -t "$DUR" -movflags +faststart "$2"
}

for lang in en tr; do
  "${HF[@]}" render --quality high --crf 8 --resolution landscape-4k --skill=hyperframes --variables "{\"lang\":\"$lang\"}" -o "$WORK/raw-$lang.mp4"
  master "$WORK/raw-$lang.mp4" "$MEDIA/buracle-stack-$lang.mp4"
  ffmpeg -hide_banner -v error -y -ss 54.0 -i "$WORK/raw-$lang.mp4" -frames:v 1 -vf "scale=1920:1080:flags=lanczos" -q:v 2 "$MEDIA/poster-$lang.jpg"
done

# preview.gif: six windows of the English film, 10 fps, 720 px wide, one palette, endless loop
SRC="$MEDIA/buracle-stack-en.mp4"
ffmpeg -hide_banner -v error -y -i "$SRC" -filter_complex "\
[0:v]trim=5.4:8.2,setpts=PTS-STARTPTS[a];\
[0:v]trim=16.1:18.7,setpts=PTS-STARTPTS[b];\
[0:v]trim=20.9:23.5,setpts=PTS-STARTPTS[c];\
[0:v]trim=28.3:31.1,setpts=PTS-STARTPTS[d];\
[0:v]trim=44.4:47.0,setpts=PTS-STARTPTS[e];\
[0:v]trim=51.0:54.0,setpts=PTS-STARTPTS[f];\
[a][b][c][d][e][f]concat=n=6:v=1:a=0,fps=10,scale=720:-1:flags=lanczos,split[x][y];\
[x]palettegen=max_colors=72:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$MEDIA/preview.gif"

# check every MP4: H.264 video, 55.0 s, and the loudness (integrated and true peak) of what was written
for lang in en tr; do
  f="$MEDIA/buracle-stack-$lang.mp4"
  echo "$f: $(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 "$f") $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") s"
  ffmpeg -hide_banner -nostats -i "$f" -af ebur128=peak=true -f null - 2>&1 | grep -E '^\s+(I|Peak):' | tr -s ' '
done
ls -l "$MEDIA"
