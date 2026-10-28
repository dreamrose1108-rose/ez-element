import { Store, Table, Tables, Tx } from './model';

// Local executable reference adapter. Serial transactions emulate atomic commits;
// real CloudBase lock conflicts still require cloud integration tests.
export class MemoryStore implements Store {
  private docs = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.docs);
      const tx: Tx = {
        hasCoachWork: async (coachId, now) => {
          const sessions = [...draft.entries()].filter(([k]) => k.startsWith('sessions/')).map(([, v]) => v as Tables['sessions']).filter(s => s.coachId === coachId);
          return sessions.some(s => (s.status === 'open' || s.status === 'rest') && s.end > now) || [...draft.entries()].some(([k, v]) => k.startsWith('bookings/') && (v as Tables['bookings']).status === 'confirmed' && sessions.some(s => s.id === (v as Tables['bookings']).sessionId));
        },
        get: async <K extends Table>(table: K, id: string) => structuredClone(draft.get(`${table}/${id}`)) as Tables[K] | undefined,
        put: async <K extends Table>(table: K, value: Tables[K]) => { draft.set(`${table}/${value.id}`, structuredClone(value)); },
      };
      const result = await work(tx);
      this.docs = draft;
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async list<K extends Table>(table: K, filter: Partial<Tables[K]>, limit: number): Promise<Tables[K][]> {
    await this.queue;
    return [...this.docs.entries()].filter(([k]) => k.startsWith(`${table}/`)).map(([, v]) => structuredClone(v) as Tables[K])
      .filter(v => Object.entries(filter).every(([k, value]) => Reflect.get(v, k) === value)).slice(0, limit);
  }
}
