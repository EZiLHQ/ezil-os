'use strict';

function installBrokenPipeGuards({ stdout = process.stdout, stderr = process.stderr, onBrokenPipe = () => {} } = {}) {
  const disposers = [];
  for (const [stream, label] of new Map([[stdout, 'stdout'], [stderr, 'stderr']])) {
    // Map keys are sinks, so aliases install only one guard.
    const original = stream.write;
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'write');
    let broken = false;
    function closePipe() {
      if (broken) return;
      broken = true;
      try { Promise.resolve(onBrokenPipe(label)).catch(() => {}); } catch {}
    }
    function onError(error) {
      if (error?.code === 'EPIPE') { closePipe(); return; }
      // Adding a listener must not silently consume otherwise unhandled errors.
      if (stream.listenerCount('error') === 1) throw error;
    }
    function write(...args) {
      const callbackIndex = args.length - 1;
      const callback = typeof args[callbackIndex] === 'function' ? args[callbackIndex] : null;
      if (broken) { if (callback) queueMicrotask(() => callback()); return true; }
      if (callback) args[callbackIndex] = error => {
        if (error?.code === 'EPIPE') { closePipe(); callback(); }
        else callback(error);
      };
      try { return original.apply(stream, args); }
      catch (error) {
        if (error?.code !== 'EPIPE') throw error;
        closePipe(); if (callback) queueMicrotask(() => callback()); return true;
      }
    }
    // Run before pre-existing once listeners remove themselves.
    stream.prependListener('error', onError);
    stream.write = write;
    disposers.push(() => {
      stream.removeListener('error', onError);
      if (stream.write === write) {
        if (descriptor) Object.defineProperty(stream, 'write', descriptor);
        else delete stream.write;
      }
    });
  }
  let disposed = false;
  return () => { if (!disposed) { disposed = true; for (const dispose of disposers) dispose(); } };
}

module.exports = { installBrokenPipeGuards };
