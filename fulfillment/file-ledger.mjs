import fs from 'node:fs/promises';
import path from 'node:path';

const emptyState = () => ({ schema: 2, events: {}, sessions: {}, paymentIntents: {}, adversePaymentIntents: {} });

export class FileLedger {
  #file;
  #queue = Promise.resolve();
  constructor(file) { this.#file = path.resolve(file); }
  async #readUnsafe() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      if (!parsed || ![1, 2].includes(parsed.schema) || !parsed.events || !parsed.sessions || !parsed.paymentIntents) throw new Error('Fulfillment ledger schema is invalid.');
      if (parsed.schema === 1) return { ...parsed, schema: 2, adversePaymentIntents: {} };
      if (!parsed.adversePaymentIntents) throw new Error('Fulfillment ledger adverse-event state is invalid.');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }
  async read() { return structuredClone(await this.#readUnsafe()); }
  async transact(mutator) {
    let result;
    const operation = this.#queue.then(async () => {
      const draft = await this.#readUnsafe();
      result = await mutator(draft);
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.#file);
    });
    this.#queue = operation.catch(() => {});
    await operation;
    return result;
  }
  async claim(sessionId) {
    if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) return null;
    const state = await this.#readUnsafe();
    const session = state.sessions[sessionId];
    return session?.status === 'fulfilled' ? session.license : null;
  }
}
