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
  AudioSampleSink,
  Conversion,
  EncodedPacketSink,
  FilePathSource,
  Input,
  MP4,
  VideoSampleSink,
} from "mediabunny";
import { isCompatibleVideo, normalizeVideo } from "../media-converter.mjs";

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
