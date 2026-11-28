/**
 * Exit once stdout and stderr have handed everything to the OS.
 *
 * On a pipe (an agent reading `omem import --json`, `omem … | less`) Node writes stdout asynchronously,
 * so a plain process.exit() right after a large write cuts the output at 64 KB. An empty write's callback
 * runs after every earlier write on that stream has been flushed.
 */
export function exitAfterFlush(code = 0, streams = [process.stdout, process.stderr]) {
  process.exitCode = code;
  let pending = streams.length;
  const done = () => { if (--pending <= 0) process.exit(code); };
  if (!pending) { process.exit(code); return; }
  for (const s of streams) {
    try { s.write("", done); } catch { done(); }
  }
}
