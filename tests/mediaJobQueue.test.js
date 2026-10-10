// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { BusyError, createJobQueue } from '../media/jobQueue.js';

/** A promise with its resolve and reject exposed. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A job that logs its start and end, and finishes when its `gate` is resolved or rejected. */
function gatedJob(name, log) {
  const gate = deferred();
  const job = async () => {
    log.push(`start ${name}`);
    try {
      return await gate.promise;
    } finally {
      log.push(`end ${name}`);
    }
  };
  return { gate, job };
}

describe('media/jobQueue', () => {
  it('runs jobs one at a time, in order, and returns each result', async () => {
    const queue = createJobQueue();
    const log = [];
    const a = gatedJob('a', log);
    const b = gatedJob('b', log);
    const c = gatedJob('c', log);
    const results = [queue.run(a.job), queue.run(b.job), queue.run(c.job)];

    await settle();
    expect(log).toEqual(['start a']);
    b.gate.resolve('B'); // b finishing first must not let it start early
    await settle();
    expect(log).toEqual(['start a']);
    a.gate.resolve('A');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c']);
    c.gate.resolve('C');
    await expect(Promise.all(results)).resolves.toEqual(['A', 'B', 'C']);
  });

  it('carries on with the next job after one rejects', async () => {
    const queue = createJobQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const next = queue.run(async () => 'next');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('carries on after a job that throws synchronously', async () => {
    const queue = createJobQueue();
    const failing = queue.run(() => {
      throw new Error('sync');
    });
    await expect(failing).rejects.toThrow('sync');
    await expect(queue.run(() => 'fine')).resolves.toBe('fine');
  });

  it('refuses a job with BusyError, without queueing it, when 4 are already waiting', async () => {
    const queue = createJobQueue();
    const log = [];
    const running = gatedJob('running', log);
    const results = [queue.run(running.job)];
    await settle();
    expect(log).toEqual(['start running']); // the running job isn't waiting

    const waiting = ['w1', 'w2', 'w3', 'w4'].map((name) => gatedJob(name, log));
    for (const { job } of waiting) results.push(queue.run(job));

    let refusedRan = false;
    expect(() => queue.run(() => { refusedRan = true; })).toThrow(BusyError);

    running.gate.resolve('r');
    waiting.forEach(({ gate }, i) => gate.resolve(i));
    await expect(Promise.all(results)).resolves.toEqual(['r', 0, 1, 2, 3]);
    expect(refusedRan).toBe(false);
    await expect(queue.run(async () => 'later')).resolves.toBe('later');
  });

  it('takes a smaller maxWaiting', async () => {
    const queue = createJobQueue({ maxWaiting: 1 });
    const log = [];
    const running = gatedJob('running', log);
    const first = queue.run(running.job);
    await settle();
    const second = queue.run(async () => 'second');
    expect(() => queue.run(async () => 'third')).toThrow(BusyError);
    running.gate.resolve('first');
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('BusyError is an Error', () => {
    expect(new BusyError('busy')).toBeInstanceOf(Error);
  });
});
