import { dlopen, FFIType } from 'bun:ffi';

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

/** Prevent same-UID model/tool subprocesses from reading runner memory or /proc/<pid>/environ. */
export function makeRunnerProcessNonDumpable(): void {
  const libc = dlopen('libc.so.6', {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      throw new Error('prctl(PR_SET_DUMPABLE) failed');
    }
    if (libc.symbols.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      throw new Error('runner process remains dumpable');
    }
  } finally {
    libc.close();
  }
}
