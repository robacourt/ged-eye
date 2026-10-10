/**
 * The media Function's in-process queue: image jobs run one at a time per isolate (spec "Memory rules"), and a
 * request is refused once too many are waiting, so the client retries and the platform adds isolates.
 */

/** Thrown when too many jobs are already waiting; the handler answers 503 busy. */
export class BusyError extends Error {}

/**
 * One job at a time, so a large image's memory never stacks (spec "Memory rules"). → { run(job) → job's result }
 * `run(job)` queues `job` (a function returning a value or promise) behind the others and returns a promise of its
 * result; a job that throws or rejects doesn't stop the next one. `run` throws BusyError, without queueing the job,
 * when `maxWaiting` jobs are already waiting. The running job doesn't count as waiting.
 */
export function createJobQueue({ maxWaiting = 4 } = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  return {
    run(job) {
      if (waiting >= maxWaiting) throw new BusyError('busy');
      waiting++;
      const result = tail.then(() => { waiting--; return job(); });
      tail = result.catch(() => {});
      return result;
    }
  };
}
