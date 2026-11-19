import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  Conversion,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  MP4,
  Mp3OutputFormat,
  Output,
  VideoSampleSink,
} from "mediabunny";
import { deflateSync } from "node:zlib";
import {
  isCompatibleVideo,
  isValidMp3,
  normalizeVideo,
  validateOverlayPng,
} from "../media-converter.mjs";

// These 0.5-second fixtures are synthetic test patterns and a 440 Hz tone.
// Tests exercise actual codecs; ffmpeg is not needed to run this suite.
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("compatibility probes inspect every supported fixture without initializing conversion or probing GPU drivers", async () => {
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { HardwareContext } from 'node-av';
    import { Conversion } from 'mediabunny';
    import { open } from 'node:fs/promises';
    import path from 'node:path';
    HardwareContext.auto = () => { throw new Error('GPU probing is unavailable'); };
    Conversion.init = () => { throw new Error('Probing must not initialize conversion'); };
    const { isCompatibleVideo } = await import('./media-converter.mjs');
    for (const [name, compatible] of [
      ['h264-aac.mp4', true],
      ['vp9-silent-odd.webm', false],
      ['vp9-opus.webm', false],
      ['h264-pcm.mov', false],
      ['h264-aac.mov', false],
    ]) {
      const handle = await open(path.join(process.argv[1], name), 'r');
      try {
        assert.equal(await isCompatibleVideo({
          handle,
          get outputPath() { throw new Error('Probing must not access an output path'); },
        }), compatible, name);
      } finally {
        await handle.close();
      }
    }
  `, fixtures], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    timeout: 30000,
  });
});

test("compatibility probes dispose inputs without creating output, closing handles, or moving their position", async (t) => {
  const disposal = t.mock.method(Input.prototype, "dispose");
  for (const [name, compatible] of [
    ["h264-aac.mp4", true],
    ["vp9-silent-odd.webm", false],
    ["vp9-opus.webm", false],
    ["h264-pcm.mov", false],
    ["h264-aac.mov", false],
  ]) {
    const options = await fixture(t, name);
    const prefix = Buffer.alloc(7);
    await options.handle.read(prefix, 0, prefix.length, null);
    const previousDisposals = disposal.mock.callCount();
    assert.equal(await isCompatibleVideo(options), compatible, name);
    assert.equal(disposal.mock.callCount(), previousDisposals + 1);
    await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
    const next = Buffer.alloc(7);
    await options.handle.read(next, 0, next.length, null);
    assert.deepEqual(next, (await readFile(options.inputPath)).subarray(7, 14));
  }
});

test("a fresh process converts VP9 without probing GPU drivers for decoding or encoding", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-software-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "output.mp4");
  // A fresh process prevents an earlier conversion's cached hardware context
  // from hiding accidental GPU probes on a headless server.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { HardwareContext } from 'node-av';
    import { open } from 'node:fs/promises';
    HardwareContext.auto = () => { throw new Error('GPU probing is unavailable'); };
    const { normalizeVideo } = await import('./media-converter.mjs');
    const handle = await open(process.argv[1], 'r');
    try {
      const result = await normalizeVideo({ handle, outputPath: process.argv[2] });
      if (!result.converted) throw new Error('Expected VP9 to be converted');
    } finally {
      await handle.close();
    }
  `, path.join(fixtures, "vp9-opus.webm"), outputPath], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    timeout: 30000,
  });
  await assertMedia(t, outputPath, {});
});

