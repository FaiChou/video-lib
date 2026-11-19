import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeAv from "node-av";
import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  Conversion,
  CustomSource,
  EncodedPacketSink,
  FilePathTarget,
  Input,
  MATROSKA,
  MP3,
  MP4,
  Mp4OutputFormat,
  Output,
  PathedTarget,
  QTFF,
  QUALITY_HIGH,
  WEBM,
} from "mediabunny";
import {
  AvFrameVideoSampleResource,
  registerMediabunnyServer,
  toAvFrame,
} from "@mediabunny/server";

// Hardware auto-detection can crash the native runtime on headless servers with
// incomplete GPU drivers. Disable it for both decoding and encoding, not just
// the output encoder, so conversion works without CUDA/VAAPI dependencies.
registerMediabunnyServer({ hardwareContext: null });

const REF_SHORT_EDGE = 720;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TARGET_AUDIO_RATE = 48000;
const TARGET_AUDIO_CHANNELS = 2;
const AUDIO_CHUNK_FRAMES = 1024;

const BOLD_FONT_CANDIDATES = [
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansSC-Bold.ttf",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
];

const REGULAR_FONT_CANDIDATES = [
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
];

function createHandleSource(handle, signal) {
  return new CustomSource({
    getSize: async () => (await handle.stat()).size,
    // A demuxer may request a large range. Stream it in bounded chunks,
    // using explicit offsets so the caller's file position is untouched.
    read: (start, end) =>
      new ReadableStream({
        async pull(controller) {
          signal?.throwIfAborted();
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - start));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
          if (!bytesRead) throw new Error("媒体文件不完整，无法读取数据");
          start += bytesRead;
          controller.enqueue(chunk.subarray(0, bytesRead));
          if (start === end) controller.close();
        },
      }),
  });
}

function createVideoInput(handle, signal) {
  return new Input({
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: createHandleSource(handle, signal),
  });
}

function createAudioInput(handle, signal) {
  return new Input({
    formats: [MP3],
    source: createHandleSource(handle, signal),
  });
}

async function hasCompatibleVideoTracks(input, signal) {
  const format = await input.getFormat();
  const videos = await input.getVideoTracks();
  const audios = await input.getAudioTracks();
  if (!videos.length) throw new Error("文件不包含视频轨道");
  const tracks = [...videos, ...audios];
  const codecs = await Promise.all(tracks.map((track) => track.getCodec()));
  if (codecs.some((codec) => !codec)) throw new Error("视频包含不支持的音视频编码");
  for (const track of tracks) {
    const sink = new EncodedPacketSink(track);
    if (!(await sink.getFirstPacket()) || !(await sink.getPacket(Infinity))) {
      throw new Error("视频包含空轨道或不完整的媒体数据");
    }
  }
  signal?.throwIfAborted();
  return (
    format === MP4 &&
    codecs.slice(0, videos.length).every((codec) => codec === "avc") &&
    codecs.slice(videos.length).every((codec) => codec === "aac")
  );
}

// Inspect encoded packets only: no decoder, encoder, or output is created.
// The caller owns handle; explicit reads preserve its current position.
export async function isCompatibleVideo({ handle, signal }) {
  signal?.throwIfAborted();
  const input = createVideoInput(handle, signal);
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await hasCompatibleVideoTracks(input, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`无法处理视频，文件可能损坏或编码不受支持：${error.message}`, {
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}

export async function isValidMp3({ handle, signal }) {
  signal?.throwIfAborted();
  const input = createAudioInput(handle, signal);
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const format = await input.getFormat();
    if (format !== MP3) throw new Error("文件不是有效的 MP3 格式");
    const audios = await input.getAudioTracks();
    if (!audios.length) throw new Error("MP3 文件不包含音频轨道");
    const track = audios[0];
    if ((await track.getCodec()) !== "mp3") {
      throw new Error("音频编码不是 MP3");
    }
    const sink = new EncodedPacketSink(track);
    if (!(await sink.getFirstPacket()) || !(await sink.getPacket(Infinity))) {
      throw new Error("MP3 音频数据不完整");
    }
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("无法读取有效的 MP3 音频时长");
    }
    signal?.throwIfAborted();
    return {
      duration,
      sampleRate: track.sampleRate,
      numberOfChannels: track.numberOfChannels,
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`无效的 MP3 文件：${error.message}`, { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}

function parseHexRgb(hex, fallback = [255, 255, 255]) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    String(hex || ""),
  );
  if (!match) return fallback;
  return [
    parseInt(match[1], 16),
    parseInt(match[2], 16),
    parseInt(match[3], 16),
  ];
}

function escapeFilterValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function resolveSystemFont(bold) {
  const envPath = bold
    ? process.env.WATERMARK_FONT_BOLD || process.env.WATERMARK_FONT
    : process.env.WATERMARK_FONT;
  if (envPath && existsSync(envPath)) {
    return {
      path: envPath,
      isBoldFace: /bold|medium|heavy|black/i.test(path.basename(envPath)),
    };
  }
  const candidates = bold ? BOLD_FONT_CANDIDATES : REGULAR_FONT_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        path: candidate,
        isBoldFace: /bold|medium|heavy|black/i.test(path.basename(candidate)),
      };
    }
  }
  return { path: null, isBoldFace: false };
}

