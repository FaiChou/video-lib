import { rm } from "node:fs/promises";
import {
  Conversion,
  CustomSource,
  EncodedPacketSink,
  FilePathTarget,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  PathedTarget,
  QTFF,
  WEBM,
} from "mediabunny";
import { registerMediabunnyServer } from "@mediabunny/server";

registerMediabunnyServer();

// The caller owns handle and must keep it open until this promise settles.
// outputPath must be a fresh temporary path, separate from the input file.
export async function normalizeVideo({
  handle,
  outputPath,
  onProgress = () => {},
  signal,
}) {
  signal?.throwIfAborted();
  const input = new Input({
    formats: [MP4, QTFF, WEBM, MATROSKA],
    source: new CustomSource({
      getSize: async () => (await handle.stat()).size,
      // A demuxer may request a large range. Stream it in bounded chunks,
      // using explicit offsets so the caller's file position is untouched.
      read: (start, end) => new ReadableStream({
        async pull(controller) {
          signal?.throwIfAborted();
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - start));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
          if (!bytesRead) throw new Error("视频文件不完整，无法读取媒体数据");
          start += bytesRead;
          controller.enqueue(chunk.subarray(0, bytesRead));
          if (start === end) controller.close();
        },
      }),
    }),
  });
  let output;
  let conversion;
  let cancellation;
  let completed = false;
  const abort = () => {
    input.dispose();
    if (conversion) cancellation ??= conversion.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
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
    if (
      format === MP4 &&
      codecs.slice(0, videos.length).every((codec) => codec === "avc") &&
      codecs.slice(videos.length).every((codec) => codec === "aac")
    ) {
      return { converted: false };
    }

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      // Defer opening the file until execute() starts. FilePathTarget opens
      // immediately and cannot close an unstarted writer after init() fails.
      target: new PathedTarget(outputPath, () => new FilePathTarget(outputPath)),
    });
    conversion = await Conversion.init({
      input,
      output,
      tracks: "all",
      video: async (track) => {
        if ((await track.getCodec()) === "avc") return { codec: "avc" };
        const width = await track.getDisplayWidth();
        const height = await track.getDisplayHeight();
        return {
          codec: "avc",
          width: Math.ceil(width / 2) * 2,
          height: Math.ceil(height / 2) * 2,
          fit: "contain",
        };
      },
      audio: { codec: "aac" },
      showWarnings: false,
    });
    if (!conversion.isValid || conversion.discardedTracks.length) {
      const reasons = conversion.discardedTracks
        .map(({ track, reason }) => `${track.type}: ${reason}`)
        .join(", ");
      throw new Error(`无法完整转换视频的所有音视频轨道${reasons ? `（${reasons}）` : ""}`);
    }
    signal?.throwIfAborted();
    conversion.onProgress = onProgress;
    await conversion.execute();
    signal?.throwIfAborted();
    completed = true;
    return { converted: true };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`无法处理视频，文件可能损坏或编码不受支持：${error.message}`, { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      if (!completed && output) {
        await cancellation;
        if (conversion && conversion.state !== "canceled" && conversion.state !== "done") {
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
