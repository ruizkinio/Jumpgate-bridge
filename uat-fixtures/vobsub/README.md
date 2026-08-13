# Deterministic VobSub UAT fixture

These files are original Jumpgate test media. They contain no third-party film,
music, dialogue, logos, or credentials.

- `jumpgate-uat-vobsub-v1.mp4` is an 18-second, 720x480 H.264 test card. It has
  no audio stream.
- `jumpgate-uat-vobsub-v1.zip` contains one matching IDX/SUB pair with three
  English bitmap cues at 2, 7, and 12 seconds.

The video was generated deterministically with FFmpeg 8.1 mathematical filters.
The subtitle glyphs are original hand-authored 5x7 bitmaps written through the
MIT-licensed Subtitle Edit LibSE VobSub writer at tag `v5.1.0`, commit
`38f1dd4bac6c70bdf1f2d1bb5952aa414c6cb777`. Runtime byte lengths and SHA-256
hashes are pinned in `lib/uat-vobsub-fixture.js`; Bridge startup fails if either
asset changes.

The assets are distributed under the repository MIT license.

The exact video command is:

```text
ffmpeg -v error -y -filter_threads 1 -f lavfi -i nullsrc=s=720x480:r=30:d=18,geq=lum='32+mod(X+2*Y+T*90\,160)':cb='96+mod(Y+T*45\,64)':cr='96+mod(X-T*35\,64)' -an -c:v libx264 -preset veryslow -tune zerolatency -profile:v baseline -level 3.0 -pix_fmt yuv420p -x264-params threads=1:lookahead_threads=1:sliced_threads=0:sync_lookahead=0:rc-lookahead=0:scenecut=0:open-gop=0:keyint=30:min-keyint=30:bframes=0:ref=1:nal-hrd=none -crf 20 -map_metadata -1 -metadata creation_time=1970-01-01T00:00:00Z -movflags +faststart -video_track_timescale 90000 jumpgate-uat-vobsub-v1.mp4
```

Expected asset hashes:

- MP4: `1c5877c241b9d6aec20c309e77f919478afb6648855dae2e5bbe67906bcf7303`
- ZIP: `34bb52f40bf4d26c949b4690ca82e126ef2b53cf9c91b84cd400e48ed258ebd1`