function scaleRgbaFrame(srcFrame, targetWidth, targetHeight) {
  const dstFrame = new NodeAv.Frame();
  dstFrame.alloc();
  dstFrame.width = targetWidth;
  dstFrame.height = targetHeight;
  dstFrame.format = NodeAv.AV_PIX_FMT_RGBA;
  dstFrame.allocBuffer();

  const scaler = new NodeAv.SoftwareScaleContext();
  scaler.allocContext();
  scaler.setOption("sws_flags", "lanczos");
  try {
    const ret = scaler.scaleFrameSync(dstFrame, srcFrame);
    NodeAv.FFmpegError.throwIfError(ret, "Scale RGBA frame");
    return dstFrame;
  } catch (error) {
    dstFrame.free();
    throw error;
  } finally {
    scaler.freeContext();
  }
}

async function decodePngToRgbaFrame(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (
    bytes.byteLength < 24 ||
    bytes.byteLength > 2 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(PNG_MAGIC)
  ) {
    throw new Error("无效的 PNG 图像数据");
  }
  const decoder = NodeAv.Codec.findDecoder(NodeAv.AV_CODEC_ID_PNG);
  if (!decoder) throw new Error("PNG 解码器不可用");

  const ctx = new NodeAv.CodecContext();
  ctx.allocContext3(decoder);
  const pkt = new NodeAv.Packet();
  pkt.alloc();
  const decoded = new NodeAv.Frame();
  decoded.alloc();

  let keepDecoded = false;
  try {
    NodeAv.FFmpegError.throwIfError(await ctx.open2(decoder), "open PNG decoder");
    pkt.data = bytes;
    NodeAv.FFmpegError.throwIfError(await ctx.sendPacket(pkt), "send PNG packet");
    await ctx.sendPacket(null);
    NodeAv.FFmpegError.throwIfError(
      await ctx.receiveFrame(decoded),
      "receive PNG frame",
    );
    if (
      decoded.width < 1 ||
      decoded.height < 1 ||
      decoded.width > 4096 ||
      decoded.height > 4096
    ) {
      throw new Error("水印 PNG 尺寸超出允许范围（1–4096）");
    }
    if (decoded.format === NodeAv.AV_PIX_FMT_RGBA) {
      keepDecoded = true;
      return decoded;
    }
    return scaleRgbaFrame(decoded, decoded.width, decoded.height);
  } finally {
    if (!keepDecoded) decoded.free();
    pkt.free();
    ctx.freeContext();
  }
}

export async function validateOverlayPng(buffer) {
  const frame = await decodePngToRgbaFrame(buffer);
  try {
    return { width: frame.width, height: frame.height };
  } finally {
    frame.free();
  }
}

export function computeWatermarkPlacement(
  watermark,
  videoWidth,
  videoHeight,
  badgeWidth,
  badgeHeight,
) {
  const scale = Math.min(videoWidth, videoHeight) / REF_SHORT_EDGE;
  const marginX = Math.max(0, Math.round((watermark.marginX ?? 24) * scale));
  const marginY = Math.max(0, Math.round((watermark.marginY ?? 24) * scale));
  const pos = watermark.position || "bottom-right";

  let x;
  if (pos.endsWith("-left")) x = marginX;
  else if (pos.endsWith("-right")) x = videoWidth - badgeWidth - marginX;
  else x = Math.round((videoWidth - badgeWidth) / 2);

  let y;
  if (pos.startsWith("top-")) y = marginY;
  else if (pos.startsWith("bottom-")) y = videoHeight - badgeHeight - marginY;
  else y = Math.round((videoHeight - badgeHeight) / 2);

  return {
    x: Math.max(0, Math.min(Math.max(0, videoWidth - badgeWidth), x)),
    y: Math.max(0, Math.min(Math.max(0, videoHeight - badgeHeight), y)),
    marginX,
    marginY,
    scale,
  };
}

function roundedRectCoverage(x, y, width, height, radius) {
  if (radius <= 0) return 1;
  const r = Math.min(radius, width / 2, height / 2);
  const cx = x + 0.5;
  const cy = y + 0.5;
  const dx = Math.max(r - cx, 0, cx - (width - r));
  const dy = Math.max(r - cy, 0, cy - (height - r));
  const dist = Math.hypot(dx, dy) - r;
  return Math.max(0, Math.min(1, 0.5 - dist));
}

