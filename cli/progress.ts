/** Show upload activity on an interactive terminal without changing piped output. */
export function uploadProgress(initial: string): { update(label: string): void; stop(): void } {
  if (!process.stderr.isTTY) return { update() {}, stop() {} };

  const started = performance.now();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let label = initial;
  let frame = 0;
  let visible = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const render = () => {
    visible = true;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    process.stderr.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${label} · ${seconds}s`);
  };
  const delay = setTimeout(() => {
    render();
    interval = setInterval(render, 100);
    interval.unref();
  }, 150);
  delay.unref();

  return {
    update(next) {
      label = next;
      if (visible) render();
    },
    stop() {
      clearTimeout(delay);
      if (interval) clearInterval(interval);
      if (visible) process.stderr.write("\r\x1b[2K");
      visible = false;
    },
  };
}
