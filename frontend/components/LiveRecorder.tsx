"use client";

import { useEffect, useRef, useState } from "react";
import { IconMic, IconStop, IconPause, IconPlay } from "./icons";
import { fmtDuration } from "@/lib/notes";
import { toast } from "./Toast";

type Status = "idle" | "recording" | "paused";

const BARS = 48;
const SAMPLE_RATE = 16000;

function encodeWav(samples: Int16Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SAMPLE_RATE, true);
  dv.setUint32(28, SAMPLE_RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}

export default function LiveRecorder({
  onComplete,
  disabled,
}: {
  onComplete: (file: { name: string; size: number; url: string; durationSec: number }) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(BARS).fill(6));

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const pcmChunksRef = useRef<Int16Array[]>([]);
  const rafRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);

  useEffect(() => cleanup, []);

  function cleanup() {
    cancelAnimationFrame(rafRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    workletNodeRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    workletNodeRef.current = null;
  }

  const drawLoop = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / BARS) || 1;
    const next: number[] = [];
    for (let i = 0; i < BARS; i++) {
      const v = data[i * step] / 255;
      next.push(6 + v * 46);
    }
    setLevels(next);
    rafRef.current = requestAnimationFrame(drawLoop);
  };

  const start = async () => {
    if (disabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("Recording isn't supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      pcmChunksRef.current = [];

      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Load AudioWorklet for PCM conversion
      await ctx.audioWorklet.addModule("/worklets/pcm-recorder.worklet.js");
      const workletNode = new AudioWorkletNode(ctx, "pcm-recorder");
      workletNodeRef.current = workletNode;
      source.connect(workletNode);

      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        pcmChunksRef.current.push(new Int16Array(e.data));
      };

      startedAtRef.current = performance.now();
      setElapsed(0);
      tickRef.current = setInterval(
        () => setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000)),
        250
      );
      drawLoop();
      setStatus("recording");
    } catch {
      toast("Microphone permission denied");
    }
  };

  const finalize = () => {
    const dur = elapsedRef.current;
    // Combine all PCM chunks into one Int16Array
    const chunks = pcmChunksRef.current;
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const allPcm = new Int16Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      allPcm.set(c, offset);
      offset += c.length;
    }

    cleanup();
    setStatus("idle");
    setLevels(new Array(BARS).fill(6));

    if (allPcm.length === 0) return;
    const blob = encodeWav(allPcm);
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
    onComplete({
      name: `live-recording-${stamp}.wav`,
      size: blob.size,
      url,
      durationSec: Math.max(1, dur),
    });
  };

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  const pause = () => {
    if (status === "recording") {
      cancelAnimationFrame(rafRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      startedAtRef.current = performance.now() - elapsed * 1000;
      setStatus("paused");
    } else if (status === "paused") {
      startedAtRef.current = performance.now() - elapsed * 1000;
      tickRef.current = setInterval(
        () => setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000)),
        250
      );
      drawLoop();
      setStatus("recording");
    }
  };

  const stop = () => finalize();

  const live = status !== "idle";

  return (
    <div className="rounded-2xl border-2 border-dashed border-neon3/40 bg-gradient-to-b from-neon3/[0.06] to-transparent p-8">
      <div className="flex flex-col items-center">
        {/* mic orb / live pulse */}
        <div className="relative mb-5">
          {status === "recording" && (
            <span className="absolute inset-0 rounded-full bg-neon3/40 animate-ping" />
          )}
          <div
            className={`relative grid h-[84px] w-[84px] place-items-center rounded-full ${
              live
                ? "bg-[radial-gradient(circle_at_30%_30%,#ff6fd8,#a01466)]"
                : "bg-[radial-gradient(circle_at_30%_30%,#7c5cff,#3a1a8a)] animate-pulse2"
            }`}
          >
            <IconMic className="h-9 w-9 text-white" />
          </div>
        </div>

        {!live && (
          <>
            <div className="text-lg font-semibold mb-1">Record audio</div>
            <div className="text-[13px] text-muted mb-6 text-center">
              Capture straight from your microphone — we transcribe it when you stop.
            </div>
            <button
              onClick={start}
              disabled={disabled}
              className="inline-flex items-center gap-2.5 rounded-xl bg-gradient-to-br from-neon3 to-neon px-6 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_-10px_#ff4ecd] hover:-translate-y-0.5 transition-transform disabled:opacity-40 disabled:translate-y-0"
            >
              <span className="grid h-4 w-4 place-items-center">
                <span className="h-3 w-3 rounded-full bg-white" />
              </span>
              Start recording
            </button>
          </>
        )}

        {live && (
          <>
            {/* timer */}
            <div className="flex items-center gap-2 mb-4">
              <span
                className={`h-2.5 w-2.5 rounded-full bg-neon3 ${
                  status === "recording" ? "animate-pulse" : "opacity-40"
                }`}
              />
              <span className="font-mono text-2xl font-bold tabular-nums tracking-wide">
                {fmtDuration(elapsed)}
              </span>
              <span className="text-[11px] uppercase tracking-[0.15em] text-muted ml-1">
                {status === "paused" ? "Paused" : "Recording"}
              </span>
            </div>

            {/* live waveform */}
            <div className="flex h-[56px] w-full items-center justify-center gap-[3px] mb-6 overflow-hidden">
              {levels.map((h, i) => (
                <span
                  key={i}
                  className="w-[3px] shrink-0 rounded-full bg-gradient-to-t from-neon via-neon2 to-neon3 transition-[height] duration-100"
                  style={{ height: `${status === "paused" ? 6 : h}px` }}
                />
              ))}
            </div>

            {/* controls */}
            <div className="flex items-center gap-3">
              <button
                onClick={pause}
                className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/[0.06] text-white hover:bg-white/[0.12] transition-colors"
                aria-label={status === "paused" ? "Resume" : "Pause"}
              >
                {status === "paused" ? <IconPlay className="h-4 w-4" /> : <IconPause className="h-4 w-4" />}
              </button>
              <button
                onClick={stop}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-neon3 to-neon px-6 py-3 text-sm font-semibold text-white hover:-translate-y-0.5 transition-transform"
              >
                <IconStop className="h-4 w-4" /> Stop &amp; transcribe
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