async function fixture(t, name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-conversion-"));
  const inputPath = path.join(fixtures, name);
  const handle = await open(inputPath, "r");
  t.after(async () => {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { handle, inputPath, directory, outputPath: path.join(directory, "output.mp4") };
}

function inspect(t, file) {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  t.after(() => input.dispose());
  return input;
}

async function packetHash(track) {
  const hash = createHash("sha256");
  for await (const packet of new EncodedPacketSink(track).packets()) hash.update(packet.data);
  return hash.digest("hex");
}

async function assertMedia(t, file, { width = 64, height = 48, audio = true } = {}) {
  const input = inspect(t, file);
  assert.equal(await input.getFormat(), MP4);
  const videos = await input.getVideoTracks();
  const audios = await input.getAudioTracks();
  assert.equal(videos.length, 1);
  assert.equal(audios.length, audio ? 1 : 0);
  const track = videos[0];
  assert.equal(await track.getCodec(), "avc");
  assert.equal(await track.getDisplayWidth(), width);
  assert.equal(await track.getDisplayHeight(), height);
  const timestamps = [];
  for await (const sample of new VideoSampleSink(track, { hardwareAcceleration: "prefer-software" }).samples()) {
    timestamps.push(sample.timestamp);
    sample.close();
  }
  assert.equal(timestamps.length, 5, "all source video frames survive conversion");
  for (let index = 1; index < timestamps.length; index++) {
    assert.ok(Math.abs(timestamps[index] - timestamps[index - 1] - 0.1) < 0.002, "source frame rate is preserved");
  }
  if (audio) {
    assert.equal(await audios[0].getCodec(), "aac");
    const sample = await new AudioSampleSink(audios[0]).getSample(0.2);
    assert.ok(sample, "audio can be decoded");
    try {
      const options = { planeIndex: 0, format: "f32" };
      const samples = new Float32Array(sample.allocationSize(options) / 4);
      sample.copyTo(samples, options);
      assert.ok(samples.some((value) => Math.abs(value) > 0.01), "audio is not silent");
    } finally {
      sample.close();
    }
  }
  return input;
}

test("VP9 + Opus becomes a playable H.264 + AAC MP4 without closing the source", async (t) => {
  const options = await fixture(t, "vp9-opus.webm");
  const progress = [];
  assert.deepEqual(await normalizeVideo({ ...options, onProgress: (value) => progress.push(value) }), { converted: true });
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value) => value >= 0 && value <= 1));
  await assertMedia(t, options.outputPath);
  assert.ok((await options.handle.stat()).size > 0);
});

test("silent VP9 keeps all frames and rounds odd dimensions up for H.264", async (t) => {
  const options = await fixture(t, "vp9-silent-odd.webm");
  assert.deepEqual(await normalizeVideo(options), { converted: true });
  await assertMedia(t, options.outputPath, { width: 66, height: 50, audio: false });
});

test("H.264 + AAC MP4 passes through without creating output or moving the caller's position", async (t) => {
  const options = await fixture(t, "h264-aac.mp4");
  const prefix = Buffer.alloc(7);
  await options.handle.read(prefix, 0, prefix.length, null);
  assert.deepEqual(await normalizeVideo(options), { converted: false });
  await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
  const next = Buffer.alloc(7);
  await options.handle.read(next, 0, next.length, null);
  assert.deepEqual(next, (await readFile(options.inputPath)).subarray(7, 14));
});

test("H.264 + AAC MOV is remuxed without re-encoding either track", async (t) => {
  const options = await fixture(t, "h264-aac.mov");
  assert.deepEqual(await normalizeVideo(options), { converted: true });
  const output = await assertMedia(t, options.outputPath);
  const source = inspect(t, options.inputPath);
  const sourceTracks = await source.getTracks();
  const outputTracks = await output.getTracks();
  for (let index = 0; index < sourceTracks.length; index++) {
    assert.equal(await packetHash(outputTracks[index]), await packetHash(sourceTracks[index]));
  }
});

test("MOV with PCM audio retains H.264 packets while converting audio to AAC", async (t) => {
  const options = await fixture(t, "h264-pcm.mov");
  assert.deepEqual(await normalizeVideo(options), { converted: true });
  const output = await assertMedia(t, options.outputPath);
  const source = inspect(t, options.inputPath);
  assert.equal(await packetHash(await output.getPrimaryVideoTrack()), await packetHash(await source.getPrimaryVideoTrack()));
});