async function renderServerTextMask(text, fontSize, fontPath) {
  const normalized = String(text).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const maxChars = Math.max(1, ...lines.map((line) => [...line].length));
  const canvasW = Math.min(
    3840,
    Math.max(256, Math.ceil(maxChars * fontSize * 1.35 + 80)),
  );
  const canvasH = Math.min(
    2160,
    Math.max(128, Math.ceil(lines.length * fontSize * 1.65 + 80)),
  );

  const tempTextPath = path.join(os.tmpdir(), `.wm-text-${randomUUID()}.txt`);
  const graph = new NodeAv.FilterGraph();
  graph.alloc();
  const srcFrame = new NodeAv.Frame();
  srcFrame.alloc();
  srcFrame.width = canvasW;
  srcFrame.height = canvasH;
  srcFrame.format = NodeAv.AV_PIX_FMT_RGBA;
  srcFrame.pts = 0n;
  srcFrame.allocBuffer();
  srcFrame.data[0].fill(0);

  const outFrame = new NodeAv.Frame();
  outFrame.alloc();
  let keepOut = false;

  try {
    await writeFile(tempTextPath, normalized, "utf8");
    const bufferSrc = graph.createFilter(
      NodeAv.Filter.getByName("buffer"),
      "src",
      `video_size=${canvasW}x${canvasH}:pix_fmt=${NodeAv.AV_PIX_FMT_RGBA}:time_base=1/1000:pixel_aspect=1/1`,
    );
    const parts = [];
    if (fontPath) parts.push(`fontfile='${escapeFilterValue(fontPath)}'`);
    parts.push(`textfile='${escapeFilterValue(tempTextPath)}'`);
    parts.push("expansion=none");
    parts.push(`fontsize=${fontSize}`);
    parts.push("fontcolor=0xFFFFFFFF");
    parts.push(`line_spacing=${Math.max(2, Math.round(fontSize * 0.25))}`);
    parts.push("x=24");
    parts.push("y=24");
    const drawtext = graph.createFilter(
      NodeAv.Filter.getByName("drawtext"),
      "dt",
      parts.join(":"),
    );
    const bufferSink = graph.createFilter(
      NodeAv.Filter.getByName("buffersink"),
      "sink",
    );
    NodeAv.FFmpegError.throwIfError(bufferSrc.link(0, drawtext, 0), "link drawtext");
    NodeAv.FFmpegError.throwIfError(drawtext.link(0, bufferSink, 0), "link sink");
    NodeAv.FFmpegError.throwIfError(await graph.config(), "config drawtext");

    NodeAv.FFmpegError.throwIfError(
      await bufferSrc.buffersrcAddFrame(srcFrame),
      "add text frame",
    );
    await bufferSrc.buffersrcAddFrame(null);
    NodeAv.FFmpegError.throwIfError(
      await bufferSink.buffersinkGetFrame(outFrame),
      "get text frame",
    );
    keepOut = true;
    return outFrame;
  } finally {
    if (!keepOut) outFrame.free();
    srcFrame.free();
    graph.free();
    await rm(tempTextPath, { force: true }).catch(() => {});
  }
}

