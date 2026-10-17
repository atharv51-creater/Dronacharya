// Task history in MongoDB Atlas. Scout keeps running tasks in memory; every status change and settlement
// writes a snapshot (the full task view plus its event log) to the "tasks" collection, so finished tasks
// survive restarts and stay browsable in the console. Writes are coalesced per task and retried; Atlas
// being down never affects a running task.

import { scrubMongoError, type Logger } from "@dron/shared";
import type { Db } from "mongodb";

export interface TaskSnapshot {
  view: { id: string; status: string; request: { task: string; budget: string }; createdAt: string; budget: { spentUsdc: string } } & Record<string, unknown>;
  events: { seq: number; type: string }[];
}

export interface TaskSummary {
  id: string;
  status: string;
  task: string;
  budget: string;
  spentUsdc: string;
  createdAt: string;
}

interface TaskDoc {
  _id: string;
  status: string;
  task: string;
  budget: string;
  spentUsdc: string;
  createdAt: string;
  updatedAt: Date;
  view: TaskSnapshot["view"];
  events: TaskSnapshot["events"];
}

const ACTIVE = new Set(["parsing", "planning", "running"]);
/** A task archived while still active was cut off by a restart: it will never progress again. */
const settledStatus = (status: string) => (ACTIVE.has(status) ? "interrupted" : status);

export class TaskArchive {
  private readonly queue = new Map<string, TaskSnapshot>();
  private timer: NodeJS.Timeout | undefined;
  private failing = false;
  private indexed = false;

  constructor(
    private readonly mongo: () => Promise<Db>,
    private readonly log: Logger,
    private readonly collection = "tasks",
  ) {}

  /** Queues a snapshot; the latest one per task is written shortly after. */
  save(snapshot: TaskSnapshot): void {
    this.queue.set(snapshot.view.id, snapshot);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.failing ? 10_000 : 500);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    if (this.queue.size === 0) return;
    const batch = [...this.queue.values()];
    this.queue.clear();
    try {
      const col = (await this.mongo()).collection<TaskDoc>(this.collection);
      if (!this.indexed) {
        await col.createIndex({ createdAt: -1 });
        this.indexed = true;
      }
      await col.bulkWrite(
        batch.map((s) => ({
          replaceOne: {
            filter: { _id: s.view.id },
            replacement: {
              _id: s.view.id,
              status: s.view.status,
              task: s.view.request.task,
              budget: s.view.request.budget,
              spentUsdc: s.view.budget.spentUsdc,
              createdAt: s.view.createdAt,
              updatedAt: new Date(),
              view: s.view,
              events: s.events,
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      if (this.failing) this.log.info("task archive: MongoDB Atlas reachable again");
      this.failing = false;
    } catch (err) {
      // Keep the newest snapshot of each task and try again later.
      for (const s of batch) if (!this.queue.has(s.view.id)) this.queue.set(s.view.id, s);
      if (!this.failing) this.log.warn("task archive: MongoDB Atlas unavailable; snapshots are kept and retried", { err: scrubMongoError(err) });
      this.failing = true;
      this.timer = setTimeout(() => void this.flush(), 10_000);
      this.timer.unref?.();
    }
  }

  async list(limit = 50): Promise<TaskSummary[]> {
    const col = (await this.mongo()).collection<TaskDoc>(this.collection);
    const docs = await col
      .find({}, { projection: { status: 1, task: 1, budget: 1, spentUsdc: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({ id: d._id, status: settledStatus(d.status), task: d.task, budget: d.budget, spentUsdc: d.spentUsdc, createdAt: d.createdAt }));
  }

  async get(id: string): Promise<TaskSnapshot | null> {
    const doc = await (await this.mongo()).collection<TaskDoc>(this.collection).findOne({ _id: id });
    if (!doc) return null;
    const status = settledStatus(doc.status);
    const view = status === doc.status ? doc.view : { ...doc.view, status, error: doc.view.error ?? "interrupted: the buyer agent restarted while this task was running; payments already made are in the ledger" };
    return { view, events: doc.events };
  }
}