test("corrupt inputs and playlists are rejected without leaving output", async (t) => {
  const options = await fixture(t, "h264-aac.mp4");
  const data = await readFile(options.inputPath);
  for (const [name, contents] of [
    ["random.mp4", Buffer.from("not a video")],
    ["truncated.mp4", data.subarray(0, Math.floor(data.length / 2))],
    ["playlist.mp4", Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nhttps://invalid.example/video.m3u8\n")],
  ]) {
    const file = path.join(options.directory, name);
    await writeFile(file, contents);
    const handle = await open(file, "r");
    try {
      await assert.rejects(isCompatibleVideo({ handle }), /无法处理视频/);
      await assert.rejects(normalizeVideo({ handle, outputPath: options.outputPath }), /无法处理视频/);
      await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
      assert.equal((await handle.stat()).size, contents.length);
    } finally {
      await handle.close();
    }
  }
});

test("audio-only media and unknown audio codecs are rejected instead of producing silent video", async (t) => {
  const audioOnly = await fixture(t, "audio-only.m4a");
  await assert.rejects(normalizeVideo(audioOnly), /不包含视频轨道/);
  await assert.rejects(stat(audioOnly.outputPath), { code: "ENOENT" });

  const options = await fixture(t, "h264-pcm.mov");
  const unknownCodec = await readFile(options.inputPath);
  const codecOffset = unknownCodec.indexOf(Buffer.from("sowt"));
  assert.ok(codecOffset >= 0);
  unknownCodec.write("zzzz", codecOffset, "ascii");
  const file = path.join(options.directory, "unknown-audio.mov");
  await writeFile(file, unknownCodec);
  const handle = await open(file, "r");
  try {
    await assert.rejects(normalizeVideo({ handle, outputPath: options.outputPath }), /不支持的音视频编码/);
    await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
  } finally {
    await handle.close();
  }
});

test("a conversion that would discard a track fails before creating a partial output", async (t) => {
  const options = await fixture(t, "vp9-opus.webm");
  const initialize = Conversion.init;
  t.mock.method(Conversion, "init", async (settings) => {
    const conversion = await initialize(settings);
    conversion.discardedTracks.push({
      track: await settings.input.getPrimaryAudioTrack(),
      reason: "no_encodable_target_codec",
      trackOptions: { codec: "aac" },
    });
    return conversion;
  });
  await assert.rejects(normalizeVideo(options), /no_encodable_target_codec/);
  await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
  assert.ok((await options.handle.stat()).size > 0);
});

test("cancellation before and during conversion removes partial output and keeps input open", async (t) => {
  for (const beforeStart of [true, false]) {
    const options = await fixture(t, "vp9-opus.webm");
    const controller = new AbortController();
    if (beforeStart) controller.abort();
    await assert.rejects(normalizeVideo({
      ...options,
      signal: controller.signal,
      onProgress: (value) => { if (value > 0 && value < 1) controller.abort(); },
    }), { name: "AbortError" });
    await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
    assert.ok((await options.handle.stat()).size > 0);
  }
});

test("cancellation before and during probing keeps input handles open", async (t) => {
  for (const beforeStart of [true, false]) {
    const options = await fixture(t, "h264-aac.mp4");
    const controller = new AbortController();
    if (beforeStart) controller.abort();
    await assert.rejects(isCompatibleVideo({
      handle: {
        stat: () => options.handle.stat(),
        async read(...args) {
          const result = await options.handle.read(...args);
          controller.abort();
          return result;
        },
      },
      signal: controller.signal,
    }), { name: "AbortError" });
    assert.ok((await options.handle.stat()).size > 0);
    await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
  }
});

async function createTestMp3(filePath, durationSec = 0.25, freq = 660) {
  const output = new Output({
    format: new Mp3OutputFormat(),
    target: new FilePathTarget(filePath),
  });
  const source = new AudioSampleSource({ codec: "mp3", bitrate: 128000 });
  output.addAudioTrack(source);
  await output.start();
  const sampleRate = 44100;
  const totalFrames = Math.max(1152, Math.round(sampleRate * durationSec));
  const data = new Float32Array(totalFrames * 2);
  for (let i = 0; i < totalFrames; i++) {
    const val = 0.4 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    data[i] = val;
    data[totalFrames + i] = val;
  }
  const sample = new AudioSample({
    format: "f32-planar",
    sampleRate,
    numberOfChannels: 2,
    timestamp: 0,
    data,
  });
  await source.add(sample);
  sample.close();
  source.close();
  await output.finalize();
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createSolidPng(width, height, r, g, b, a = 255) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function readFrameRgba(filePath, timestamp = 0) {
  const input = new Input({ formats: [MP4], source: new FilePathSource(filePath) });
  try {
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track, { hardwareAcceleration: "prefer-software" });
    const sample = await sink.getSample(timestamp);
    assert.ok(sample);
    try {
      const rgba = Buffer.alloc(sample.allocationSize({ format: "RGBA" }));
      await sample.copyTo(rgba, { format: "RGBA" });
      return { width: sample.displayWidth, height: sample.displayHeight, rgba };
    } finally {
      sample.close();
    }
  } finally {
    input.dispose();
  }
}

test("isValidMp3 validates real MP3 files and rejects invalid data without closing handles", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp3-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mp3Path = path.join(dir, "tone.mp3");
  await createTestMp3(mp3Path, 0.25);
  const handle = await open(mp3Path, "r");
  try {
    const meta = await isValidMp3({ handle });
    assert.ok(meta.duration > 0.15);
    assert.equal(meta.numberOfChannels, 2);
    assert.equal(meta.sampleRate, 44100);
    assert.ok((await handle.stat()).size > 0);
  } finally {
    await handle.close();
  }

  const badPath = path.join(dir, "bad.mp3");
  await writeFile(badPath, "not an mp3");
  const badHandle = await open(badPath, "r");
  try {
    await assert.rejects(isValidMp3({ handle: badHandle }), /无效的 MP3/);
  } finally {
    await badHandle.close();
  }
});

