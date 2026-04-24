// Detección de inactividad para auto-pausar el time tracker.
// Estrategia: escucha eventos globales (mouse, teclado, foco, visibilidad).
// Cuando no hay actividad por `idleMs`, dispara `onIdle`. Al volver, dispara `onResume`.

type Cb = () => void;

export interface IdleWatcher {
  stop(): void;
  reset(): void;
}

export function startIdleWatcher(idleMs: number, onIdle: Cb, onResume: Cb): IdleWatcher {
  let lastActive = Date.now();
  let isIdle = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function activity() {
    lastActive = Date.now();
    if (isIdle) {
      isIdle = false;
      onResume();
    }
  }

  function tick() {
    if (!isIdle && Date.now() - lastActive >= idleMs) {
      isIdle = true;
      onIdle();
    }
  }

  const events: (keyof DocumentEventMap | keyof WindowEventMap)[] = [
    "mousemove", "mousedown", "keydown", "wheel", "touchstart",
  ];
  for (const ev of events) {
    window.addEventListener(ev as any, activity, { passive: true });
  }
  // Cuando la ventana se oculta consideramos sólo tiempo, no actividad inmediata.
  window.addEventListener("focus", activity);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") activity();
  });

  timer = setInterval(tick, 1000);

  return {
    stop() {
      if (timer) clearInterval(timer);
      for (const ev of events) window.removeEventListener(ev as any, activity);
      window.removeEventListener("focus", activity);
    },
    reset() { activity(); },
  };
}
