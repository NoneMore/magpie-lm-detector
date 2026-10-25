import { randomUUID } from 'node:crypto';

const MAX_REPEAT = 20;
const MAX_ACTIVE = 2;
const MAX_SAVED = 40;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function intRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 之间的整数。`);
  }
  return value;
}

export function validateJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的检测参数。');
  const model = input.model;
  if (typeof model !== 'string' || model.length > 256 ||
      !/^[^\s\x00-\x1f]+\/[^\s\x00-\x1f]+$/.test(model) ||
      /^(?:group|auto|quality-probe)\//.test(model)) throw new Error('请选择具体的 provider/model，不支持路由组。');
  const api = input.api ?? 'responses';
  if (!['responses', 'chat_completions', 'messages'].includes(api)) throw new Error('不支持的 API 协议。');
  const count = intRange(input.count ?? 3, 1, 3, 'count');
  const parallel = intRange(input.parallel ?? 3, 1, 3, 'parallel');
  const repeat = intRange(input.repeat ?? 1, 1, MAX_REPEAT, 'repeat');
  const timeout = input.timeout ?? 120;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0.1 || timeout > 600) {
    throw new Error('timeout 必须是 0.1–600 秒。');
  }
  const stream = input.stream ?? true;
  const strict = input.strict ?? false;
  if (typeof stream !== 'boolean' || typeof strict !== 'boolean') throw new Error('stream/strict 必须是布尔值。');
  if (strict && count !== 3) throw new Error('严格模式需要每轮三个样本。');
  const effort = input.effort ?? '';
  if (typeof effort !== 'string' || effort.length > 64 || /[\x00-\x1f\x7f]/.test(effort) || effort.trim() !== effort) {
    throw new Error('推理强度不合法。');
  }
  return { model, api, count, parallel: Math.min(parallel, count), repeat, timeout, stream, strict, effort };
}

function publicSample(s, index) {
  // Display-only heuristic; it never changes SDK scoring or acceptance.
  const values = (s.text || '').match(/\b\d+\b/g)?.map(Number).filter(n => n >= 1 && n <= 355) || [];
  return {
    index: index + 1,
    state: s.state,
    count: s.count,
    expectedCount: s.expected_count,
    error: s.error,
    responseModel: s.response_model,
    minimumValidNumber: values.length ? Math.min(...values) : null,
  };
}

function publicRound(round) {
  return {
    round: round.round,
    samples: round.samples.map(publicSample),
    analysis: round.analysis ? {
      ...round.analysis,
      results: round.analysis.results?.slice(0, 20) ?? [],
    } : null,
    error: round.error,
  };
}

export class JobManager {
  #jobs = new Map();
  #detectorLoader;
  #detectorPromise;
  constructor(detectorLoader) { this.#detectorLoader = detectorLoader; }

  async #detector() {
    if (!this.#detectorPromise) {
      this.#detectorPromise = this.#detectorLoader().catch(error => {
        this.#detectorPromise = undefined;
        throw error;
      });
    }
    return this.#detectorPromise;
  }

  async info() {
    const d = await this.#detector();
    return { builtAt: d.builtAt };
  }

  #prune() {
    for (const [id, job] of this.#jobs) {
      if (job.state !== 'running' && Date.now() - job.startedAt > MAX_AGE_MS) this.#jobs.delete(id);
    }
    for (const [id, job] of this.#jobs) {
      if (this.#jobs.size <= MAX_SAVED) break;
      if (job.state !== 'running') this.#jobs.delete(id);
    }
  }

  list() {
    this.#prune();
    return [...this.#jobs.values()].map(job => this.#view(job))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id) {
    const j = this.#jobs.get(id);
    if (!j) throw new Error('任务不存在，可能已过期或插件已重新启动。');
    return this.#view(j);
  }

  #view(j) {
    return {
      jobId: j.id,
      ...j.params,
      state: j.state,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      completed: j.completed,
      round: j.round,
      rounds: j.rounds.map(publicRound),
      error: j.error,
    };
  }

  async start(input, config, models) {
    const params = validateJob(input);
    if (!models.includes(params.model)) throw new Error('所选模型不在 Gateway 当前模型列表中。');
    if ([...this.#jobs.values()].filter(j => j.state === 'running').length >= MAX_ACTIVE) {
      throw new Error('最多同时运行两个检测任务。');
    }
    const id = randomUUID();
    const job = { id, params, state: 'running', startedAt: Date.now(), finishedAt: null,
      completed: 0, round: 0, rounds: [], error: null, controller: new AbortController() };
    this.#jobs.set(id, job);
    this.#prune();
    // Each job holds a private copy of the Gateway credentials; no key enters public state.
    const gateway = { ...config };
    void this.#run(job, gateway);
    return this.#view(job);
  }

  async #run(job, gateway) {
    const { params } = job;
    try {
      const detector = await this.#detector();
      if (job.controller.signal.aborted) return;
      for (let round = 1; round <= params.repeat; round++) {
        if (job.controller.signal.aborted) break;
        job.round = round;
        const result = await detector.detect({
          baseUrl: gateway.url, apiKey: gateway.key, model: params.model,
          api: params.api, stream: params.stream, count: params.count,
          parallel: params.parallel, strict: params.strict, timeout: params.timeout,
          ...(params.effort ? { effort: params.effort } : {}),
        }, job.controller.signal);
        if (job.controller.signal.aborted) break;
        job.completed += result.samples.length;
        job.rounds.push({ round, samples: result.samples, analysis: result.analysis, error: result.error });
      }
      if (!job.controller.signal.aborted) {
        job.state = job.rounds.some(r => r.analysis && ['scored', 'partial'].includes(r.analysis.decision))
          ? 'done' : 'failed';
        if (job.state === 'failed') job.error = job.rounds.at(-1)?.error || '没有可评分的检测结果。';
      }
    } catch (error) {
      if (!job.controller.signal.aborted) {
        job.state = 'failed';
        job.error = String(error?.message || error).slice(0, 400);
      }
    } finally {
      job.finishedAt = Date.now();
      job.controller = null;
      this.#prune();
    }
  }

  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error('任务不存在。');
    if (job.state === 'running') {
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      job.controller.abort();
    }
    return this.#view(job);
  }
}