test("normalizeVideo applies server text watermark and PNG overlay onto H.264 MP4", async (t) => {
  // 1. Server-rendered text watermark fallback (no overlay PNG)
  const opts = await fixture(t, "h264-aac.mp4");
  const before = await readFrameRgba(opts.inputPath, 0);
  const wmResult = await normalizeVideo({
    ...opts,
    watermark: {
      enabled: true,
      text: "DEMO",
      color: "#ffffff",
      bold: true,
      backgroundColor: "#ff0000",
      backgroundOpacity: 0.9,
      borderRadius: 6,
      fontSize: 48,
      paddingX: 20,
      paddingY: 12,
      opacity: 1,
      position: "top-left",
      marginX: 16,
      marginY: 16,
    },
  });
  assert.deepEqual(wmResult, { converted: true });
  await assertMedia(t, opts.outputPath, { width: 64, height: 48, audio: true });
  const after = await readFrameRgba(opts.outputPath, 0);
  let changed = 0;
  for (let i = 0; i < before.rgba.length; i += 4) {
    if (
      Math.abs(before.rgba[i] - after.rgba[i]) +
        Math.abs(before.rgba[i + 1] - after.rgba[i + 1]) +
        Math.abs(before.rgba[i + 2] - after.rgba[i + 2]) >
      25
    ) {
      changed++;
    }
  }
  assert.ok(changed > 10, "expected watermark to modify visible video pixels");

  // 2. High-DPI browser PNG overlay path using normalized drag coordinates (x, y)
  const pngOpts = await fixture(t, "vp9-silent-odd.webm");
  const redPng = createSolidPng(180, 90, 255, 0, 0, 220);
  const pngMeta = await validateOverlayPng(redPng);
  assert.deepEqual(pngMeta, { width: 180, height: 90 });
  const pngResult = await normalizeVideo({
    ...pngOpts,
    watermark: {
      enabled: true,
      text: "PNG",
      x: 0.1,
      y: 0.1,
    },
    watermarkOverlay: redPng,
    watermarkOverlayScale: 1,
  });
  assert.deepEqual(pngResult, { converted: true });
  await assertMedia(t, pngOpts.outputPath, { width: 66, height: 50, audio: false });
  const overlaid = await readFrameRgba(pngOpts.outputPath, 0);
  const off = (6 * overlaid.width + 8) * 4;
  assert.ok(overlaid.rgba[off] > 170 && overlaid.rgba[off + 2] < 80, "expected red PNG overlay near drag coordinate");
});

