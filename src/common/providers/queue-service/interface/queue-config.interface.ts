import { JobsOptions, Job, WorkerOptions } from 'bullmq';

export interface QueueConfig {
  /** Unique queue name */
  name: string;
  /** Default job options for this queue */
  defaultJobOptions?: JobsOptions;
}


export type JobProcessor<T = any> = (job: Job<T>) => Promise<any>;


export type WorkerEventHandler = (job: any, ...args: any[]) => void | Promise<void>;


export interface WorkerConfig<T = any> {
  /** Queue name to process */
  queueName: string;
  /** Processor function to handle jobs */
  processor: JobProcessor<T>;
  /** Number of concurrent jobs to process */
  concurrency?: number;
  /** Event handlers */
  onFailed?: WorkerEventHandler;
  onCompleted?: WorkerEventHandler;
  onActive?: WorkerEventHandler;
  /** Additional worker options - uses BullMQ's WorkerOptions type */
  workerOptions?: Omit<WorkerOptions, 'connection' | 'concurrency'>;
}