async function buildWatermarkBadge({
  watermark,
  videoWidth,
  videoHeight,
  overlayPng = null,
  overlayScale = 3,
}) {
  const scale = Math.min(videoWidth, videoHeight) / REF_SHORT_EDGE;
  const marginX = Math.max(0, Math.round((watermark.marginX ?? 24) * scale));
  const marginY = Math.max(0, Math.round((watermark.marginY ?? 24) * scale));
  const maxBadgeW = Math.max(1, videoWidth - marginX * 2);
  const maxBadgeH = Math.max(1, videoHeight - marginY * 2);

  if (overlayPng) {
    const rawFrame = await decodePngToRgbaFrame(overlayPng);
    try {
      const srcScale =
        Number.isFinite(overlayScale) && overlayScale > 0 ? overlayScale : 3;
      let targetW = Math.max(1, Math.round((rawFrame.width / srcScale) * scale));
      let targetH = Math.max(1, Math.round((rawFrame.height / srcScale) * scale));
      const fit = Math.min(1, maxBadgeW / targetW, maxBadgeH / targetH);
      targetW = Math.max(1, Math.round(targetW * fit));
      targetH = Math.max(1, Math.round(targetH * fit));
      if (rawFrame.width === targetW && rawFrame.height === targetH) {
        const cloned = rawFrame;
        cloned.pts = 0n;
        return { frame: cloned, width: targetW, height: targetH };
      }
      const scaled = scaleRgbaFrame(rawFrame, targetW, targetH);
      scaled.pts = 0n;
      rawFrame.free();
      return { frame: scaled, width: targetW, height: targetH };
    } catch (error) {
      rawFrame.free();
      throw error;
    }
  }

  const workScale = Math.max(scale, 1);
  const workFontSize = Math.max(
    14,
    Math.round((watermark.fontSize ?? 28) * workScale),
  );
  const font = resolveSystemFont(Boolean(watermark.bold));
  const textFrame = await renderServerTextMask(
    watermark.text,
    workFontSize,
    font.path,
  );

  let badgeFrame = null;
  try {
    const buf = textFrame.data[0];
    const stride = textFrame.linesize[0];
    let minX = textFrame.width;
    let minY = textFrame.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < textFrame.height; y++) {
      const row = y * stride;
      for (let x = 0; x < textFrame.width; x++) {
        if (buf[row + x * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const fauxBold = Boolean(watermark.bold) && !font.isBoldFace;
    let textW;
    let textH;
    if (maxX < minX || maxY < minY) {
      minX = 0;
      minY = 0;
      textW = Math.max(12, Math.round(workFontSize * 2));
      textH = Math.max(12, Math.round(workFontSize));
    } else {
      textW = maxX - minX + 1 + (fauxBold ? 1 : 0);
      textH = maxY - minY + 1;
    }

    const padX = Math.max(0, Math.round((watermark.paddingX ?? 16) * workScale));
    const padY = Math.max(0, Math.round((watermark.paddingY ?? 8) * workScale));
    const badgeW = Math.max(2, textW + padX * 2);
    const badgeH = Math.max(2, textH + padY * 2);
    const radius = Math.max(0, (watermark.borderRadius ?? 8) * workScale);
    const [fgR, fgG, fgB] = parseHexRgb(watermark.color, [255, 255, 255]);
    const [bgR, bgG, bgB] = parseHexRgb(watermark.backgroundColor, [0, 0, 0]);
    const bgAlphaBase = Math.max(0, Math.min(1, watermark.backgroundOpacity ?? 0.55));
    const overallOpacity = Math.max(0, Math.min(1, watermark.opacity ?? 1));

    badgeFrame = new NodeAv.Frame();
    badgeFrame.alloc();
    badgeFrame.width = badgeW;
    badgeFrame.height = badgeH;
    badgeFrame.format = NodeAv.AV_PIX_FMT_RGBA;
    badgeFrame.pts = 0n;
    badgeFrame.allocBuffer();

    const dst = badgeFrame.data[0];
    const dstStride = badgeFrame.linesize[0];
    dst.fill(0);

    for (let y = 0; y < badgeH; y++) {
      const dstRow = y * dstStride;
      const ty = y - padY;
      const hasTextRow = maxX >= minX && ty >= 0 && ty < textH;
      const srcRow = hasTextRow ? (minY + ty) * stride : 0;

      for (let x = 0; x < badgeW; x++) {
        const bgCov = roundedRectCoverage(x, y, badgeW, badgeH, radius);
        const bgA = bgAlphaBase * bgCov;

        let fgA = 0;
        if (hasTextRow) {
          const tx = x - padX;
          if (tx >= 0 && tx < textW) {
            const origW = maxX - minX + 1;
            const a0 =
              tx < origW ? buf[srcRow + (minX + tx) * 4 + 3] / 255 : 0;
            const a1 =
              fauxBold && tx > 0 && tx - 1 < origW
                ? buf[srcRow + (minX + tx - 1) * 4 + 3] / 255
                : 0;
            fgA = Math.max(a0, a1);
          }
        }

        const outA = fgA + bgA * (1 - fgA);
        const finalA = outA * overallOpacity;
        const off = dstRow + x * 4;
        if (outA > 1e-4 && finalA > 1e-4) {
          const invOut = 1 / outA;
          const bgFactor = bgA * (1 - fgA);
          dst[off] = Math.round((fgR * fgA + bgR * bgFactor) * invOut);
          dst[off + 1] = Math.round((fgG * fgA + bgG * bgFactor) * invOut);
          dst[off + 2] = Math.round((fgB * fgA + bgB * bgFactor) * invOut);
          dst[off + 3] = Math.min(255, Math.round(finalA * 255));
        }
      }
    }

    let targetW = Math.max(1, Math.round(badgeW * (scale / workScale)));
    let targetH = Math.max(1, Math.round(badgeH * (scale / workScale)));
    const fit = Math.min(1, maxBadgeW / targetW, maxBadgeH / targetH);
    targetW = Math.max(1, Math.round(targetW * fit));
    targetH = Math.max(1, Math.round(targetH * fit));

    if (targetW === badgeW && targetH === badgeH) {
      const result = badgeFrame;
      badgeFrame = null;
      return { frame: result, width: targetW, height: targetH };
    }
    const scaled = scaleRgbaFrame(badgeFrame, targetW, targetH);
    scaled.pts = 0n;
    return { frame: scaled, width: targetW, height: targetH };
  } finally {
    textFrame.free();
    badgeFrame?.free();
  }
}

function createVideoWatermarkProcessor({
  watermark,
  overlayPng = null,
  overlayScale = 3,
}) {
  let graph = null;
  let mainSrc = null;
  let sink = null;
  let badgeFrame = null;
  let graphW = 0;
  let graphH = 0;
  let graphFmt = -1;
  let frameIndex = 0;

  function dispose() {
    graph?.free();
    graph = null;
    mainSrc = null;
    sink = null;
    badgeFrame?.free();
    badgeFrame = null;
  }

  async function initGraph(srcFrame) {
    dispose();
    const badge = await buildWatermarkBadge({
      watermark,
      videoWidth: srcFrame.width,
      videoHeight: srcFrame.height,
      overlayPng,
      overlayScale,
    });
    badgeFrame = badge.frame;
    const { x, y } = computeWatermarkPlacement(
      watermark,
      srcFrame.width,
      srcFrame.height,
      badge.width,
      badge.height,
    );

    const sarNum = srcFrame.sampleAspectRatio?.num || 1;
    const sarDen = srcFrame.sampleAspectRatio?.den || 1;

    graph = new NodeAv.FilterGraph();
    graph.alloc();
    mainSrc = graph.createFilter(
      NodeAv.Filter.getByName("buffer"),
      "main",
      `video_size=${srcFrame.width}x${srcFrame.height}:pix_fmt=${srcFrame.format}:time_base=1/1000000:pixel_aspect=${sarNum}/${sarDen}`,
    );
    const ovSrc = graph.createFilter(
      NodeAv.Filter.getByName("buffer"),
      "ov",
      `video_size=${badge.width}x${badge.height}:pix_fmt=${NodeAv.AV_PIX_FMT_RGBA}:time_base=1/1000000:pixel_aspect=1/1`,
    );
    const overlay = graph.createFilter(
      NodeAv.Filter.getByName("overlay"),
      "overlay",
      `x=${x}:y=${y}:eof_action=repeat:eval=init:format=auto`,
    );
    sink = graph.createFilter(NodeAv.Filter.getByName("buffersink"), "sink");

    NodeAv.FFmpegError.throwIfError(mainSrc.link(0, overlay, 0), "link main");
    NodeAv.FFmpegError.throwIfError(ovSrc.link(0, overlay, 1), "link overlay");
    NodeAv.FFmpegError.throwIfError(overlay.link(0, sink, 0), "link sink");
    NodeAv.FFmpegError.throwIfError(await graph.config(), "config overlay graph");
    NodeAv.FFmpegError.throwIfError(
      await ovSrc.buffersrcAddFrame(badgeFrame),
      "push watermark frame",
    );
    await ovSrc.buffersrcAddFrame(null);

    graphW = srcFrame.width;
    graphH = srcFrame.height;
    graphFmt = srcFrame.format;
  }

  async function process(sample) {
    let srcFrame;
    let srcOwned = false;
    if (sample._data instanceof AvFrameVideoSampleResource) {
      srcFrame = sample._data.frame;
    } else {
      srcFrame = new NodeAv.Frame();
      srcFrame.alloc();
      srcOwned = true;
      await toAvFrame(sample, srcFrame);
    }

    try {
      if (
        !graph ||
        srcFrame.width !== graphW ||
        srcFrame.height !== graphH ||
        srcFrame.format !== graphFmt
      ) {
        await initGraph(srcFrame);
      }
      const inRef = new NodeAv.Frame();
      inRef.alloc();
      inRef.ref(srcFrame);
      inRef.pts = BigInt(frameIndex++);
      try {
        NodeAv.FFmpegError.throwIfError(
          await mainSrc.buffersrcAddFrame(inRef),
          "push video frame",
        );
      } finally {
        inRef.free();
      }
      const outFrame = new NodeAv.Frame();
      outFrame.alloc();
      try {
        NodeAv.FFmpegError.throwIfError(
          await sink.buffersinkGetFrame(outFrame),
          "pull overlaid frame",
        );
        if (outFrame.colorPrimaries === NodeAv.AVCOL_PRI_UNSPECIFIED) {
          outFrame.colorPrimaries = srcFrame.colorPrimaries;
        }
        if (outFrame.colorTrc === NodeAv.AVCOL_TRC_UNSPECIFIED) {
          outFrame.colorTrc = srcFrame.colorTrc;
        }
        if (outFrame.colorSpace === NodeAv.AVCOL_SPC_UNSPECIFIED) {
          outFrame.colorSpace = srcFrame.colorSpace;
        }
        if (outFrame.colorRange === NodeAv.AVCOL_RANGE_UNSPECIFIED) {
          outFrame.colorRange = srcFrame.colorRange;
        }
        return new AvFrameVideoSampleResource(outFrame);
      } catch (error) {
        outFrame.free();
        throw error;
      }
    } finally {
      if (srcOwned) srcFrame.free();
    }
  }

  return { process, dispose };
}

async function* decodeTrackStereo48k(track, signal) {
  const sink = new AudioSampleSink(track);
  let graph = null;
  let abuf = null;
  let asink = null;
  let sampleSeq = 0;

  try {
    for await (const sample of sink.samples()) {
      signal?.throwIfAborted();
      const inFrame = new NodeAv.Frame();
      inFrame.alloc();
      try {
        await toAvFrame(sample, inFrame);
        if (!graph) {
          graph = new NodeAv.FilterGraph();
          graph.alloc();
          const chLayout =
            sample.numberOfChannels === 1
              ? "mono"
              : sample.numberOfChannels === 2
                ? "stereo"
                : `${sample.numberOfChannels}c`;
          const fmtName = NodeAv.avGetSampleFmtName(inFrame.format);
          abuf = graph.createFilter(
            NodeAv.Filter.getByName("abuffer"),
            "src",
            `time_base=1/${sample.sampleRate}:sample_rate=${sample.sampleRate}:sample_fmt=${fmtName}:channel_layout=${chLayout}`,
          );
          const aresample = graph.createFilter(
            NodeAv.Filter.getByName("aresample"),
            "res",
            `${TARGET_AUDIO_RATE}`,
          );
          const aformat = graph.createFilter(
            NodeAv.Filter.getByName("aformat"),
            "fmt",
            `sample_fmts=fltp:sample_rates=${TARGET_AUDIO_RATE}:channel_layouts=stereo`,
          );
          asink = graph.createFilter(NodeAv.Filter.getByName("abuffersink"), "sink");
          NodeAv.FFmpegError.throwIfError(abuf.link(0, aresample, 0), "link aresample");
          NodeAv.FFmpegError.throwIfError(
            aresample.link(0, aformat, 0),
            "link aformat",
          );
          NodeAv.FFmpegError.throwIfError(aformat.link(0, asink, 0), "link abuffersink");
          NodeAv.FFmpegError.throwIfError(await graph.config(), "config audio graph");
        }
        inFrame.pts = BigInt(
          Math.max(sampleSeq, Math.round(sample.timestamp * sample.sampleRate)),
        );
        sampleSeq = Number(inFrame.pts) + sample.numberOfFrames;
        NodeAv.FFmpegError.throwIfError(
          await abuf.buffersrcAddFrame(inFrame),
          "push audio frame",
        );
      } finally {
        inFrame.free();
        sample.close();
      }

      while (true) {
        const out = new NodeAv.Frame();
        out.alloc();
        const ret = await asink.buffersinkGetFrame(out);
        if (ret < 0) {
          out.free();
          break;
        }
        const n = out.nbSamples;
        const left = new Float32Array(
          out.data[0].buffer,
          out.data[0].byteOffset,
          n,
        ).slice();
        const right = new Float32Array(
          out.data[1].buffer,
          out.data[1].byteOffset,
          n,
        ).slice();
        const timestamp = Number(out.pts) / TARGET_AUDIO_RATE;
        out.free();
        yield { left, right, nbSamples: n, timestamp };
      }
    }

    if (graph) {
      await abuf.buffersrcAddFrame(null);
      while (true) {
        const out = new NodeAv.Frame();
        out.alloc();
        const ret = await asink.buffersinkGetFrame(out);
        if (ret < 0) {
          out.free();
          break;
        }
        const n = out.nbSamples;
        const left = new Float32Array(
          out.data[0].buffer,
          out.data[0].byteOffset,
          n,
        ).slice();
        const right = new Float32Array(
          out.data[1].buffer,
          out.data[1].byteOffset,
          n,
        ).slice();
        const timestamp = Number(out.pts) / TARGET_AUDIO_RATE;
        out.free();
        yield { left, right, nbSamples: n, timestamp };
      }
    }
  } finally {
    graph?.free();
  }
}

function createAudioCursor(openStream, { loop = false, alignTimestamp = false, signal }) {
  let active = null;
  let currentChunk = null;
  let chunkPos = 0;
  let chunkStartFrame = 0;
  let done = false;
  let yieldedAny = false;

  async function closeActive() {
    if (!active) return;
    const prev = active;
    active = null;
    await prev.iterator?.return?.().catch(() => {});
    prev.dispose?.();
  }

  async function nextChunk() {
    while (true) {
      signal?.throwIfAborted();
      if (!active) {
        active = await openStream();
        if (!active) {
          done = true;
          return null;
        }
      }
      const step = await active.iterator.next();
      if (!step.done) {
        if (step.value.nbSamples === 0) continue;
        yieldedAny = true;
        return step.value;
      }
      await closeActive();
      if (loop && yieldedAny) continue;
      done = true;
      return null;
    }
  }

  return {
    async read(leftOut, rightOut, count, startFrame) {
      leftOut.fill(0, 0, count);
      rightOut.fill(0, 0, count);
      if (done) return;

      let outPos = 0;
      while (outPos < count) {
        signal?.throwIfAborted();
        if (!currentChunk || chunkPos >= currentChunk.nbSamples) {
          currentChunk = await nextChunk();
          if (!currentChunk) break;
          chunkPos = 0;
          chunkStartFrame = alignTimestamp
            ? Math.max(0, Math.round(currentChunk.timestamp * TARGET_AUDIO_RATE))
            : startFrame + outPos;
        }

        if (alignTimestamp) {
          const globalOutFrame = startFrame + outPos;
          const chunkGlobalFrame = chunkStartFrame + chunkPos;
          if (chunkGlobalFrame > globalOutFrame) {
            const gap = Math.min(count - outPos, chunkGlobalFrame - globalOutFrame);
            outPos += gap;
            continue;
          }
          if (chunkGlobalFrame < globalOutFrame) {
            const skip = Math.min(
              currentChunk.nbSamples - chunkPos,
              globalOutFrame - chunkGlobalFrame,
            );
            chunkPos += skip;
            continue;
          }
        }

        const copy = Math.min(
          count - outPos,
          currentChunk.nbSamples - chunkPos,
        );
        leftOut.set(
          currentChunk.left.subarray(chunkPos, chunkPos + copy),
          outPos,
        );
        rightOut.set(
          currentChunk.right.subarray(chunkPos, chunkPos + copy),
          outPos,
        );
        chunkPos += copy;
        outPos += copy;
      }
    },
    dispose: closeActive,
  };
}

async function mixAudioToSource({
  videoHandle,
  hasOriginalAudio,
  musicHandle,
  musicVolume,
  musicLoop,
  duration,
  audioSource,
  signal,
  onProgress = () => {},
}) {
  const origCursor = hasOriginalAudio
    ? createAudioCursor(
        async () => {
          const inp = createVideoInput(videoHandle, signal);
          const track = await inp.getPrimaryAudioTrack();
          if (!track) {
            inp.dispose();
            return null;
          }
          return {
            iterator: decodeTrackStereo48k(track, signal)[Symbol.asyncIterator](),
            dispose: () => inp.dispose(),
          };
        },
        { loop: false, alignTimestamp: true, signal },
      )
    : null;

  const bgmCursor = createAudioCursor(
    async () => {
      const inp = createAudioInput(musicHandle, signal);
      const track = await inp.getPrimaryAudioTrack();
      if (!track) {
        inp.dispose();
        return null;
      }
      return {
        iterator: decodeTrackStereo48k(track, signal)[Symbol.asyncIterator](),
        dispose: () => inp.dispose(),
      };
    },
    { loop: Boolean(musicLoop), alignTimestamp: false, signal },
  );

  const origL = new Float32Array(AUDIO_CHUNK_FRAMES);
  const origR = new Float32Array(AUDIO_CHUNK_FRAMES);
  const bgmL = new Float32Array(AUDIO_CHUNK_FRAMES);
  const bgmR = new Float32Array(AUDIO_CHUNK_FRAMES);
  const totalSamples = Math.max(
    1,
    Math.round(Math.max(0.05, Number(duration) || 0) * TARGET_AUDIO_RATE),
  );
  const vol = Math.max(0, Math.min(2, Number(musicVolume) || 0));

  try {
    for (let pos = 0; pos < totalSamples; pos += AUDIO_CHUNK_FRAMES) {
      signal?.throwIfAborted();
      const n = Math.min(AUDIO_CHUNK_FRAMES, totalSamples - pos);
      await Promise.all([
        origCursor ? origCursor.read(origL, origR, n, pos) : Promise.resolve(),
        bgmCursor.read(bgmL, bgmR, n, pos),
      ]);
      signal?.throwIfAborted();

      const planar = new Float32Array(n * TARGET_AUDIO_CHANNELS);
      for (let i = 0; i < n; i++) {
        const l = (origCursor ? origL[i] : 0) + bgmL[i] * vol;
        const r = (origCursor ? origR[i] : 0) + bgmR[i] * vol;
        planar[i] = l > 1 ? 1 : l < -1 ? -1 : l;
        planar[n + i] = r > 1 ? 1 : r < -1 ? -1 : r;
      }
      const sample = new AudioSample({
        format: "f32-planar",
        sampleRate: TARGET_AUDIO_RATE,
        numberOfChannels: TARGET_AUDIO_CHANNELS,
        timestamp: pos / TARGET_AUDIO_RATE,
        data: planar,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      onProgress((pos + n) / totalSamples);
    }
  } finally {
    audioSource.close();
    await Promise.all([
      origCursor?.dispose().catch(() => {}),
      bgmCursor.dispose().catch(() => {}),
    ]);
  }
}

// The caller owns handle and must keep it open until this promise settles.
// outputPath must be a fresh temporary path, separate from the input file.
export async function normalizeVideo({
  handle,
  outputPath,
  onProgress = () => {},
  signal,
  watermark = null,
  watermarkOverlay = null,
  watermarkOverlayScale = 3,
  music = null,
}) {
  signal?.throwIfAborted();
  const hasWatermark = Boolean(
    watermark &&
      watermark.enabled !== false &&
      typeof watermark.text === "string" &&
      watermark.text.trim(),
  );
  const hasMusic = Boolean(music && music.handle);

  const input = createVideoInput(handle, signal);
  let output;
  let conversion;
  let cancellation;
  let watermarkProcessor = null;
  let completed = false;
  const runController = new AbortController();
  const abort = () => {
    runController.abort(signal.reason);
    input.dispose();
    if (conversion) cancellation ??= conversion.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const compatible = await hasCompatibleVideoTracks(input, signal);
    if (!hasWatermark && !hasMusic && compatible) {
      return { converted: false };
    }

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      // Defer opening the file until execute() starts. FilePathTarget opens
      // immediately and cannot close an unstarted writer after init() fails.
      target: new PathedTarget(outputPath, () => new FilePathTarget(outputPath)),
    });

    if (hasWatermark) {
      watermarkProcessor = createVideoWatermarkProcessor({
        watermark,
        overlayPng: watermarkOverlay,
        overlayScale: watermarkOverlayScale,
      });
    }

    const primaryVideo = await input.getPrimaryVideoTrack();
    const primaryVideoIsAvc = primaryVideo
      ? (await primaryVideo.getCodec()) === "avc"
      : false;

    const videoOptions = async (track) => {
      const width = await track.getDisplayWidth();
      const height = await track.getDisplayHeight();
      const evenW = Math.ceil(width / 2) * 2;
      const evenH = Math.ceil(height / 2) * 2;
      if (hasWatermark) {
        return {
          codec: "avc",
          width: evenW,
          height: evenH,
          fit: "contain",
          allowTransformationMetadata: false,
          forceTranscode: true,
          process: (sample) => watermarkProcessor.process(sample),
        };
      }
      if ((await track.getCodec()) === "avc") return { codec: "avc" };
      return {
        codec: "avc",
        width: evenW,
        height: evenH,
        fit: "contain",
      };
    };

    if (!hasMusic) {
      conversion = await Conversion.init({
        input,
        output,
        tracks: "all",
        video: videoOptions,
        audio: { codec: "aac" },
        showWarnings: false,
      });
      if (!conversion.isValid || conversion.discardedTracks.length) {
        const reasons = conversion.discardedTracks
          .map(({ track, reason }) => `${track.type}: ${reason}`)
          .join(", ");
        throw new Error(
          `无法完整转换视频的所有音视频轨道${reasons ? `（${reasons}）` : ""}`,
        );
      }
      signal?.throwIfAborted();
      conversion.onProgress = onProgress;
      await conversion.execute();
      signal?.throwIfAborted();
      completed = true;
      return { converted: true };
    }

    const videoDuration =
      (primaryVideo ? await primaryVideo.computeDuration() : 0) ||
      (await input.computeDuration());
    const hasOriginalAudio = (await input.getAudioTracks()).length > 0;

    conversion = await Conversion.init({
      input,
      output,
      composable: true,
      tracks: "all",
      video: videoOptions,
      audio: { discard: true },
      showWarnings: false,
    });
    const unexpectedDiscarded = conversion.discardedTracks.filter(
      ({ reason }) => reason !== "discarded_by_user",
    );
    if (!conversion.isValid || unexpectedDiscarded.length) {
      const reasons = unexpectedDiscarded
        .map(({ track, reason }) => `${track.type}: ${reason}`)
        .join(", ");
      throw new Error(
        `无法完整转换视频的视频轨道${reasons ? `（${reasons}）` : ""}`,
      );
    }

    const audioOut = new AudioSampleSource({
      codec: "aac",
      quality: QUALITY_HIGH,
    });
    output.addAudioTrack(audioOut);

    let videoProg = 0;
    let audioProg = 0;
    const videoWeight = hasWatermark || !primaryVideoIsAvc ? 0.8 : 0.2;
    const audioWeight = 1 - videoWeight;
    const reportCombined = () => {
      onProgress(
        Math.min(1, Math.max(0, videoProg * videoWeight + audioProg * audioWeight)),
      );
    };
    conversion.onProgress = (p) => {
      videoProg = p;
      reportCombined();
    };

    signal?.throwIfAborted();
    await output.start();
    await Promise.all([
      conversion.execute().catch((error) => {
        runController.abort(error);
        throw error;
      }),
      mixAudioToSource({
        videoHandle: handle,
        hasOriginalAudio,
        musicHandle: music.handle,
        musicVolume: music.volume ?? 0.35,
        musicLoop: music.loop !== false,
        duration: videoDuration,
        audioSource: audioOut,
        signal: runController.signal,
        onProgress: (p) => {
          audioProg = p;
          reportCombined();
        },
      }).catch((error) => {
        runController.abort(error);
        if (conversion) cancellation ??= conversion.cancel().catch(() => {});
        throw error;
      }),
    ]);
    signal?.throwIfAborted();
    await output.finalize();
    onProgress(1);
    completed = true;
    return { converted: true };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `无法处理视频，文件可能损坏或编码不受支持：${error.message}`,
      { cause: error },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    watermarkProcessor?.dispose();
    try {
      if (!completed && output) {
        await cancellation;
        if (
          conversion &&
          conversion.state !== "canceled" &&
          conversion.state !== "done"
        ) {
          await conversion.cancel().catch(() => {});
        }
        if (output.state !== "finalized") await output.cancel().catch(() => {});
        await rm(outputPath, { force: true });
      }
    } finally {
      input.dispose();
    }
  }
}