test("normalizeVideo mixes looping MP3 background music into both audio and silent videos and combined watermark+music", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bgm-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mp3Path = path.join(dir, "bgm.mp3");
  await createTestMp3(mp3Path, 0.2, 880);
  const musicHandle = await open(mp3Path, "r");
  t.after(() => musicHandle.close());

  // Silent VP9 gains a stereo AAC audio track from looping MP3
  const silentOpts = await fixture(t, "vp9-silent-odd.webm");
  const silentRes = await normalizeVideo({
    ...silentOpts,
    music: { handle: musicHandle, volume: 0.6, loop: true },
  });
  assert.deepEqual(silentRes, { converted: true });
  await assertMedia(t, silentOpts.outputPath, { width: 66, height: 50, audio: true });
  const silentCheck = inspect(t, silentOpts.outputPath);
  const silentAudio = await silentCheck.getPrimaryAudioTrack();
  // Verify audio around 0.35s (beyond 0.2s MP3 length) is non-silent due to looping
  const lateSample = await new AudioSampleSink(silentAudio).getSample(0.35);
  assert.ok(lateSample);
  const lateF32 = new Float32Array(lateSample.allocationSize({ planeIndex: 0, format: "f32" }) / 4);
  lateSample.copyTo(lateF32, { planeIndex: 0, format: "f32" });
  lateSample.close();
  assert.ok(lateF32.some((v) => Math.abs(v) > 0.05), "looped BGM should keep playing past 0.2s");

  // H.264 + AAC MP4 with both watermark and non-looping music
  const comboOpts = await fixture(t, "h264-aac.mp4");
  const progress = [];
  const comboRes = await normalizeVideo({
    ...comboOpts,
    onProgress: (p) => progress.push(p),
    watermark: {
      enabled: true,
      text: "BOTH",
      color: "#ffffff",
      bold: false,
      backgroundColor: "#000000",
      backgroundOpacity: 0.7,
      borderRadius: 4,
      fontSize: 32,
      paddingX: 12,
      paddingY: 8,
      opacity: 1,
      position: "bottom-right",
      marginX: 20,
      marginY: 20,
    },
    music: { handle: musicHandle, volume: 0.4, loop: false },
  });
  assert.deepEqual(comboRes, { converted: true });
  assert.equal(progress.at(-1), 1);
  await assertMedia(t, comboOpts.outputPath, { width: 64, height: 48, audio: true });

  // keepOriginalAudio: false mutes original video audio completely when music volume is 0
  const mutedOpts = await fixture(t, "h264-aac.mp4");
  const mutedRes = await normalizeVideo({
    ...mutedOpts,
    music: { handle: musicHandle, volume: 0, loop: false, keepOriginalAudio: false },
  });
  assert.deepEqual(mutedRes, { converted: true });
  const mutedInput = inspect(t, mutedOpts.outputPath);
  const mutedTrack = await mutedInput.getPrimaryAudioTrack();
  const mutedSample = await new AudioSampleSink(mutedTrack).getSample(0.2);
  assert.ok(mutedSample);
  const mutedF32 = new Float32Array(mutedSample.allocationSize({ planeIndex: 0, format: "f32" }) / 4);
  mutedSample.copyTo(mutedF32, { planeIndex: 0, format: "f32" });
  mutedSample.close();
  const maxAmp = mutedF32.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(maxAmp < 0.005, `expected original audio to be muted, got maxAmp=${maxAmp}`);
});

test("cancellation during watermark + music conversion removes partial output", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bgm-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mp3Path = path.join(dir, "bgm.mp3");
  await createTestMp3(mp3Path, 0.2, 660);
  const musicHandle = await open(mp3Path, "r");
  t.after(() => musicHandle.close());

  const options = await fixture(t, "vp9-opus.webm");
  const controller = new AbortController();
  await assert.rejects(
    normalizeVideo({
      ...options,
      signal: controller.signal,
      watermark: {
        enabled: true,
        text: "CANCEL",
        position: "center",
        marginX: 0,
        marginY: 0,
        fontSize: 24,
        paddingX: 8,
        paddingY: 4,
        borderRadius: 4,
        color: "#ffffff",
        backgroundColor: "#000000",
        backgroundOpacity: 0.6,
        opacity: 1,
        bold: false,
      },
      music: { handle: musicHandle, volume: 0.5, loop: true },
      onProgress: (value) => {
        if (value > 0 && value < 1) controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  await assert.rejects(stat(options.outputPath), { code: "ENOENT" });
});
