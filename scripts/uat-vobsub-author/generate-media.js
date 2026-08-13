"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_SHA256 = "f976676998f0bd96fbec35daf20aaa128ff3fc82c68af5177867841b79b4060b";
const EXPECTED_SIZE = 3722302;

if (process.argv.length !== 3) {
  console.error("usage: node generate-media.js <output-directory>");
  process.exit(2);
}

const ticks = Array.from({ length: 19 }, (_, second) =>
  `drawbox=x=${36 + second * 36}:y=23:w=2:h=24:color=white:t=fill`
);
const fills = Array.from({ length: 18 }, (_, index) => {
  const second = index + 1;
  return `drawbox=x=${38 + index * 36}:y=25:w=34:h=20:color=white@0.85:t=fill:enable='gte(t,${second})'`;
});
const filter = [
  "nullsrc=s=720x480:r=30:d=18",
  "geq=lum='32+mod(X+2*Y+T*90\\,160)':cb='96+mod(Y+T*45\\,64)':cr='96+mod(X-T*35\\,64)'",
  "drawbox=x=34:y=21:w=652:h=28:color=black@0.8:t=fill",
  ...ticks,
  ...fills,
].join(",");

const output = path.resolve(process.argv[2], "jumpgate-uat-vobsub-v1.mp4");
const version = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (version.error || version.status !== 0 || !/^ffmpeg version 8\.1(?:[- ]|$)/.test(version.stdout)) {
  console.error("fixture generation requires exactly FFmpeg 8.1");
  process.exit(1);
}
const result = spawnSync("ffmpeg", [
  "-v", "error", "-y", "-filter_threads", "1", "-f", "lavfi", "-i", filter,
  "-an", "-c:v", "libx264", "-preset", "veryslow", "-tune", "zerolatency",
  "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
  "-x264-params",
  "threads=1:lookahead_threads=1:sliced_threads=0:sync_lookahead=0:rc-lookahead=0:scenecut=0:open-gop=0:keyint=30:min-keyint=30:bframes=0:ref=1:nal-hrd=none",
  "-crf", "20", "-map_metadata", "-1", "-metadata", "creation_time=1970-01-01T00:00:00Z",
  "-movflags", "+faststart", "-video_track_timescale", "90000", output,
], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const bytes = fs.readFileSync(output);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (bytes.length !== EXPECTED_SIZE || digest !== EXPECTED_SHA256) {
  console.error("generated media does not match the reviewed FFmpeg 8.1 fixture bytes");
  process.exit(1);
}

const probe = spawnSync("ffprobe", [
  "-v", "error", "-show_entries",
  "format=duration:stream=codec_name,profile,width,height,r_frame_rate,time_base,nb_frames,codec_type",
  "-of", "json", output,
], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error("ffprobe failed to verify generated media");
  process.exit(1);
}
let metadata;
try {
  metadata = JSON.parse(probe.stdout);
} catch {
  console.error("ffprobe returned invalid JSON");
  process.exit(1);
}
const streams = metadata.streams || [];
const video = streams[0];
if (
  streams.length !== 1 || video?.codec_type !== "video" || video.codec_name !== "h264" ||
  video.profile !== "Constrained Baseline" || video.width !== 720 || video.height !== 480 ||
  video.r_frame_rate !== "30/1" || video.time_base !== "1/90000" || video.nb_frames !== "540" ||
  metadata.format?.duration !== "18.000000"
) {
  console.error("generated media does not match the reviewed stream semantics");
  process.exit(1);
}
