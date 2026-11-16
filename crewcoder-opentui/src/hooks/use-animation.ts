// Adapted from termcn's Ink `use-animation` (the OpenTUI spinner's registry entry
// points at the Ink hook). Ink's screen-reader check is removed; reduced motion
// from `use-motion` (NO_MOTION=1 or CI=true) still stops the animation.
import * as React from "react";

import { useMotion } from "./use-motion.js";

type Subscriber = (tick: number) => void;
const pool = new Map<
  number,
  { id: ReturnType<typeof setInterval>; subs: Set<Subscriber>; tick: number }
>();

const subscribe = (milliseconds: number, subscriber: Subscriber) => {
  if (!pool.has(milliseconds)) {
    const entry = {
      id: null as unknown as ReturnType<typeof setInterval>,
      subs: new Set<Subscriber>(),
      tick: 0,
    };

    entry.id = setInterval(() => {
      entry.tick += 1;
      for (const sub of entry.subs) {
        sub(entry.tick);
      }
    }, milliseconds);

    pool.set(milliseconds, entry);
  }

  pool.get(milliseconds)?.subs.add(subscriber);
};

const unsubscribe = (milliseconds: number, subscriber: Subscriber) => {
  const entry = pool.get(milliseconds);
  if (!entry) {
    return;
  }

  entry.subs.delete(subscriber);
  if (entry.subs.size === 0) {
    clearInterval(entry.id);
    pool.delete(milliseconds);
  }
};

export interface UseAnimationOptions {
  intervalMs: number;
  isActive?: boolean;
}

export const useAnimation = (
  rate: number | UseAnimationOptions = 12
): number => {
  const [frame, setFrame] = React.useState(0);
  const { reduced } = useMotion();
  const milliseconds =
    typeof rate === "number" ? Math.round(1000 / rate) : rate.intervalMs;
  const isActive =
    (typeof rate === "number" ? true : (rate.isActive ?? true)) &&
    !reduced;

  React.useEffect(() => {
    if (!isActive) {
      setFrame(0);
      return;
    }

    const callback: Subscriber = (tick) => setFrame(tick);
    subscribe(milliseconds, callback);

    return () => unsubscribe(milliseconds, callback);
  }, [isActive, milliseconds]);

  return frame;
};
