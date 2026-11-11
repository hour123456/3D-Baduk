interface ModalPartial {
  freq: number;
  amp: number;
  decaySec: number;
  phase?: number;
}

export class AcousticStoneAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private dryBus: GainNode | null = null;
  private wetBus: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  private volume = 0.85;
  private muted = false;
  private initialized = false;

  private slateClackBuffers: AudioBuffer[] = [];
  private shellClackBuffers: AudioBuffer[] = [];
  private bowlWoodTapBuffers: AudioBuffer[] = [];
  private slideGrainBuffers: AudioBuffer[] = [];
  private boardCenterSnapBuffers: AudioBuffer[] = [];
  private boardEdgeSnapBuffers: AudioBuffer[] = [];
  private lidWoodDropBuffers: AudioBuffer[] = [];

  private lastBowlRattleTime = 0;

  public ensureReady(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -10;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.001;
      this.compressor.release.value = 0.09;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;

      this.dryBus = this.ctx.createGain();
      this.dryBus.gain.value = 0.86;

      this.wetBus = this.ctx.createGain();
      this.wetBus.gain.value = 0.22;

      this.convolver = this.ctx.createConvolver();
      this.convolver.buffer = this.buildTraditionalRoomIR(this.ctx);

      this.dryBus.connect(this.compressor);
      this.wetBus.connect(this.convolver);
      this.convolver.connect(this.compressor);
      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this.synthesizeBufferBanks(this.ctx);
      this.initialized = true;
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.015);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.015);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  private buildTraditionalRoomIR(ctx: AudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const duration = 0.34;
    const length = Math.floor(sr * duration);
    const buffer = ctx.createBuffer(2, length, sr);

    const earlyReflectionsMs = [
      { ms: 4.2, gainL: 0.42, gainR: 0.31 },
      { ms: 8.7, gainL: -0.28, gainR: 0.36 },
      { ms: 13.5, gainL: 0.24, gainR: -0.22 },
      { ms: 19.8, gainL: 0.18, gainR: 0.21 },
      { ms: 27.4, gainL: -0.14, gainR: 0.15 },
    ];

    let seed = 135792468;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lpState = 0;

      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const env = Math.exp(-t / 0.068) * 0.55 + Math.exp(-t / 0.14) * 0.18;
        const white = rand() * env * (t < 0.003 ? t / 0.003 : 1);
        const alpha = Math.max(0.08, 0.48 - t * 1.1);
        lpState += alpha * (white - lpState);
        data[i] = lpState * 0.45;
      }

      for (const er of earlyReflectionsMs) {
        const idx = Math.floor((er.ms / 1000) * sr);
        if (idx < length - 8) {
          const g = ch === 0 ? er.gainL : er.gainR;
          data[idx] += g * 0.5;
          data[idx + 1] += g * 0.32;
          data[idx + 2] += g * 0.14;
        }
      }
    }

    return buffer;
  }

  private renderModalImpactBuffer(
    ctx: AudioContext,
    durationSec: number,
    contactPulseSec: number,
    contactGain: number,
    partials: ModalPartial[],
    noiseBurstGain = 0,
    noiseFreqHz = 2800
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * durationSec);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    const pulseSamples = Math.max(4, Math.floor(contactPulseSec * sr));
    for (let i = 0; i < pulseSamples && i < len; i++) {
      const s = Math.sin((Math.PI * i) / pulseSamples);
      out[i] += contactGain * Math.pow(s, 1.5);
    }

    for (const p of partials) {
      const omega = (2 * Math.PI * p.freq) / sr;
      const phase0 = p.phase ?? 0;
      const decayPerSample = Math.exp(-1 / (p.decaySec * sr));
      let env = p.amp;
      const attackSamples = Math.max(3, Math.floor(0.00025 * sr));
      for (let i = 0; i < len; i++) {
        const atk = i < attackSamples ? i / attackSamples : 1;
        out[i] += atk * env * Math.sin(omega * i + phase0);
        env *= decayPerSample;
        if (env < 1e-5) break;
      }
    }

    if (noiseBurstGain > 0) {
      let bpY1 = 0;
      let bpY2 = 0;
      const f0 = noiseFreqHz / sr;
      const r = 0.86;
      const a1 = -2 * r * Math.cos(2 * Math.PI * f0);
      const a2 = r * r;
      let rng = Math.floor(partials[0]?.freq * 997 || 424242) >>> 0;

      for (let i = 0; i < Math.min(len, Math.floor(sr * 0.018)); i++) {
        rng = (rng * 1664525 + 1013904223) >>> 0;
        const n = (rng / 0xffffffff) * 2 - 1;
        const t = i / sr;
        const env = Math.exp(-t / 0.0032) * noiseBurstGain;
        const y = n * (1 - r) - a1 * bpY1 - a2 * bpY2;
        bpY2 = bpY1;
        bpY1 = y;
        out[i] += y * env;
      }
    }

    return buf;
  }

  private synthesizeBufferBanks(ctx: AudioContext): void {
    for (let v = 0; v < 8; v++) {
      const detune = 0.94 + v * 0.018;
      this.slateClackBuffers.push(
        this.renderModalImpactBuffer(
          ctx,
          0.065,
          0.00028,
          0.52,
          [
            { freq: 1980 * detune, amp: 0.34, decaySec: 0.0095, phase: 0.2 },
            { freq: 2680 * detune, amp: 0.42, decaySec: 0.0078, phase: 0.7 },
            { freq: 4120 * detune, amp: 0.31, decaySec: 0.0052, phase: 1.3 },
            { freq: 6380 * detune, amp: 0.21, decaySec: 0.0034, phase: 2.1 },
            { freq: 9450 * detune, amp: 0.11, decaySec: 0.0021, phase: 0.4 },
            { freq: 580 * detune, amp: 0.14, decaySec: 0.011, phase: 0.0 },
          ],
          0.16,
          3400 * detune
        )
      );
    }

    for (let v = 0; v < 8; v++) {
      const detune = 0.95 + v * 0.017;
      this.shellClackBuffers.push(
        this.renderModalImpactBuffer(
          ctx,
          0.065,
          0.00024,
          0.54,
          [
            { freq: 2240 * detune, amp: 0.32, decaySec: 0.009, phase: 0.1 },
            { freq: 3020 * detune, amp: 0.44, decaySec: 0.0074, phase: 0.9 },
            { freq: 4680 * detune, amp: 0.34, decaySec: 0.0049, phase: 1.5 },
            { freq: 7250 * detune, amp: 0.24, decaySec: 0.0032, phase: 2.4 },
            { freq: 10800 * detune, amp: 0.13, decaySec: 0.0019, phase: 0.8 },
            { freq: 640 * detune, amp: 0.12, decaySec: 0.01, phase: 0.0 },
          ],
          0.15,
          4100 * detune
        )
      );
    }

    for (let v = 0; v < 5; v++) {
      const d = 0.95 + v * 0.025;
      this.bowlWoodTapBuffers.push(
        this.renderModalImpactBuffer(
          ctx,
          0.14,
          0.00065,
          0.42,
          [
            { freq: 285 * d, amp: 0.38, decaySec: 0.032 },
            { freq: 468 * d, amp: 0.45, decaySec: 0.026, phase: 0.4 },
            { freq: 785 * d, amp: 0.29, decaySec: 0.018, phase: 1.1 },
            { freq: 1320 * d, amp: 0.18, decaySec: 0.011, phase: 1.8 },
            { freq: 2450 * d, amp: 0.11, decaySec: 0.0055, phase: 0.5 },
          ],
          0.12,
          1650 * d
        )
      );
    }

    for (let v = 0; v < 4; v++) {
      this.slideGrainBuffers.push(this.buildMineralSlideBuffer(ctx, 0.09 + v * 0.025, 2200 + v * 320));
    }

    for (let v = 0; v < 6; v++) {
      this.boardCenterSnapBuffers.push(this.buildGobanSnapBuffer(ctx, true, v));
      this.boardEdgeSnapBuffers.push(this.buildGobanSnapBuffer(ctx, false, v));
    }

    for (let v = 0; v < 5; v++) {
      const d = 0.96 + v * 0.022;
      this.lidWoodDropBuffers.push(
        this.renderModalImpactBuffer(
          ctx,
          0.12,
          0.00048,
          0.48,
          [
            { freq: 375 * d, amp: 0.36, decaySec: 0.024 },
            { freq: 690 * d, amp: 0.44, decaySec: 0.019, phase: 0.5 },
            { freq: 1290 * d, amp: 0.31, decaySec: 0.012, phase: 1.2 },
            { freq: 2380 * d, amp: 0.22, decaySec: 0.006, phase: 2.0 },
            { freq: 4150 * d, amp: 0.14, decaySec: 0.0035, phase: 0.7 },
          ],
          0.14,
          2300 * d
        )
      );
    }
  }

  private buildGobanSnapBuffer(ctx: AudioContext, isCenter: boolean, variant: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const duration = 0.22;
    const len = Math.floor(sr * duration);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    const d = 0.965 + variant * 0.014;
    const snapDelaySec = 0.0016 + (variant % 4) * 0.00042;
    const snapOffset = Math.floor(snapDelaySec * sr);

    const rimPartials: ModalPartial[] = [
      { freq: (isCenter ? 310 : 390) * d, amp: 0.16, decaySec: 0.016 },
      { freq: 1680 * d, amp: 0.22, decaySec: 0.0055, phase: 0.4 },
      { freq: 3350 * d, amp: 0.18, decaySec: 0.0032, phase: 1.1 },
    ];
    const rimBuf = this.renderModalImpactBuffer(ctx, 0.04, 0.00032, 0.26, rimPartials, 0.08, 2900);
    const rimData = rimBuf.getChannelData(0);
    for (let i = 0; i < rimData.length && i < len; i++) {
      out[i] += rimData[i];
    }

    const bodyPartials: ModalPartial[] = isCenter
      ? [
          { freq: 156 * d, amp: 0.46, decaySec: 0.046 },
          { freq: 258 * d, amp: 0.52, decaySec: 0.032, phase: 0.3 },
          { freq: 472 * d, amp: 0.38, decaySec: 0.021, phase: 0.8 },
          { freq: 890 * d, amp: 0.29, decaySec: 0.013, phase: 1.4 },
          { freq: 1760 * d, amp: 0.33, decaySec: 0.0068, phase: 0.6 },
          { freq: 3120 * d, amp: 0.27, decaySec: 0.0039, phase: 1.9 },
          { freq: 5280 * d, amp: 0.14, decaySec: 0.0023, phase: 0.2 },
        ]
      : [
          { freq: 192 * d, amp: 0.32, decaySec: 0.035 },
          { freq: 328 * d, amp: 0.48, decaySec: 0.026, phase: 0.3 },
          { freq: 615 * d, amp: 0.42, decaySec: 0.018, phase: 0.9 },
          { freq: 1140 * d, amp: 0.34, decaySec: 0.011, phase: 1.5 },
          { freq: 2150 * d, amp: 0.36, decaySec: 0.0058, phase: 0.7 },
          { freq: 3680 * d, amp: 0.29, decaySec: 0.0035, phase: 2.1 },
          { freq: 5850 * d, amp: 0.16, decaySec: 0.0021, phase: 0.4 },
        ];

    const bodyBuf = this.renderModalImpactBuffer(
      ctx,
      0.19,
      0.00048,
      0.64,
      bodyPartials,
      0.24,
      isCenter ? 2650 * d : 3200 * d
    );
    const bodyData = bodyBuf.getChannelData(0);
    for (let i = 0; i < bodyData.length && i + snapOffset < len; i++) {
      out[i + snapOffset] += bodyData[i];
    }

    return buf;
  }

  private buildMineralSlideBuffer(ctx: AudioContext, durationSec: number, centerHz: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * durationSec);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    let y1 = 0;
    let y2 = 0;
    const f0 = centerHz / sr;
    const r = 0.91;
    const a1 = -2 * r * Math.cos(2 * Math.PI * f0);
    const a2 = r * r;
    let seed = Math.floor(centerHz * 73) >>> 0;

    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = (seed / 0xffffffff) * 2 - 1;
      const u = i / len;
      const grain = 0.65 + 0.35 * Math.sin(2 * Math.PI * u * 11);
      const env = Math.sin(Math.PI * u) * Math.exp(-u * 1.8) * grain;
      const y = n * (1 - r) - a1 * y1 - a2 * y2;
      y2 = y1;
      y1 = y;
      out[i] = y * env * 0.24;
    }

    return buf;
  }

  private scheduleBuffer(
    buffer: AudioBuffer,
    when: number,
    gain: number,
    playbackRate = 1.0,
    pan = 0,
    lowpassHz?: number
  ): void {
    if (!this.ctx || !this.dryBus || !this.wetBus || this.muted) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;

    const gNode = this.ctx.createGain();
    gNode.gain.value = gain;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-0.85, Math.min(0.85, pan));

    if (lowpassHz) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpassHz;
      filter.Q.value = 0.7;
      src.connect(filter);
      filter.connect(gNode);
    } else {
      src.connect(gNode);
    }

    gNode.connect(panner);
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);

    src.start(Math.max(this.ctx.currentTime, when));
  }

  public playBowlRattle(side: 'left' | 'right', intensity = 0.75, isBlackBowl = side === 'right'): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted) return;

    const nowPerf = performance.now();
    if (nowPerf - this.lastBowlRattleTime < 110) return;
    this.lastBowlRattleTime = nowPerf;

    const now = this.ctx.currentTime + 0.004;
    const basePan = side === 'left' ? -0.48 : 0.48;
    const clampedIntensity = Math.max(0.25, Math.min(1.2, intensity));
    const stoneBank = isBlackBowl ? this.slateClackBuffers : this.shellClackBuffers;

    const count = Math.floor(6 + clampedIntensity * 8);
    let cursor = 0;

    const slideBuf = this.slideGrainBuffers[Math.floor(Math.random() * this.slideGrainBuffers.length)];
    this.scheduleBuffer(slideBuf, now + 0.008, 0.26 * clampedIntensity, 0.92 + Math.random() * 0.18, basePan);

    for (let i = 0; i < count; i++) {
      const progress = i / count;
      const stepSec = (0.005 + Math.random() * 0.022) * (0.7 + progress * 1.45);
      cursor += stepSec;

      const buf = stoneBank[Math.floor(Math.random() * stoneBank.length)];
      const decayEnvelope = Math.pow(1 - progress * 0.72, 1.35);
      const velocity = (0.16 + Math.random() * 0.28) * clampedIntensity * decayEnvelope;
      const rate = 0.91 + Math.random() * 0.2;
      const panJitter = basePan + (Math.random() - 0.5) * 0.14;
      const lp = 4800 + Math.random() * 6500;

      this.scheduleBuffer(buf, now + cursor, velocity, rate, panJitter, lp);

      if (i % 3 === 1) {
        const woodBuf = this.bowlWoodTapBuffers[Math.floor(Math.random() * this.bowlWoodTapBuffers.length)];
        this.scheduleBuffer(
          woodBuf,
          now + cursor + 0.0015,
          velocity * 0.52,
          0.94 + Math.random() * 0.12,
          panJitter
        );
      }
    }
  }

  public playStonePickup(side: 'left' | 'right', isBlack = side === 'right'): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted) return;

    const now = this.ctx.currentTime + 0.003;
    const pan = side === 'left' ? -0.45 : 0.45;
    const bank = isBlack ? this.slateClackBuffers : this.shellClackBuffers;

    const slideBuf = this.slideGrainBuffers[Math.floor(Math.random() * this.slideGrainBuffers.length)];
    this.scheduleBuffer(slideBuf, now, 0.18, 1.08, pan);

    const offsets = [0.006, 0.024 + Math.random() * 0.012, 0.052 + Math.random() * 0.018];
    offsets.forEach((dt, idx) => {
      const buf = bank[Math.floor(Math.random() * bank.length)];
      const gain = (0.2 - idx * 0.045) * (0.85 + Math.random() * 0.3);
      this.scheduleBuffer(buf, now + dt, gain, 0.96 + Math.random() * 0.14, pan, 6200);
    });
  }

  public playStonePlace(params: {
    normX: number;
    normY: number;
    force?: number;
    isBlack: boolean;
    adjacentStones?: number;
  }): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted) return;

    const now = this.ctx.currentTime + 0.002;
    const force = Math.max(0.55, Math.min(1.25, params.force ?? 0.92));
    const pan = params.normX * 0.36;

    const radialDist = Math.min(1, Math.hypot(params.normX, params.normY) / 1.25);
    const centerWeight = 1 - radialDist * 0.8;
    const edgeWeight = radialDist * 0.85;

    const vIdx = Math.floor(Math.random() * this.boardCenterSnapBuffers.length);
    const rateJitter = (params.isBlack ? 0.985 : 1.015) * (0.97 + Math.random() * 0.06);

    if (centerWeight > 0.12) {
      this.scheduleBuffer(
        this.boardCenterSnapBuffers[vIdx],
        now,
        0.72 * force * centerWeight,
        rateJitter,
        pan
      );
    }
    if (edgeWeight > 0.12) {
      this.scheduleBuffer(
        this.boardEdgeSnapBuffers[vIdx],
        now,
        0.72 * force * edgeWeight,
        rateJitter * 1.02,
        pan
      );
    }

    const stoneBank = params.isBlack ? this.slateClackBuffers : this.shellClackBuffers;
    const bodyClick = stoneBank[Math.floor(Math.random() * stoneBank.length)];
    this.scheduleBuffer(bodyClick, now + 0.0018, 0.18 * force, rateJitter, pan, 5400);

    const adj = params.adjacentStones ?? 0;
    if (adj > 0) {
      const clinkCount = Math.min(3, adj);
      for (let i = 0; i < clinkCount; i++) {
        const delay = 0.0055 + i * 0.0085 + Math.random() * 0.005;
        const clinkBuf = stoneBank[Math.floor(Math.random() * stoneBank.length)];
        const clinkGain = (0.14 + Math.random() * 0.1) * force * (1 - i * 0.22);
        this.scheduleBuffer(
          clinkBuf,
          now + delay,
          clinkGain,
          0.98 + Math.random() * 0.12,
          pan + (Math.random() - 0.5) * 0.06,
          7800
        );
      }
    }
  }

  public playCaptureToLid(
    capturedCount: number,
    existingPrisoners: number,
    side: 'left' | 'right',
    capturedAreBlack = false
  ): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted || capturedCount <= 0) return;

    const now = this.ctx.currentTime + 0.005;
    const pan = side === 'left' ? -0.52 : 0.52;
    const stoneBank = capturedAreBlack ? this.slateClackBuffers : this.shellClackBuffers;
    const dropsToPlay = Math.min(8, capturedCount);

    for (let k = 0; k < dropsToPlay; k++) {
      const baseDelay = k * (0.042 + Math.random() * 0.022);
      const lidBuf = this.lidWoodDropBuffers[Math.floor(Math.random() * this.lidWoodDropBuffers.length)];
      const prisonerDensity = Math.min(1, (existingPrisoners + k) / 6);

      this.scheduleBuffer(
        lidBuf,
        now + baseDelay,
        0.38 * (1 - prisonerDensity * 0.35),
        0.96 + Math.random() * 0.1,
        pan
      );

      this.scheduleBuffer(
        lidBuf,
        now + baseDelay + 0.032 + Math.random() * 0.012,
        0.13,
        1.08 + Math.random() * 0.08,
        pan,
        4200
      );

      if (existingPrisoners + k > 0) {
        const clink1 = stoneBank[Math.floor(Math.random() * stoneBank.length)];
        this.scheduleBuffer(
          clink1,
          now + baseDelay + 0.002,
          0.26 + prisonerDensity * 0.16,
          0.95 + Math.random() * 0.15,
          pan + (Math.random() - 0.5) * 0.08
        );

        const clink2 = stoneBank[Math.floor(Math.random() * stoneBank.length)];
        this.scheduleBuffer(
          clink2,
          now + baseDelay + 0.024 + Math.random() * 0.014,
          0.14 + prisonerDensity * 0.08,
          1.03 + Math.random() * 0.12,
          pan
        );
      }
    }
  }

  public playByoyomiTick(secondsLeft: number): void {
    this.ensureReady();
    if (!this.ctx || !this.dryBus || this.muted) return;

    const now = this.ctx.currentTime + 0.002;
    const isUrgent = secondsLeft <= 3;
    const freq = isUrgent ? 880 : 660;

    const osc = this.ctx.createOscillator();
    const oscHarm = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;
    oscHarm.type = 'triangle';
    oscHarm.frequency.value = freq * 2.0;

    const harmGain = this.ctx.createGain();
    harmGain.gain.value = 0.12;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(isUrgent ? 0.16 : 0.09, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (isUrgent ? 0.18 : 0.11));

    osc.connect(gain);
    oscHarm.connect(harmGain);
    harmGain.connect(gain);
    gain.connect(this.dryBus);

    osc.start(now);
    oscHarm.start(now);
    osc.stop(now + 0.2);
    oscHarm.stop(now + 0.2);
  }

  public playCeremonialChime(type: 'start' | 'finish'): void {
    this.ensureReady();
    if (!this.ctx || !this.dryBus || !this.wetBus || this.muted) return;

    const now = this.ctx.currentTime + 0.01;
    const notes = type === 'start' ? [528, 792] : [660, 528, 792];
    notes.forEach((freq, i) => {
      if (!this.ctx || !this.dryBus || !this.wetBus) return;
      const t = now + i * 0.11;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

      osc.connect(g);
      g.connect(this.dryBus);
      g.connect(this.wetBus);
      osc.start(t);
      osc.stop(t + 0.48);
    });
  }
}
