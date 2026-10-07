import { randomUUID } from "node:crypto";
import type { ActivityItem, ActivityType, ErrorCode } from "../../shared/models";
import type { ActivityRepository } from "../repositories/activity-repository";
import { SnapshotEvents } from "./snapshot-events";

/** Keep activity useful without persisting signed query strings or credentials. */
export function safeActivityTitle(title: string): string {
  return title
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.hostname}${url.pathname}`;
      } catch {
        return "";
      }
    })
    .replace(/[\p{Cc}]/gu, " ")
    .slice(0, 300);
}
export class ActivityService {
  readonly events = new SnapshotEvents(() => this.list());
  constructor(private readonly repository: ActivityRepository) {}
  list(): ActivityItem[] {
    return this.repository.list();
  }
  add(
    type: ActivityType,
    title: string,
    references: { downloadId?: string; mediaId?: string; error?: ErrorCode } = {},
  ): void {
    this.repository.add({
      id: randomUUID(),
      type,
      title: safeActivityTitle(title),
      createdAt: Date.now(),
      ...references,
    });
    this.events.notify();
  }
  dispose(): void {
    this.events.dispose();
  }
}
