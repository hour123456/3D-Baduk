import { BLACK, WHITE, PlayerColor } from './types';

export interface PlayerClockState {
  mainTimeLeft: number; // seconds (float)
  byoyomiPeriodsLeft: number;
  byoyomiTimeLeft: number; // seconds (float)
  inByoyomi: boolean;
}

export interface ClockSnapshot {
  black: PlayerClockState;
  white: PlayerClockState;
}

export interface ClockCallbacks {
  onTick: (state: { black: PlayerClockState; white: PlayerClockState; activeColor: PlayerColor | null }) => void;
  onByoyomiWarning: (color: PlayerColor, secondsRemaining: number) => void;
  onTimeout: (color: PlayerColor) => void;
}

export class GameClock {
  private unlimited = true;
  private byoyomiDuration = 30;
  private initialPeriods = 3;

  public black: PlayerClockState;
  public white: PlayerClockState;
  private activeColor: PlayerColor | null = null;
  private timerId: number | null = null;
  private lastTimestamp = 0;
  private lastAnnouncedSecond: { [K in PlayerColor]: number } = { 1: -1, 2: -1 };
  private callbacks: ClockCallbacks;

  constructor(callbacks: ClockCallbacks) {
    this.callbacks = callbacks;
    this.black = this.makeInitialState(0, 30, 3);
    this.white = this.makeInitialState(0, 30, 3);
  }

  private makeInitialState(mainSeconds: number, byoyomiSeconds: number, periods: number): PlayerClockState {
    const inByoyomi = mainSeconds <= 0 && periods > 0;
    return {
      mainTimeLeft: Math.max(0, mainSeconds),
      byoyomiPeriodsLeft: periods,
      byoyomiTimeLeft: byoyomiSeconds,
      inByoyomi,
    };
  }

  public configure(mainSeconds: number, byoyomiSeconds: number, periods: number): void {
    this.stop();
    this.unlimited = mainSeconds <= 0 && periods <= 0;
    this.byoyomiDuration = Math.max(5, byoyomiSeconds);
    this.initialPeriods = Math.max(0, periods);
    this.black = this.makeInitialState(mainSeconds, this.byoyomiDuration, this.initialPeriods);
    this.white = this.makeInitialState(mainSeconds, this.byoyomiDuration, this.initialPeriods);
    this.lastAnnouncedSecond = { 1: -1, 2: -1 };
    this.emitTick();
  }

  public isUnlimited(): boolean {
    return this.unlimited;
  }

  public startTurn(color: PlayerColor): void {
    if (this.unlimited) {
      this.activeColor = color;
      this.emitTick();
      return;
    }

    // Reset current byoyomi period timer when turn switches or begins if in byoyomi
    const st = color === BLACK ? this.black : this.white;
    if (st.inByoyomi) {
      st.byoyomiTimeLeft = this.byoyomiDuration;
    }
    this.lastAnnouncedSecond[color] = -1;
    this.activeColor = color;
    this.lastTimestamp = performance.now();

    if (this.timerId === null) {
      this.timerId = window.setInterval(() => this.step(), 100);
    }
    this.emitTick();
  }

  public pause(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.activeColor = null;
    this.emitTick();
  }

  public stop(): void {
    this.pause();
  }

  public getSnapshot(): ClockSnapshot {
    return {
      black: { ...this.black },
      white: { ...this.white },
    };
  }

  public applySnapshot(snapshot: ClockSnapshot, nextActiveColor?: PlayerColor | null): void {
    this.black = { ...snapshot.black };
    this.white = { ...snapshot.white };
    if (nextActiveColor !== undefined) {
      if (nextActiveColor === null) {
        this.pause();
      } else {
        this.startTurn(nextActiveColor);
      }
    } else {
      this.emitTick();
    }
  }

  private step(): void {
    if (!this.activeColor || this.unlimited) return;
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTimestamp) / 1000);
    this.lastTimestamp = now;

    const color = this.activeColor;
    const st = color === BLACK ? this.black : this.white;

    if (!st.inByoyomi) {
      st.mainTimeLeft -= dt;
      if (st.mainTimeLeft <= 0) {
        const overflow = -st.mainTimeLeft;
        st.mainTimeLeft = 0;
        if (st.byoyomiPeriodsLeft > 0) {
          st.inByoyomi = true;
          st.byoyomiTimeLeft = Math.max(0.1, this.byoyomiDuration - overflow);
        } else {
          this.stop();
          this.callbacks.onTimeout(color);
          return;
        }
      }
    } else {
      st.byoyomiTimeLeft -= dt;
      const ceilSec = Math.ceil(st.byoyomiTimeLeft);
      if (ceilSec >= 1 && ceilSec <= 10 && this.lastAnnouncedSecond[color] !== ceilSec) {
        this.lastAnnouncedSecond[color] = ceilSec;
        this.callbacks.onByoyomiWarning(color, ceilSec);
      }

      if (st.byoyomiTimeLeft <= 0) {
        st.byoyomiPeriodsLeft -= 1;
        if (st.byoyomiPeriodsLeft <= 0) {
          st.byoyomiTimeLeft = 0;
          this.stop();
          this.callbacks.onTimeout(color);
          return;
        } else {
          st.byoyomiTimeLeft = this.byoyomiDuration;
          this.lastAnnouncedSecond[color] = -1;
        }
      }
    }

    this.emitTick();
  }

  private emitTick(): void {
    this.callbacks.onTick({
      black: { ...this.black },
      white: { ...this.white },
      activeColor: this.activeColor,
    });
  }

  public formatClockText(color: PlayerColor): string {
    if (this.unlimited) return '무제한';
    const st = color === BLACK ? this.black : this.white;
    if (!st.inByoyomi) {
      const totalSec = Math.ceil(st.mainTimeLeft);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    const sec = Math.ceil(st.byoyomiTimeLeft);
    return `초읽기 ${sec}초 (${st.byoyomiPeriodsLeft}회)`;
  }
}
