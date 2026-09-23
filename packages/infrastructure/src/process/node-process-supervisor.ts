// NodeProcessSupervisor — SECURITY_MODEL §9, P1.5-PS1.
//
// Node.js implementation of the ProcessSupervisor contract. Enforces SE-007 (timeout),
// SE-008 (kill whole process tree), and TG-010 (timed-out => timedOut=true result).
//
// Platform strategy:
//   Windows:  `taskkill /F /T /PID <pid>` kills the entire process tree.
//   Unix/WSL: kill(-pgid, SIGTERM) -> wait gracePeriodMs -> kill(-pgid, SIGKILL).
//             Child is spawned with detached:true so pgid == pid.
//
// Security rules (SECURITY_MODEL §9):
//   - shell: false always (args is an array, never a shell string).
//   - env is REPLACED entirely by caller-supplied SafeEnv (no secret inheritance).
//   - cwd is caller-supplied (caller must validate inside workspace root).
//   - timeoutMs is mandatory -- no process runs forever (SE-007).
import { spawn as nodeSpawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ProcessSupervisor, SpawnOptions, SpawnResult } from '@codeforge/agent-core';
import { SpawnError } from '@codeforge/agent-core';

const DEFAULT_GRACE_MS = 3_000;
const IS_WINDOWS = process.platform === 'win32';

/**
 * Kill the process tree rooted at `pid`.
 * Windows: spawns taskkill (recursive, force).
 * Unix:    kill(-pgid, signal) where pgid == pid (detached spawn).
 */
function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (IS_WINDOWS) {
      nodeSpawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process may already be dead; swallow.
  }
}

export class NodeProcessSupervisor implements ProcessSupervisor {
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const {
      command,
      args,
      cwd,
      env = {},
      timeoutMs,
      gracePeriodMs = DEFAULT_GRACE_MS,
    } = options;

    const t0 = performance.now();
    let timedOut = false;
    const killed = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return new Promise<SpawnResult>((resolve, reject) => {
      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = nodeSpawn(command, [...args], {
          cwd,
          // Replace env entirely -- no inherited secrets (SE-004/SE-008).
          env: env as Record<string, string>,
          shell: false, // SECURITY_MODEL §9.4: never shell:true
          // detached creates a new process group on Unix (pgid = pid).
          detached: !IS_WINDOWS,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code: SpawnError['code'] =
          msg.includes('ENOENT') || msg.includes('not found')
            ? 'COMMAND_NOT_FOUND'
            : msg.includes('EACCES') || msg.includes('permission')
              ? 'PERMISSION_DENIED'
              : 'SPAWN_FAILED';
        reject(new SpawnError(code, msg));
        return;
      }

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // SE-007: hard timeout -- SIGTERM, then SIGKILL after grace period.
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killTree(child.pid, 'SIGTERM');
          setTimeout(() => {
            if (child.pid !== undefined) killTree(child.pid, 'SIGKILL');
          }, gracePeriodMs);
        }
      }, timeoutMs);

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeoutHandle);
        const code: SpawnError['code'] =
          err.code === 'ENOENT'
            ? 'COMMAND_NOT_FOUND'
            : err.code === 'EACCES'
              ? 'PERMISSION_DENIED'
              : 'SPAWN_FAILED';
        reject(new SpawnError(code, err.message));
      });

      child.on('close', (exitCode: number | null) => {
        clearTimeout(timeoutHandle);
        resolve({
          // SE-007/TG-010: when timed out, exitCode is semantically null — the process
          // did not exit naturally. On Windows taskkill produces exitCode=1; we
          // normalize that to null to give callers a consistent cross-platform signal.
          exitCode: timedOut ? null : exitCode,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          killed,
          durationMs: Math.round(performance.now() - t0),
        });
      });
    });
  }
}
