/**
 * AcousticStoneAudioEngine
 *
 * Sample-accurate physical modeling synthesis for authentic Baduk acoustics:
 * - Slate (오석) & Clamshell (해남석) biconvex disk modal resonances + Hertzian contact pulses
 * - Jujube wood bowl (대추나무 바둑통) cavity resonance + Poisson multi-stone rattle cascades
 * - Kaya wood Goban (비자나무 각반 + 혈 울림통) dual-contact rim-to-belly placement snap ("딱! / 착!")
 * - Adjacent stone micro-collision clinks on close-quarters tactical moves ("붙임 / 끼움")
 * - Shallow wooden lid (바둑통 뚜껑) multi-bounce prisoner drop ("달그락 / 타닥톡")
 * - Intimate traditional wooden room Impulse Response convolution reverb
 */

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

  // Pre-synthesized sample-accurate acoustic variation banks
  private slateClackBuffers: AudioBuffer[] = [];
  private shellClackBuffers: AudioBuffer[] = [];
  private bowlWoodTapBuffers: AudioBuffer[] = [];
  private slideGrainBuffers: AudioBuffer[] = [];
  private boardCenterSnapBuffers: AudioBuffer[] = [];
  private boardEdgeSnapBuffers: AudioBuffer[] = [];
  private lidWoodDropBuffers: AudioBuffer[] = [];

  private lastBowlRattleTime = 0;
  private lastCollisionClinkTime = 0;

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

  /**
   * Builds a warm, short (0.34s) wooden & tatami room Impulse Response
   * with realistic early tabletop/wall reflections and high-frequency air absorption.
   */
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
        // Exponential decay faster for highs, warm wood tail
        const env = Math.exp(-t / 0.068) * 0.55 + Math.exp(-t / 0.14) * 0.18;
        const white = rand() * env * (t < 0.003 ? t / 0.003 : 1);
        // Warm lowpass damping over time
        const alpha = Math.max(0.08, 0.48 - t * 1.1);
        lpState += alpha * (white - lpState);
        data[i] = lpState * 0.45;
      }

      for (const er of earlyReflectionsMs) {
        const idx = Math.floor((er.ms / 1000) * sr);
        if (idx < length - 8) {
          const g = ch === 0 ? er.gainL : er.gainR;
          // Softened 5-sample warm reflection kernel
          data[idx] += g * 0.5;
          data[idx + 1] += g * 0.32;
          data[idx + 2] += g * 0.14;
        }
      }
    }

    return buffer;
  }

  /**
   * Renders a Hertzian elastic contact pulse + damped modal partials into a mono AudioBuffer.
   */
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
      // Hertzian contact force F(t) ~ sin(pi * t / tau)^1.5
      const s = Math.sin((Math.PI * i) / pulseSamples);
      out[i] += contactGain * Math.pow(s, 1.5);
    }

    for (const p of partials) {
      const omega = (2 * Math.PI * p.freq) / sr;
      const phase0 = p.phase ?? 0;
      const decayPerSample = Math.exp(-1 / (p.decaySec * sr));
      let env = p.amp;
      // 0.25ms smooth onset to avoid non-physical DC step click
      const attackSamples = Math.max(3, Math.floor(0.00025 * sr));
      for (let i = 0; i < len; i++) {
        const atk = i < attackSamples ? i / attackSamples : 1;
        out[i] += atk * env * Math.sin(omega * i + phase0);
        env *= decayPerSample;
        if (env < 1e-5) break;
      }
    }

    if (noiseBurstGain > 0) {
      // Resonant bandpass filtered micro-surface texture burst
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

  /**
   * Pre-synthesizes multi-variant acoustic buffers at startup for instant, zero-jitter playback.
   */
  private synthesizeBufferBanks(ctx: AudioContext): void {
    // 1. Nachi Black Slate (오석) stone-on-stone clacks (dense, warm ceramic-mineral click)
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

    // 2. Hyuga Clamshell (해남석/조개돌) stone-on-stone clacks (slightly crisper crystalline CaCO3 sheen)
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

    // 3. Jujube Hardwood Bowl Wall / Cavity Taps (대추나무 바둑통 내부 울림)
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

    // 4. Smooth Mineral Sliding / Settling Grain ("사르륵" 돌 쓸림 마찰음)
    for (let v = 0; v < 4; v++) {
      this.slideGrainBuffers.push(this.buildMineralSlideBuffer(ctx, 0.09 + v * 0.025, 2200 + v * 320));
    }

    // 5. Kaya Goban Center & Edge Dual-Contact Placement Snaps ("딱! / 착!")
    for (let v = 0; v < 6; v++) {
      this.boardCenterSnapBuffers.push(this.buildGobanSnapBuffer(ctx, true, v));
      this.boardEdgeSnapBuffers.push(this.buildGobanSnapBuffer(ctx, false, v));
    }

    // 6. Upside-down Jujube Bowl Lid Impact (사석 바둑통 뚜껑 낙하 울림)
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

  /**
   * Synthesizes the iconic biconvex stone placement on a thick Kaya wood Goban:
   * - Contact 1 (t = 0ms): Stone rim touches the wood surface
   * - Contact 2 (t = 1.6~3.1ms): Biconvex belly snaps flat onto the Kaya slab,
   *   exciting the hollow pyramid cavity (혈) underneath + crisp lacquer surface snap!
   */
  private buildGobanSnapBuffer(ctx: AudioContext, isCenter: boolean, variant: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const duration = 0.22;
    const len = Math.floor(sr * duration);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    const d = 0.965 + variant * 0.014;
    // Rim-to-belly rock-down delay: 1.6ms to 3.0ms gives authentic Baduk snap comb texture!
    const snapDelaySec = 0.0016 + (variant % 4) * 0.00042;
    const snapOffset = Math.floor(snapDelaySec * sr);

    // Pre-contact 1: subtle rim touch
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

    // Main Contact 2: Full stone belly slap + Kaya cavity resonance ("딱!")
    const bodyPartials: ModalPartial[] = isCenter
      ? [
          // Deep Kaya wood block + pyramid cavity air mode
          { freq: 156 * d, amp: 0.46, decaySec: 0.046 },
          { freq: 258 * d, amp: 0.52, decaySec: 0.032, phase: 0.3 },
          { freq: 472 * d, amp: 0.38, decaySec: 0.021, phase: 0.8 },
          { freq: 890 * d, amp: 0.29, decaySec: 0.013, phase: 1.4 },
          { freq: 1760 * d, amp: 0.33, decaySec: 0.0068, phase: 0.6 },
          { freq: 3120 * d, amp: 0.27, decaySec: 0.0039, phase: 1.9 },
          { freq: 5280 * d, amp: 0.14, decaySec: 0.0023, phase: 0.2 },
        ]
      : [
          // Corner/edge stiffer wood impedance near carved legs (brighter, tighter "딱!")
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
      // Smooth bell envelope with micro-grain modulation
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

  /**
   * 1. Bowl Rattle ("바둑통 잘그락거림"):
   * Clustered cascade of stone-on-stone clacks + jujube bowl wood resonance + mineral slide friction.
   */
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

    // Number of colliding stones scales naturally with stir intensity (6 to 15 micro-collisions)
    const count = Math.floor(6 + clampedIntensity * 8);
    let cursor = 0;

    // Underlying subtle mineral slide friction ("사르륵")
    const slideBuf = this.slideGrainBuffers[Math.floor(Math.random() * this.slideGrainBuffers.length)];
    this.scheduleBuffer(slideBuf, now + 0.008, 0.26 * clampedIntensity, 0.92 + Math.random() * 0.18, basePan);

    for (let i = 0; i < count; i++) {
      // Clustered Poisson inter-arrival times: dense burst first, settling tail later
      const progress = i / count;
      const stepSec = (0.005 + Math.random() * 0.022) * (0.7 + progress * 1.45);
      cursor += stepSec;

      const buf = stoneBank[Math.floor(Math.random() * stoneBank.length)];
      const decayEnvelope = Math.pow(1 - progress * 0.72, 1.35);
      const velocity = (0.16 + Math.random() * 0.28) * clampedIntensity * decayEnvelope;
      const rate = 0.91 + Math.random() * 0.2;
      const panJitter = basePan + (Math.random() - 0.5) * 0.14;
      // Deeper buried stones have slightly warmer lowpass filtering
      const lp = 4800 + Math.random() * 6500;

      this.scheduleBuffer(buf, now + cursor, velocity, rate, panJitter, lp);

      // Every ~3rd stone nudges the wooden jujube bowl wall for authentic hollow wooden warmth
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

  /**
   * 2. Stone Pickup ("돌 집어 올리기"):
   * Subtle finger lift + 3~4 neighboring stones settling gently into the gap.
   */
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

  /**
   * 3. Board Stone Placement ("바둑판 착수음 '딱!' / '착!'"):
   * Blends center vs edge Goban resonance based on board position, adds subtle slate/clamshell top transient,
   * and triggers micro-jostle stone clinks when placed adjacent to existing stones on the board!
   */
  public playStonePlace(params: {
    normX: number; // -1 (left) to +1 (right)
    normY: number; // -1 (top) to +1 (bottom)
    force?: number; // 0.6 ~ 1.25
    isBlack: boolean;
    adjacentStones?: number; // 0..4
  }): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted) return;

    const now = this.ctx.currentTime + 0.002;
    const force = Math.max(0.55, Math.min(1.25, params.force ?? 0.92));
    const pan = params.normX * 0.36;

    // Radial distance from Tangen (천원 center): 0 at center, ~1 at corners
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

    // Subtle stone body mineral character on finger release
    const stoneBank = params.isBlack ? this.slateClackBuffers : this.shellClackBuffers;
    const bodyClick = stoneBank[Math.floor(Math.random() * stoneBank.length)];
    this.scheduleBuffer(bodyClick, now + 0.0018, 0.18 * force, rateJitter, pan, 5400);

    // Adjacent stone micro-jostle ("붙임/끼움/단수" 시 옆 돌과 살짝 부딪히는 '톡/찰칵' 소리!)
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

  /**
   * 4. Capture Scoop & Bowl Lid Drop ("사석 수거 및 바둑통 뚜껑 투하"):
   * Models each captured stone landing in the shallow wooden lid with 2~3 micro-bounces
   * and clattering against existing prisoners in the lid.
   */
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

      // Primary drop onto wooden lid (softer wood if many stones already cushion it, more stone clatter!)
      this.scheduleBuffer(
        lidBuf,
        now + baseDelay,
        0.38 * (1 - prisonerDensity * 0.35),
        0.96 + Math.random() * 0.1,
        pan
      );

      // Secondary biconvex stone rock-settle bounce on lid ("타-닥-톡")
      this.scheduleBuffer(
        lidBuf,
        now + baseDelay + 0.032 + Math.random() * 0.012,
        0.13,
        1.08 + Math.random() * 0.08,
        pan,
        4200
      );

      // Stone-on-stone clink against existing captured prisoners in the lid
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

  /**
   * 5. Byoyomi Clock Countdown Chime (초읽기 알림음)
   */
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

  /**
   * Physics-coupled adjacent stone collision clink sound scaled by impulse energy.
   */
  public playStoneCollisionClink(impulse: number, isBlack: boolean, pan = 0): void {
    this.ensureReady();
    if (!this.ctx || !this.initialized || this.muted) return;

    const now = this.ctx.currentTime;
    if (now - this.lastCollisionClinkTime < 0.032) return;
    this.lastCollisionClinkTime = now;

    const bank = isBlack ? this.slateClackBuffers : this.shellClackBuffers;
    if (bank.length === 0) return;

    const buf = bank[Math.floor(Math.random() * bank.length)];
    const gain = Math.max(0.06, Math.min(0.45, 0.09 + impulse * 0.34));
    const rate = 0.94 + Math.random() * 0.16;
    const lp = 4400 + impulse * 5800;
    this.scheduleBuffer(buf, now + 0.002, gain, rate, Math.max(-0.8, Math.min(0.8, pan)), lp);
  }

  /**
   * Ascending ceremonial harmonic chime on Omok 5-in-a-row or game victory.
   */
  public playWinCelebrationChime(): void {
    this.ensureReady();
    if (!this.ctx || !this.dryBus || !this.wetBus || this.muted) return;

    const now = this.ctx.currentTime + 0.015;
    const chord = [523.25, 659.25, 783.99, 1046.5];
    chord.forEach((freq, idx) => {
      if (!this.ctx || !this.dryBus || !this.wetBus) return;
      const t = now + idx * 0.085;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      osc.connect(g);
      g.connect(this.dryBus);
      g.connect(this.wetBus);
      osc.start(t);
      osc.stop(t + 0.68);
    });
  }

  /**
   * Subtle ceremonial wooden clapper/bell sound on game start or result
   */
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
