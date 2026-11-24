import type { FeishuIssue } from '../../src/shared/feishu'

export class FeishuError extends Error {
  constructor(
    readonly kind: FeishuIssue['kind'],
    message: string,
    readonly code?: number,
    readonly retryAfter = 0,
  ) {
    super(message)
  }
}
export function issueFrom(error: unknown): FeishuIssue {
  return error instanceof FeishuError
    ? { kind: error.kind, message: error.message }
    : { kind: 'api', message: '飞书连接暂时不可用，请重试。' }
}
